'use strict';

(function initAntigravityContextMonitor() {
    if (typeof process === 'undefined' || process.type !== 'browser') return;
    if (global.__agContextMonitorInstalled) return;
    global.__agContextMonitorInstalled = true;

    const http = require('http');
    const https = require('https');
    const { app, ipcMain, BrowserWindow, webContents } = require('electron');
    const languageServer = require('./languageServer');
    let hubUtils = null;
    try {
        hubUtils = require('./utils');
    } catch {}

    const RPC_SERVICE = '/exa.language_server_pb.LanguageServerService/';
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SETTLED_STATUS_RE = /IDLE|WAITING_FOR_USER|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/i;
    const RUNNING_STATUS_RE = /RUNNING|BUSY|IN_PROGRESS/i;
    const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

    const portProtocols = new Map();
    const sessionCache = new Map();
    const inflightRequests = new Map();
    let summariesCache = { endpointKey: '', pending: null };
    let modelCatalogCache = { endpointKey: '', map: new Map(), quotaEntries: [], fetchedAt: 0, pending: null };
    let quotaSummaryCache = { endpointKey: '', groups: [], fetchedAt: 0, pending: null };

    // -------------------------------------------------------------------------
    // 1. 轻量级流式 JSON 白名单投影器（避免长对话大包占用内存）
    // -------------------------------------------------------------------------

    const SCALAR = 'scalar';
    const DURATION = Symbol('duration');
    const DURATION_OBJECT_SCHEMA = { seconds: SCALAR, nanos: SCALAR };
    const DROP = Symbol('drop');
    const SUMMARY_ENTRY = Symbol('summaryEntry');

    const TOKEN_GROUP_SCHEMA = {
        name: SCALAR,
        numTokens: SCALAR,
        children: {
            '*': {
                name: SCALAR,
                numTokens: SCALAR,
            },
        },
    };
    const TOP_LEVEL_TOKEN_GROUP_SCHEMA = {
        name: SCALAR,
        type: SCALAR,
        source: SCALAR,
        numTokens: SCALAR,
        children: { '*': TOKEN_GROUP_SCHEMA },
    };

    const SUMMARY_SCHEMA = {
        stepCount: SCALAR,
        lastModifiedTime: SCALAR,
        status: SCALAR,
        lastUserInputStepIndex: SCALAR,
    };
    const GENERATOR_SCHEMA = {
        chatModel: {
            model: SCALAR,
            modelDisplayName: SCALAR,
            responseModel: SCALAR,
            timeToFirstToken: DURATION,
            streamingDuration: DURATION,
            usage: {
                apiProvider: SCALAR,
                inputTokens: SCALAR,
                outputTokens: SCALAR,
                responseOutputTokens: SCALAR,
                thinkingOutputTokens: SCALAR,
                cacheReadTokens: SCALAR,
                cacheWriteTokens: SCALAR,
            },
            chatStartMetadata: {
                createdAt: SCALAR,
                startStepIndex: SCALAR,
                checkpointIndex: SCALAR,
                contextWindowMetadata: {
                    estimatedTokensUsed: SCALAR,
                    maxContextTokens: SCALAR,
                    tokenBreakdown: {
                        totalTokens: SCALAR,
                        groups: { '*': TOP_LEVEL_TOKEN_GROUP_SCHEMA },
                    },
                },
            },
        },
    };
    const CLIENT_MODEL_CONFIG_SCHEMA = {
        label: SCALAR,
        modelId: SCALAR,
        modelOrAlias: {
            model: SCALAR,
            alias: SCALAR,
        },
        quotaInfo: {
            remainingFraction: SCALAR,
            resetTime: SCALAR,
        },
    };
    const MODEL_CONFIG_DATA_SCHEMA = {
        clientModelConfigs: { '*': CLIENT_MODEL_CONFIG_SCHEMA },
    };
    const QUOTA_BUCKET_SCHEMA = {
        bucketId: SCALAR,
        displayName: SCALAR,
        description: SCALAR,
        window: SCALAR,
        remainingFraction: SCALAR,
        resetTime: SCALAR,
        disabled: SCALAR,
    };
    const QUOTA_GROUP_SCHEMA = {
        displayName: SCALAR,
        description: SCALAR,
        buckets: { '*': QUOTA_BUCKET_SCHEMA },
    };
    const SUMMARIES_MAP_SCHEMA = { [SUMMARY_ENTRY]: SUMMARY_SCHEMA };
    const GENERATORS_ARRAY_SCHEMA = { '*': GENERATOR_SCHEMA };
    const RPC_PROJECTION_SCHEMA = {
        trajectorySummaries: SUMMARIES_MAP_SCHEMA,
        generatorMetadata: GENERATORS_ARRAY_SCHEMA,
        generatorMetadatas: GENERATORS_ARRAY_SCHEMA,
        userStatus: { cascadeModelConfigData: MODEL_CONFIG_DATA_SCHEMA },
        cascadeModelConfigData: MODEL_CONFIG_DATA_SCHEMA,
        response: {
            description: SCALAR,
            groups: { '*': QUOTA_GROUP_SCHEMA },
        },
    };

    const STREAM_MAX_BYTES = 4 * 1024 * 1024;
    const STREAM_MAX_DEPTH = 64;
    const JSON_ESCAPE_CHARS = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    const JSON_NUMBER_RE = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

    /** 创建按白名单裁剪字段的流式 JSON 解析器，防止长对话 RPC 响应占满内存 */
    function createRpcJsonFilter(rootSchema = RPC_PROJECTION_SCHEMA, maxBytes = STREAM_MAX_BYTES) {
        const frames = [];
        let activeToken = null;
        let rootValue;
        let completed = false;
        let retainedBytes = 0;

        const raise = (msg) => {
            throw new Error(msg || 'Language server 返回了无效 JSON');
        };

        const addCost = (bytes) => {
            retainedBytes += bytes;
            if (retainedBytes > maxBytes) raise('RPC 响应投影体积超出内存上限');
        };

        const topFrame = () => frames[frames.length - 1];

        const resolveSlotSchema = () => {
            const top = topFrame();
            if (!top) return rootSchema;
            if (top.schema === SUMMARIES_MAP_SCHEMA) {
                return !top.isArray && UUID_RE.test(top.field || '') ? top.schema[SUMMARY_ENTRY] : undefined;
            }
            const lookupKey = top.isArray ? '*' : top.field;
            return top.schema && typeof top.schema === 'object' && Object.prototype.hasOwnProperty.call(top.schema, lookupKey)
                ? top.schema[lookupKey]
                : undefined;
        };

        const canReadValue = () => {
            const top = topFrame();
            return top ? (top.stage === 'value' || top.stage === 'valueOrEnd') : !completed;
        };

        const commitValue = (val) => {
            const top = topFrame();
            if (!top) {
                if (completed) raise();
                rootValue = val;
                completed = true;
                return;
            }
            if (top.stage !== 'value' && top.stage !== 'valueOrEnd') raise();
            if (val !== DROP && top.target) {
                addCost(32 + (top.schema === SUMMARIES_MAP_SCHEMA ? top.field.length * 2 : 0));
                if (top.isArray) {
                    top.target.push(val);
                } else {
                    Object.defineProperty(top.target, top.field, {
                        value: val,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
                }
            }
            top.stage = 'commaOrEnd';
            top.field = null;
        };

        const appendStringChunk = (text) => {
            const tk = activeToken;
            if (!tk.isKey && tk.schema !== SCALAR && tk.schema !== DURATION) return;
            if (tk.truncated) return;
            tk.buf += text;
            const cap = tk.isKey ? 1024 : 4096;
            if (tk.buf.length > cap) {
                tk.buf = tk.isKey ? '' : tk.buf.slice(0, cap);
                tk.truncated = true;
            }
        };

        const closeString = () => {
            const tk = activeToken;
            activeToken = null;
            if (tk.isKey) {
                const top = topFrame();
                top.field = tk.truncated
                    ? null
                    : (top.schema === SUMMARIES_MAP_SCHEMA && UUID_RE.test(tk.buf) ? tk.buf.toLowerCase() : tk.buf);
                top.stage = 'colon';
                return;
            }
            let out = DROP;
            if (tk.schema === SCALAR || tk.schema === DURATION) {
                out = tk.buf;
                addCost(out.length * 2);
            }
            commitValue(out);
        };

        const closePrimitive = () => {
            const tk = activeToken;
            activeToken = null;
            if (!JSON_NUMBER_RE.test(tk.buf)) raise();
            const parsed = JSON.parse(tk.buf);
            commitValue(tk.schema === SCALAR || tk.schema === DURATION ? parsed : DROP);
        };

        const onDelimiter = (ch) => {
            const top = topFrame();
            if (ch === '{' || ch === '[') {
                if (!canReadValue() || frames.length >= STREAM_MAX_DEPTH) raise();
                const isArray = ch === '[';
                const raw = resolveSlotSchema();
                const schema = !isArray && raw === DURATION ? DURATION_OBJECT_SCHEMA : raw;
                const keep = typeof schema === 'object' && schema !== null && (!isArray || schema !== SUMMARIES_MAP_SCHEMA);
                const target = keep ? (isArray ? [] : {}) : null;
                if (target) addCost(64);
                frames.push({
                    schema,
                    isArray,
                    target,
                    field: null,
                    stage: isArray ? 'valueOrEnd' : 'keyOrEnd',
                });
                return;
            }
            if (ch === '}' || ch === ']') {
                const emptyStage = top && (top.isArray ? 'valueOrEnd' : 'keyOrEnd');
                if (!top || top.isArray !== (ch === ']') || (top.stage !== 'commaOrEnd' && top.stage !== emptyStage)) {
                    raise();
                }
                frames.pop();
                commitValue(top.target || DROP);
                return;
            }
            if (ch === ':') {
                if (!top || top.isArray || top.stage !== 'colon') raise();
                top.stage = 'value';
                return;
            }
            if (ch === ',') {
                if (!top || top.stage !== 'commaOrEnd') raise();
                top.stage = top.isArray ? 'value' : 'key';
                return;
            }
            raise();
        };

        return {
            write(chunk) {
                let pos = 0;
                while (pos < chunk.length) {
                    const tk = activeToken;
                    if (tk && tk.kind === 'str') {
                        if (tk.esc === 1) {
                            const ch = chunk[pos++];
                            if (ch === 'u') { tk.esc = 2; tk.hex = ''; continue; }
                            const mapped = JSON_ESCAPE_CHARS[ch];
                            if (mapped === undefined) raise();
                            appendStringChunk(mapped);
                            tk.esc = 0;
                            continue;
                        }
                        if (tk.esc === 2) {
                            const ch = chunk[pos++];
                            if (!/[0-9a-f]/i.test(ch)) raise();
                            tk.hex += ch;
                            if (tk.hex.length === 4) {
                                appendStringChunk(String.fromCharCode(parseInt(tk.hex, 16)));
                                tk.esc = 0;
                            }
                            continue;
                        }
                        const scan = /["\\\x00-\x1f]/g;
                        scan.lastIndex = pos;
                        const hit = scan.exec(chunk);
                        const segEnd = hit ? hit.index : chunk.length;
                        appendStringChunk(chunk.slice(pos, segEnd));
                        pos = segEnd;
                        if (!hit) continue;
                        const ctrl = chunk[pos++];
                        if (ctrl === '"') closeString();
                        else if (ctrl === '\\') tk.esc = 1;
                        else raise();
                        continue;
                    }
                    if (tk && tk.kind === 'prim') {
                        const start = pos;
                        while (pos < chunk.length && /[a-zA-Z0-9+\-.]/.test(chunk[pos])) pos++;
                        tk.buf += chunk.slice(start, pos);
                        if (tk.buf.length > 1024) raise();
                        if (pos < chunk.length) closePrimitive();
                        continue;
                    }
                    const ch = chunk[pos++];
                    if (ch === ' ' || ch === '\r' || ch === '\n' || ch === '\t') continue;
                    if (ch === '"') {
                        const top = topFrame();
                        const isKey = Boolean(top && !top.isArray && (top.stage === 'key' || top.stage === 'keyOrEnd'));
                        if (!isKey && !canReadValue()) raise();
                        activeToken = {
                            kind: 'str',
                            isKey,
                            schema: isKey ? null : resolveSlotSchema(),
                            buf: '',
                            truncated: false,
                            esc: 0,
                            hex: '',
                        };
                        continue;
                    }
                    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
                        onDelimiter(ch);
                        continue;
                    }
                    if (!canReadValue() || !/[tfn\d-]/.test(ch)) raise();
                    activeToken = { kind: 'prim', schema: resolveSlotSchema(), buf: ch };
                }
            },
            finish() {
                if (activeToken && activeToken.kind === 'prim') closePrimitive();
                if (activeToken || frames.length || !completed || !rootValue || typeof rootValue !== 'object') {
                    raise();
                }
                return rootValue;
            },
        };
    }

    // -------------------------------------------------------------------------
    // 2. 本地 Language Server 发现与 ConnectRPC 调用
    // -------------------------------------------------------------------------

    function getLsEndpoint() {
        const port = typeof languageServer.getLsPort === 'function' ? Number(languageServer.getLsPort()) : 0;
        let csrf = '';
        if (typeof languageServer.getLsCsrfToken === 'function') {
            try {
                csrf = String(languageServer.getLsCsrfToken() || '');
            } catch {}
        }
        if (!csrf) {
            const proc = typeof languageServer.getLsProcess === 'function' ? languageServer.getLsProcess() : null;
            const args = Array.isArray(proc && proc.spawnargs) ? proc.spawnargs : [];
            for (let i = 0; i < args.length; i++) {
                const arg = String(args[i] || '');
                if (arg === '--csrf_token' && i + 1 < args.length) {
                    csrf = String(args[i + 1] || '');
                    break;
                }
                if (arg.startsWith('--csrf_token=')) {
                    csrf = arg.slice('--csrf_token='.length);
                    break;
                }
            }
        }
        if (!Number.isInteger(port) || port <= 0 || port > 65535 || !csrf) return null;
        return { port, csrf, key: `${port}:${csrf}` };
    }

    function sendRpcOnce(protocol, port, csrf, method, payloadText) {
        return new Promise((resolve, reject) => {
            const mod = protocol === 'https' ? https : http;
            const req = mod.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: RPC_SERVICE + method,
                    method: 'POST',
                    agent: false,
                    ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
                    headers: {
                        'Content-Type': 'application/json',
                        'Connect-Protocol-Version': '1',
                        'x-codeium-csrf-token': csrf,
                        'Content-Length': Buffer.byteLength(payloadText),
                    },
                },
                (res) => {
                    const streamFilter = createRpcJsonFilter();
                    let settled = false;
                    const fail = (err) => {
                        if (settled) return;
                        settled = true;
                        reject(err);
                        res.destroy();
                        req.destroy();
                    };
                    res.setEncoding('utf8');
                    res.on('error', fail);
                    res.on('data', (chunk) => {
                        if (settled) return;
                        if (res.statusCode !== 200) return;
                        try {
                            streamFilter.write(chunk);
                        } catch (err) {
                            fail(err);
                        }
                    });
                    res.on('end', () => {
                        if (settled) return;
                        settled = true;
                        if (res.statusCode !== 200) {
                            reject(Object.assign(new Error(`RPC ${method} HTTP ${res.statusCode}`), { status: res.statusCode }));
                            return;
                        }
                        try {
                            resolve(streamFilter.finish());
                        } catch (err) {
                            reject(err);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error(`RPC ${method} timeout`)));
            req.end(payloadText);
        });
    }

    async function callLsRpc(endpoint, method, body) {
        const payloadText = JSON.stringify(body || {});
        const preferred = portProtocols.get(endpoint.port) || 'https';
        const order = preferred === 'https' ? ['https', 'http'] : ['http', 'https'];
        let lastErr = null;
        for (const protocol of order) {
            try {
                const result = await sendRpcOnce(protocol, endpoint.port, endpoint.csrf, method, payloadText);
                portProtocols.set(endpoint.port, protocol);
                if (portProtocols.size > 16) portProtocols.delete(portProtocols.keys().next().value);
                return result;
            } catch (err) {
                lastErr = err;
                // HTTP 4xx/5xx 说明协议层已通，无需再换协议重试
                if (err && typeof err.status === 'number') throw err;
            }
        }
        throw lastErr || new Error('Language server RPC failed');
    }

    // -------------------------------------------------------------------------
    // 3. 上下文占用计算与增量分页读取
    // -------------------------------------------------------------------------

    function parseNonNegInt(value) {
        if (typeof value === 'number') {
            return Number.isSafeInteger(value) && value >= 0 ? value : null;
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            const n = Number(value);
            return Number.isSafeInteger(n) && n >= 0 ? n : null;
        }
        return null;
    }

    const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
    const QUOTA_SUMMARY_TTL_MS = 60 * 1000;
    const QUOTA_FORCE_COOLDOWN_MS = 5 * 1000;
    const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
    const EFFORT_SUFFIX_RE = /^(.+?)[-_ ](thinking|xhigh|high|medium|low)$/i;
    const UPPER_ACRONYMS = new Map([
        ['gpt', 'GPT'],
        ['oss', 'OSS'],
        ['api', 'API'],
        ['oai', 'OpenAI'],
        ['openai', 'OpenAI'],
    ]);

    function cleanModelText(raw) {
        const str = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
        if (typeof str !== 'string') return '';
        return str.replace(CONTROL_CHARS_RE, '').trim().slice(0, 160);
    }

    /** 将底层枚举或连字符模型 ID 转为可读名称，不预设特定内部型号映射 */
    function formatFallbackModelLabel(rawName) {
        if (!rawName) return null;
        if (/\s/.test(rawName) && !/^MODEL_/i.test(rawName)) {
            return rawName;
        }
        let body = rawName.replace(/^models?\//i, '').replace(/^MODEL_/i, '');
        if (/^[a-z0-9._-]+$/i.test(body)) {
            body = body.replace(/-\d{8}$/, '');
            let effort = '';
            const effortMatch = body.match(EFFORT_SUFFIX_RE);
            if (effortMatch) {
                body = effortMatch[1];
                const tag = effortMatch[2].toLowerCase();
                effort = ` (${tag === 'xhigh' ? 'XHigh' : tag[0].toUpperCase() + tag.slice(1)})`;
            }
            const formatted = body
                .replace(/(\d)[_-](\d)/g, '$1.$2')
                .split(/[-_]+/)
                .filter(Boolean)
                .map((part) => {
                    const low = part.toLowerCase();
                    if (UPPER_ACRONYMS.has(low)) return UPPER_ACRONYMS.get(low);
                    if (/^\d/.test(part)) return part;
                    return part[0].toUpperCase() + part.slice(1).toLowerCase();
                })
                .join(' ');
            if (formatted) return formatted + effort;
        }
        return rawName;
    }

    /** 从官方 Language Server GetUserStatus 动态获取客户端当前可用模型显示名称映射与额度信息 */
    async function getModelCatalog(endpoint, force = false) {
        if (modelCatalogCache.endpointKey !== endpoint.key) {
            modelCatalogCache = { endpointKey: endpoint.key, map: new Map(), quotaEntries: [], fetchedAt: 0, pending: null };
        }
        const age = Date.now() - modelCatalogCache.fetchedAt;
        const ttl = modelCatalogCache.map.size > 0 ? MODEL_CATALOG_TTL_MS : 15000;
        if (!force && modelCatalogCache.fetchedAt > 0 && age < ttl) {
            return modelCatalogCache;
        }
        if (modelCatalogCache.pending) return modelCatalogCache.pending;

        modelCatalogCache.pending = callLsRpc(endpoint, 'GetUserStatus', {})
            .then((res) => {
                const configs = (res && res.userStatus && res.userStatus.cascadeModelConfigData && res.userStatus.cascadeModelConfigData.clientModelConfigs)
                    || (res && res.cascadeModelConfigData && res.cascadeModelConfigData.clientModelConfigs)
                    || [];
                const nextMap = new Map();
                const nextQuotas = [];
                if (Array.isArray(configs)) {
                    for (const cfg of configs) {
                        if (!cfg || typeof cfg !== 'object') continue;
                        const label = cleanModelText(cfg.label);
                        if (!label) continue;
                        const refs = [
                            cfg.modelOrAlias && cfg.modelOrAlias.model,
                            cfg.modelOrAlias && cfg.modelOrAlias.alias,
                            cfg.modelId,
                        ];
                        const keys = [];
                        for (const ref of refs) {
                            const key = cleanModelText(ref).toLowerCase();
                            if (!key) continue;
                            keys.push(key);
                            if (!nextMap.has(key)) nextMap.set(key, label);
                        }
                        const qi = cfg.quotaInfo;
                        if (qi && typeof qi === 'object') {
                            const remRaw = typeof qi.remainingFraction === 'number'
                                ? qi.remainingFraction
                                : (typeof qi.remainingFraction === 'string' ? Number(qi.remainingFraction) : NaN);
                            if (Number.isFinite(remRaw)) {
                                const remainingFraction = Math.min(1, Math.max(0, remRaw));
                                nextQuotas.push({
                                    label,
                                    keys,
                                    remainingFraction,
                                    usedFraction: Math.min(1, Math.max(0, 1 - remainingFraction)),
                                    resetTime: typeof qi.resetTime === 'string' ? qi.resetTime : null,
                                });
                            }
                        }
                    }
                }
                modelCatalogCache.map = nextMap;
                modelCatalogCache.quotaEntries = nextQuotas;
                modelCatalogCache.fetchedAt = Date.now();
                return modelCatalogCache;
            })
            .catch(() => {
                modelCatalogCache.fetchedAt = Date.now();
                return modelCatalogCache;
            })
            .finally(() => {
                modelCatalogCache.pending = null;
            });
        return modelCatalogCache.pending;
    }

    function normalizeModelMatchKey(text) {
        return cleanModelText(text).toLowerCase().replace(/[()（）\-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function stripModelEffortSuffix(label) {
        return cleanModelText(label).replace(/\s*\((?:Low|Medium|High|XHigh|Extra High|Thinking)\)\s*$/i, '').trim();
    }

    function formatBucketWindowLabel(bucket) {
        const win = cleanModelText(bucket && bucket.window).toLowerCase();
        if (win === 'daily') return '每日额度';
        if (win === 'weekly') return '每周额度';
        const m = win.match(/^(\d+)([smhd])$/);
        if (m) {
            const unitMap = { s: '秒', m: '分钟', h: '小时', d: '天' };
            return `${m[1]}${unitMap[m[2]] || m[2]}额度`;
        }
        return cleanModelText(bucket && bucket.displayName) || '模型额度';
    }

    async function getQuotaSummary(endpoint, force = false) {
        if (quotaSummaryCache.endpointKey !== endpoint.key) {
            quotaSummaryCache = { endpointKey: endpoint.key, groups: [], fetchedAt: 0, pending: null };
        }
        const age = Date.now() - quotaSummaryCache.fetchedAt;
        const ttl = quotaSummaryCache.groups.length > 0 ? QUOTA_SUMMARY_TTL_MS : 10000;
        if (quotaSummaryCache.fetchedAt > 0) {
            if (!force && age < ttl) return quotaSummaryCache.groups;
            if (force && age < QUOTA_FORCE_COOLDOWN_MS && quotaSummaryCache.groups.length > 0) {
                return quotaSummaryCache.groups;
            }
        }
        if (quotaSummaryCache.pending) return quotaSummaryCache.pending;

        // 仅在显式事件触发（如本轮生成结束、主动打开浮卡）时才向云端请求 forceRefresh
        quotaSummaryCache.pending = callLsRpc(endpoint, 'RetrieveUserQuotaSummary', { forceRefresh: Boolean(force) })
            .then((res) => {
                const rawGroups = (res && res.response && Array.isArray(res.response.groups))
                    ? res.response.groups
                    : [];
                const parsed = [];
                for (const g of rawGroups) {
                    if (!g || typeof g !== 'object') continue;
                    const displayName = cleanModelText(g.displayName);
                    if (!displayName) continue;
                    const description = cleanModelText(g.description);
                    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
                    const buckets = [];
                    for (const b of rawBuckets) {
                        if (!b || typeof b !== 'object') continue;
                        const remRaw = typeof b.remainingFraction === 'number'
                            ? b.remainingFraction
                            : (typeof b.remainingFraction === 'string' ? Number(b.remainingFraction) : NaN);
                        if (!Number.isFinite(remRaw)) continue;
                        const remainingFraction = Math.min(1, Math.max(0, remRaw));
                        buckets.push({
                            bucketId: cleanModelText(b.bucketId),
                            window: cleanModelText(b.window),
                            windowLabel: formatBucketWindowLabel(b),
                            remainingFraction,
                            usedFraction: Math.min(1, Math.max(0, 1 - remainingFraction)),
                            resetTime: typeof b.resetTime === 'string' ? b.resetTime : null,
                            hasDescription: Boolean(cleanModelText(b.description)),
                            disabled: Boolean(b.disabled),
                        });
                    }
                    if (buckets.length > 0) {
                        parsed.push({ displayName, description, buckets });
                    }
                }
                quotaSummaryCache.groups = parsed;
                quotaSummaryCache.fetchedAt = Date.now();
                return parsed;
            })
            .catch(() => {
                quotaSummaryCache.fetchedAt = Date.now();
                return quotaSummaryCache.groups;
            })
            .finally(() => {
                quotaSummaryCache.pending = null;
            });
        return quotaSummaryCache.pending;
    }

    function matchGroupForModelLabel(groups, modelLabel) {
        if (!Array.isArray(groups) || !groups.length || !modelLabel) return null;
        const base = stripModelEffortSuffix(modelLabel).toLowerCase();
        if (!base) return null;
        for (const g of groups) {
            const dn = (g.displayName || '').toLowerCase();
            const desc = (g.description || '').toLowerCase();
            if (dn && (base.includes(dn) || dn.includes(base))) return g;
            if (desc && desc.includes(base)) return g;
        }
        if (/argon/i.test(base)) return groups.find((g) => /argon/i.test(g.displayName)) || null;
        if (/claude|gpt|openai/i.test(base)) return groups.find((g) => /claude|gpt/i.test(g.displayName)) || null;
        if (/gemini|orchestrator/i.test(base)) return groups.find((g) => /gemini models/i.test(g.displayName)) || groups.find((g) => /gemini/i.test(g.displayName)) || null;
        return null;
    }

    function buildQuotaPayload(quotaEntries, quotaGroups, latestChat, contextModel) {
        const hasGroups = Array.isArray(quotaGroups) && quotaGroups.length > 0;
        const hasEntries = Array.isArray(quotaEntries) && quotaEntries.length > 0;
        if (!hasGroups && !hasEntries) return null;

        let current = null;
        const rawCandidates = [];
        if (latestChat && typeof latestChat === 'object') {
            rawCandidates.push(latestChat.model, latestChat.responseModel, latestChat.modelDisplayName);
        }
        if (contextModel) rawCandidates.push(contextModel);

        if (hasEntries) {
            for (const raw of rawCandidates) {
                const key = cleanModelText(raw).toLowerCase();
                if (!key) continue;
                const byId = quotaEntries.find((e) => e.keys.includes(key));
                if (byId) {
                    current = byId;
                    break;
                }
                const norm = normalizeModelMatchKey(raw);
                if (!norm) continue;
                const byName = quotaEntries.find((e) => normalizeModelMatchKey(e.label) === norm);
                if (byName) {
                    current = byName;
                    break;
                }
            }
        }

        const currentLabel = (current && current.label) || cleanModelText(contextModel) || '';
        const matchedGroup = hasGroups ? matchGroupForModelLabel(quotaGroups, currentLabel) : null;

        let currentBucket = null;
        if (matchedGroup && matchedGroup.buckets.length > 0) {
            currentBucket = matchedGroup.buckets.reduce((minB, b) => (b.remainingFraction < minB.remainingFraction ? b : minB), matchedGroup.buckets[0]);
        }

        return {
            current: currentBucket
                ? {
                    label: currentLabel || matchedGroup.displayName,
                    groupName: matchedGroup.displayName,
                    windowLabel: currentBucket.windowLabel,
                    remainingFraction: currentBucket.remainingFraction,
                    usedFraction: currentBucket.usedFraction,
                    resetTime: currentBucket.resetTime,
                }
                : (current
                    ? {
                        label: current.label,
                        groupName: stripModelEffortSuffix(current.label),
                        windowLabel: 'Limit',
                        remainingFraction: current.remainingFraction,
                        usedFraction: current.usedFraction,
                        resetTime: current.resetTime,
                    }
                    : null),
            groups: hasGroups
                ? quotaGroups.map((g) => ({
                    displayName: g.displayName,
                    description: g.description,
                    isCurrent: Boolean(matchedGroup && matchedGroup.displayName === g.displayName),
                    buckets: g.buckets,
                }))
                : [],
            models: hasEntries
                ? quotaEntries.map((e) => ({
                    label: e.label,
                    remainingFraction: e.remainingFraction,
                    usedFraction: e.usedFraction,
                    resetTime: e.resetTime,
                }))
                : [],
        };
    }

    function resolveModelDisplayName(chatModel, modelCatalog) {
        if (!chatModel || typeof chatModel !== 'object') return null;
        const explicitDisplay = cleanModelText(chatModel.modelDisplayName);
        if (explicitDisplay && !/^MODEL_/i.test(explicitDisplay)) {
            return explicitDisplay;
        }
        const rawCandidates = [chatModel.modelDisplayName, chatModel.responseModel, chatModel.model];
        if (modelCatalog && modelCatalog.size > 0) {
            for (const raw of rawCandidates) {
                const text = cleanModelText(raw);
                if (!text) continue;
                const mapped = modelCatalog.get(text.toLowerCase());
                if (mapped) return mapped;
            }
        }
        for (const raw of rawCandidates) {
            const text = cleanModelText(raw);
            if (!text) continue;
            return formatFallbackModelLabel(text);
        }
        return null;
    }

    /** 解析数值、秒字符串 ("1.25s") 或 Protobuf Duration ({ seconds, nanos }) */
    function readDurationSec(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) && value >= 0 ? value : null;
        }
        if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) {
            const secs = Number(value.slice(0, -1));
            return Number.isFinite(secs) && secs >= 0 ? secs : null;
        }
        if (value && typeof value === 'object') {
            if (value.seconds === undefined && value.nanos === undefined) return null;
            const secPart = Number(value.seconds ?? 0);
            const nanoPart = Number(value.nanos ?? 0);
            if (!Number.isSafeInteger(secPart) || secPart < 0 || !Number.isInteger(nanoPart) || nanoPart < 0 || nanoPart >= 1e9) {
                return null;
            }
            const total = secPart + nanoPart / 1e9;
            return Number.isFinite(total) && total >= 0 ? total : null;
        }
        return null;
    }

    /** 提取单轮对话响应的生成速率、首字延迟与思考 token 数 */
    function readSpeedSlot(chat) {
        if (!chat || typeof chat !== 'object') return null;
        const usage = chat.usage && typeof chat.usage === 'object' ? chat.usage : null;
        const ttft = readDurationSec(chat.timeToFirstToken);
        const duration = readDurationSec(chat.streamingDuration);
        const totalOut = usage ? parseNonNegInt(usage.outputTokens) : null;
        const visibleOut = usage ? parseNonNegInt(usage.responseOutputTokens) : null;
        const thinkOut = usage ? parseNonNegInt(usage.thinkingOutputTokens) : null;
        const generated = visibleOut !== null
            ? visibleOut
            : (totalOut !== null && thinkOut !== null ? Math.max(0, totalOut - thinkOut) : totalOut);

        const isRatioReliable = Boolean(
            generated !== null &&
            generated > 0 &&
            duration !== null &&
            duration >= 0.3 &&
            !(ttft !== null && ttft >= 2 && duration < 1 && ttft / duration >= 20)
        );
        if (ttft === null && !isRatioReliable && thinkOut === null) return null;
        return {
            ttft,
            duration: isRatioReliable ? duration : null,
            responseTokens: isRatioReliable ? generated : null,
            tps: isRatioReliable ? generated / duration : null,
            thinkingTokens: thinkOut,
        };
    }

    /** 汇总整段会话的最近速率与加权平均速率 */
    function aggregateSpeedSlots(slots) {
        if (!Array.isArray(slots) || slots.length === 0) return null;
        let sumTokens = 0;
        let sumSeconds = 0;
        let lastSpeed = null;
        let lastLatency = null;
        for (const item of slots) {
            if (!item) continue;
            if (item.tps !== null && item.duration > 0 && item.responseTokens > 0) {
                sumTokens += item.responseTokens;
                sumSeconds += item.duration;
                lastSpeed = item;
            }
            if (item.ttft !== null || item.thinkingTokens !== null) {
                lastLatency = item;
            }
        }
        const sessionTps = sumSeconds > 0 ? sumTokens / sumSeconds : null;
        if (!lastSpeed && !lastLatency && sessionTps === null) return null;
        return {
            latestTps: lastSpeed ? lastSpeed.tps : null,
            latestTokens: lastSpeed ? lastSpeed.responseTokens : null,
            latestDuration: lastSpeed ? lastSpeed.duration : null,
            sessionTps,
            ttftSeconds: lastLatency ? lastLatency.ttft : null,
            thinkingTokens: lastLatency ? lastLatency.thinkingTokens : null,
        };
    }

    /** 提取单次模型请求的输入缓存读写统计 */
    function readCacheSlot(usage) {
        if (!usage || typeof usage !== 'object') return null;
        const input = parseNonNegInt(usage.inputTokens);
        if (input === null) return null;
        if (usage.cacheReadTokens !== undefined && parseNonNegInt(usage.cacheReadTokens) === null) return null;
        if (usage.cacheWriteTokens !== undefined && parseNonNegInt(usage.cacheWriteTokens) === null) return null;
        const read = parseNonNegInt(usage.cacheReadTokens) ?? 0;
        const write = parseNonNegInt(usage.cacheWriteTokens) ?? 0;
        const total = input + read + write;
        if (!Number.isSafeInteger(total) || total < 0 || read + write > total) return null;
        const provider = String(usage.apiProvider || '');
        if (total > 0 && !/GOOGLE_GEMINI|OPENAI|ANTHROPIC/.test(provider)) return null;
        return { input, read, write, total };
    }

    /** 汇总整段会话的缓存命中率 */
    function aggregateCacheSlots(slots) {
        if (!Array.isArray(slots) || slots.length === 0) return null;
        let totalRead = 0;
        let totalWrite = 0;
        let totalInput = 0;
        let count = 0;
        let lastSlot = null;
        for (const item of slots) {
            if (!item) continue;
            totalRead += item.read;
            totalWrite += item.write;
            totalInput += item.total;
            count++;
            lastSlot = item;
        }
        if (count === 0) return null;
        return {
            latest: lastSlot ? {
                readTokens: lastSlot.read,
                writeTokens: lastSlot.write,
                totalTokens: lastSlot.total,
                hitRate: lastSlot.total > 0 ? lastSlot.read / lastSlot.total : null,
            } : null,
            session: {
                readTokens: totalRead,
                writeTokens: totalWrite,
                totalTokens: totalInput,
                hitRate: totalInput > 0 ? totalRead / totalInput : null,
                requests: count,
            },
        };
    }

    function buildContextMetrics(chatModel, modelCatalog) {
        if (!chatModel || typeof chatModel !== 'object') return null;
        const startMeta = chatModel.chatStartMetadata;
        const ctxMeta = startMeta && startMeta.contextWindowMetadata;
        if (!ctxMeta || typeof ctxMeta !== 'object') return null;
        const usedTokens = parseNonNegInt(ctxMeta.estimatedTokensUsed);
        if (usedTokens === null) return null;
        const rawMax = parseNonNegInt(ctxMeta.maxContextTokens);
        const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;
        return {
            usedTokens,
            maxTokens,
            remainingTokens: maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
            usedFraction: maxTokens === null ? null : usedTokens / maxTokens,
            remainingFraction: maxTokens === null ? null : Math.max(0, 1 - usedTokens / maxTokens),
            model: resolveModelDisplayName(chatModel, modelCatalog),
        };
    }

    async function getSummaries(endpoint) {
        if (summariesCache.endpointKey !== endpoint.key) {
            summariesCache = { endpointKey: endpoint.key, pending: null };
            sessionCache.clear();
        }
        if (summariesCache.pending) return summariesCache.pending;
        summariesCache.pending = callLsRpc(endpoint, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false })
            .then((res) => (res && res.trajectorySummaries && typeof res.trajectorySummaries === 'object')
                ? res.trajectorySummaries
                : {})
            .finally(() => {
                summariesCache.pending = null;
            });
        return summariesCache.pending;
    }

    async function fetchLatestChatModel(endpoint, cascadeId, startOffset, initialChat, initialCacheSlots, initialSpeedSlots, modelCatalog) {
        let offset = startOffset;
        let latestChat = initialChat || null;
        const cacheSlots = Array.isArray(initialCacheSlots) ? initialCacheSlots.slice(0, startOffset) : [];
        const speedSlots = Array.isArray(initialSpeedSlots) ? initialSpeedSlots.slice(0, startOffset) : [];
        const visitedOffsets = new Set();
        for (let pageIdx = 0; pageIdx < 1024; pageIdx++) {
            if (visitedOffsets.has(offset)) break;
            visitedOffsets.add(offset);
            const page = await callLsRpc(endpoint, 'GetCascadeTrajectoryGeneratorMetadata', {
                cascadeId,
                generatorMetadataOffset: offset,
                includeMessages: false,
            });
            const items = (page && (page.generatorMetadata || page.generatorMetadatas)) || [];
            if (!Array.isArray(items) || items.length === 0) {
                return { offset, latestChat, cacheSlots, speedSlots, emptyAtStart: pageIdx === 0 && startOffset > 0 };
            }
            for (let i = 0; i < items.length; i++) {
                const chat = items[i] && items[i].chatModel;
                if (chat) {
                    if (buildContextMetrics(chat, modelCatalog) || !latestChat) {
                        latestChat = chat;
                    }
                    cacheSlots[offset + i] = readCacheSlot(chat.usage);
                    speedSlots[offset + i] = readSpeedSlot(chat);
                } else {
                    cacheSlots[offset + i] = null;
                    speedSlots[offset + i] = null;
                }
            }
            offset += items.length;
        }
        cacheSlots.length = offset;
        speedSlots.length = offset;
        return { offset, latestChat, cacheSlots, speedSlots, emptyAtStart: false };
    }

    const TOKEN_TYPE_META = [
        { match: /(?:^|_)SYSTEM_PROMPT$|^1$/, key: 'system_prompt', label: '系统提示词', color: '#10b981', order: 1 },
        { match: /(?:^|_)MCP_TOOLS$|^4$/, key: 'mcp_tools', label: 'MCP 工具', color: '#f97316', order: 2 },
        { match: /(?:^|_)TOOLS$|^2$/, key: 'tools', label: '系统工具', color: '#8b5cf6', order: 3 },
        { match: /(?:^|_)RULES$|^3$/, key: 'rules', label: '规则文件', color: '#06b6d4', order: 4 },
        { match: /(?:^|_)SKILLS$|^5$/, key: 'skills', label: '技能定义', color: '#eab308', order: 5 },
        { match: /(?:^|_)SUBAGENTS$|^6$/, key: 'subagents', label: '子代理', color: '#ec4899', order: 6 },
        { match: /(?:^|_)(?:WORKFLOWS|PLUGINS|FLOWS)$|^(?:8|9|10)$/, key: 'extensions', label: '扩展与工作流', color: '#a855f7', order: 7 },
        { match: /(?:^|_)CHAT_MESSAGES$|^7$/, key: 'chat_messages', label: '对话消息', color: '#3b82f6', order: 8 },
    ];

    function resolveTokenTypeMeta(rawType) {
        const str = String(rawType ?? '').trim();
        for (const item of TOKEN_TYPE_META) {
            if (item.match.test(str)) return item;
        }
        return { key: 'other', label: '其他上下文', color: '#94a3b8', order: 90 };
    }

    /** 按官方 tokenBreakdown 原生分类直接构建上下文构成（不做步骤估算二次拆分） */
    function buildContextBreakdown(context, latestChat) {
        if (!context) return null;
        const denom = context.maxTokens !== null && context.maxTokens > 0 ? context.maxTokens : context.usedTokens;
        const basis = context.maxTokens !== null && context.maxTokens > 0 ? 'window' : 'used';

        const rawBreakdown = latestChat &&
            latestChat.chatStartMetadata &&
            latestChat.chatStartMetadata.contextWindowMetadata &&
            latestChat.chatStartMetadata.contextWindowMetadata.tokenBreakdown;
        const rawGroups = rawBreakdown && Array.isArray(rawBreakdown.groups) ? rawBreakdown.groups : [];

        const grouped = new Map();
        for (const grp of rawGroups) {
            if (!grp || typeof grp !== 'object') continue;
            const n = parseNonNegInt(grp.numTokens);
            if (n === null || n <= 0) continue;
            const meta = resolveTokenTypeMeta(grp.type);
            let cur = grouped.get(meta.key);
            if (!cur) {
                cur = { key: meta.key, label: meta.label, color: meta.color, order: meta.order, tokens: 0, isFree: false };
                grouped.set(meta.key, cur);
            }
            cur.tokens += n;
        }

        const categories = [];
        if (grouped.size > 0) {
            for (const g of grouped.values()) {
                if (g.tokens > 0) categories.push(g);
            }
            const totalPlaced = categories.reduce((s, c) => s + c.tokens, 0);
            if (context.usedTokens - totalPlaced > 64) {
                categories.push({
                    key: 'residual',
                    label: '其余会话上下文',
                    color: '#94a3b8',
                    order: 89,
                    tokens: context.usedTokens - totalPlaced,
                    isFree: false,
                });
            }
            categories.sort((a, b) => a.order - b.order);
        } else if (context.usedTokens > 0) {
            categories.push({
                key: 'messages_and_system',
                label: '已用上下文 (消息/提示/工具)',
                color: '#3b82f6',
                order: 8,
                tokens: context.usedTokens,
                isFree: false,
            });
        }

        if (context.remainingTokens !== null && context.maxTokens !== null) {
            categories.push({
                key: 'free_space',
                label: '可用空间',
                color: '#475569',
                order: 99,
                tokens: context.remainingTokens,
                isFree: true,
            });
        }

        return {
            basis,
            denomTokens: denom,
            categories: categories.map((r) => ({
                ...r,
                fraction: denom > 0 ? r.tokens / denom : null,
            })),
        };
    }

    async function queryConversationContext(rawId, force) {
        const endpoint = getLsEndpoint();
        if (!endpoint) return { status: 'offline', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null, quota: null };
        if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) {
            const [catalogState, quotaGroups] = await Promise.all([
                getModelCatalog(endpoint, Boolean(force)),
                getQuotaSummary(endpoint, Boolean(force)),
            ]);
            const quota = buildQuotaPayload(catalogState.quotaEntries, quotaGroups, null, null);
            return { status: 'new', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null, quota };
        }
        const id = rawId.toLowerCase();
        const summaries = await getSummaries(endpoint);
        const summary = summaries[id];
        if (!summary) {
            const [catalogState, quotaGroups] = await Promise.all([
                getModelCatalog(endpoint, Boolean(force)),
                getQuotaSummary(endpoint, Boolean(force)),
            ]);
            const quota = buildQuotaPayload(catalogState.quotaEntries, quotaGroups, null, null);
            return { status: 'new', running: false, conversationId: id, context: null, cache: null, speed: null, breakdown: null, quota };
        }

        const stepCount = parseNonNegInt(summary.stepCount);
        const lastInputIdx = parseNonNegInt(summary.lastUserInputStepIndex);
        const statusStr = String(summary.status || '');
        const running = RUNNING_STATUS_RE.test(statusStr);
        const mark = JSON.stringify([stepCount, summary.lastModifiedTime || null, statusStr || null, lastInputIdx]);
        const settled = SETTLED_STATUS_RE.test(statusStr);

        const cached = sessionCache.get(id);
        const now = Date.now();
        if (cached && cached.endpointKey === endpoint.key && !force && cached.mark === mark) {
            const ttl = settled ? 10000 : 1200;
            if (now - cached.verifiedAt < ttl) {
                const quotaAge = now - quotaSummaryCache.fetchedAt;
                if (quotaAge < QUOTA_SUMMARY_TTL_MS && cached.payload && cached.payload.quota) {
                    return cached.payload;
                }
                const [catalogState, quotaGroups] = await Promise.all([
                    getModelCatalog(endpoint, false),
                    getQuotaSummary(endpoint, false),
                ]);
                const freshQuota = buildQuotaPayload(catalogState.quotaEntries, quotaGroups, cached.lastChat, cached.payload && cached.payload.context && cached.payload.context.model);
                cached.payload = { ...cached.payload, quota: freshQuota };
                return cached.payload;
            }
        }

        const justSettled = Boolean(cached && !cached.settled && settled);
        const shouldForceQuota = Boolean(force || justSettled);

        const canIncremental = Boolean(
            cached &&
            cached.endpointKey === endpoint.key &&
            !force &&
            cached.offset > 0 &&
            (
                (stepCount !== null && cached.stepCount !== null && stepCount > cached.stepCount) ||
                !cached.settled ||
                cached.mark === mark
            ) &&
            (stepCount === null || cached.stepCount === null || stepCount >= cached.stepCount) &&
            (lastInputIdx === null || cached.lastInputIdx === null || lastInputIdx >= cached.lastInputIdx)
        );

        const [catalogState, quotaGroups, initialScan] = await Promise.all([
            getModelCatalog(endpoint, Boolean(force)),
            getQuotaSummary(endpoint, shouldForceQuota),
            fetchLatestChatModel(
                endpoint,
                id,
                canIncremental ? Math.max(0, cached.offset - 1) : 0,
                canIncremental ? cached.lastChat : null,
                canIncremental ? cached.cacheSlots : null,
                canIncremental ? cached.speedSlots : null
            ),
        ]);
        const modelCatalog = catalogState.map;
        let scan = initialScan;
        if (scan.emptyAtStart) {
            scan = await fetchLatestChatModel(endpoint, id, 0, null, null, null, modelCatalog);
        }

        const context = buildContextMetrics(scan.latestChat, modelCatalog);
        const cache = aggregateCacheSlots(scan.cacheSlots);
        const speed = aggregateSpeedSlots(scan.speedSlots);
        const breakdown = buildContextBreakdown(context, scan.latestChat);
        const quota = buildQuotaPayload(catalogState.quotaEntries, quotaGroups, scan.latestChat, context && context.model);
        const payload = {
            status: context ? 'ready' : 'waiting',
            running,
            conversationId: id,
            context,
            cache,
            speed,
            breakdown,
            quota,
        };

        sessionCache.delete(id);
        sessionCache.set(id, {
            endpointKey: endpoint.key,
            mark,
            settled,
            stepCount,
            lastInputIdx,
            offset: scan.offset,
            lastChat: scan.latestChat,
            cacheSlots: scan.cacheSlots,
            speedSlots: scan.speedSlots,
            verifiedAt: Date.now(),
            payload,
        });
        while (sessionCache.size > 32) {
            sessionCache.delete(sessionCache.keys().next().value);
        }
        return payload;
    }

    ipcMain.handle('ag-ctx:metrics', async (event, rawId, force) => {
        const senderUrl = event && event.senderFrame ? event.senderFrame.url : '';
        if (!LOCAL_ORIGIN_RE.test(senderUrl)) {
            return { status: 'offline', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null };
        }
        const key = (typeof rawId === 'string' && UUID_RE.test(rawId) ? rawId.toLowerCase() : 'none') + ':' + (force ? '1' : '0');
        if (inflightRequests.has(key)) return inflightRequests.get(key);
        const promise = queryConversationContext(rawId, Boolean(force))
            .catch(() => ({ status: 'error', running: false, conversationId: typeof rawId === 'string' ? rawId.toLowerCase() : null, context: null, cache: null, speed: null, breakdown: null }))
            .finally(() => {
                inflightRequests.delete(key);
            });
        inflightRequests.set(key, promise);
        return promise;
    });

    // -------------------------------------------------------------------------
    // 4. 渲染层注入脚本（函数体直接序列化注入，避免模板字符串转义陷阱）
    // -------------------------------------------------------------------------

    function rendererBootstrap() {
        if (window.__agCtxMonitorInstalled) return;
        if (!window.__agCtxBridge || typeof window.__agCtxBridge.getMetrics !== 'function') return;
        window.__agCtxMonitorInstalled = true;

        const RING_HOST_CLASS = 'ag-ctx-monitor-host';
        const SPEED_HOST_CLASS = 'ag-ctx-speed-host';
        const CARD_PORTAL_ID = 'ag-ctx-card-portal';
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const RING_R = 6;
        const RING_C = 2 * Math.PI * RING_R;
        const RING_ARC = RING_C * 0.75;
        const BIG_R = 25;
        const BIG_C = 2 * Math.PI * BIG_R;
        const BIG_ARC = BIG_C * 0.75;

        const instances = new Map();
        let cardPortal = null;
        let cardRoot = null;
        let activeInst = null;
        let activeAnchor = 'ring';
        let pinnedOpen = false;
        let hoverOpen = false;
        let breakdownOpen = false;
        let hoverTimer = null;
        let closeTimer = null;
        let layoutScheduled = false;

        function isVisible(el) {
            return Boolean(el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
        }

        function formatCompactTokens(n) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
            if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
            return String(n);
        }

        function formatExactTokens(n) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
            return n.toLocaleString('en-US');
        }

        function formatCacheStat(entry, extraRequests) {
            if (!entry || typeof entry.totalTokens !== 'number') {
                return { text: '—', title: '' };
            }
            const pctText = typeof entry.hitRate === 'number' && Number.isFinite(entry.hitRate)
                ? `${(entry.hitRate * 100).toFixed(entry.hitRate >= 0.9995 || entry.hitRate === 0 ? 0 : 1)}%`
                : '—';
            const text = entry.hitRate === null
                ? '—'
                : `${pctText} · ${formatCompactTokens(entry.readTokens)}`;
            const parts = [
                `命中 ${formatExactTokens(entry.readTokens)}`,
                `输入 ${formatExactTokens(entry.totalTokens)}`,
            ];
            if (entry.writeTokens > 0) parts.push(`写入 ${formatExactTokens(entry.writeTokens)}`);
            if (typeof extraRequests === 'number' && extraRequests > 0) parts.push(`${extraRequests} 次请求`);
            return { text, title: parts.join(' / ') };
        }

        function formatDuration(seconds) {
            if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
            if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
            if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
            const mins = Math.floor(seconds / 60);
            const rem = Math.round(seconds % 60);
            return `${mins}m${rem < 10 ? '0' : ''}${rem}s`;
        }

        function formatTps(tps) {
            if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0) return '—';
            return tps >= 100 ? `${Math.round(tps)} tok/s` : `${tps.toFixed(1).replace(/\.0$/, '')} tok/s`;
        }

        function formatSpeedView(speed, running) {
            const hasLatestTps = Boolean(speed && typeof speed.latestTps === 'number' && Number.isFinite(speed.latestTps));
            const hasSessionTps = Boolean(speed && typeof speed.sessionTps === 'number' && Number.isFinite(speed.sessionTps));
            const hasTtft = Boolean(speed && typeof speed.ttftSeconds === 'number' && Number.isFinite(speed.ttftSeconds));
            const thinkingTokens = speed && typeof speed.thinkingTokens === 'number' ? speed.thinkingTokens : 0;

            const primaryTps = hasLatestTps ? speed.latestTps : (hasSessionTps ? speed.sessionTps : null);
            const mainText = primaryTps !== null
                ? formatTps(primaryTps)
                : (running ? '思考中...' : '-- tok/s');
            const subText = hasTtft ? formatDuration(speed.ttftSeconds) : '';

            const tpsText = hasLatestTps
                ? (hasSessionTps ? `${formatTps(speed.latestTps)} · 均 ${Math.round(speed.sessionTps)}` : formatTps(speed.latestTps))
                : (hasSessionTps ? `均 ${formatTps(speed.sessionTps)}` : '—');
            const tpsTitleParts = [];
            if (hasLatestTps && speed.latestTokens && speed.latestDuration) {
                tpsTitleParts.push(`最近输出 ${formatExactTokens(speed.latestTokens)} tok / ${formatDuration(speed.latestDuration)}`);
            }
            if (hasSessionTps) {
                tpsTitleParts.push(`会话平均 ${formatTps(speed.sessionTps)}`);
            }

            const pillTitleParts = [];
            if (primaryTps !== null) {
                pillTitleParts.push(`${hasLatestTps ? '生成速率' : '会话均速'} ${formatTps(primaryTps)}`);
            }
            if (hasTtft) {
                pillTitleParts.push(`首字耗时(含读取与思考) ${formatDuration(speed.ttftSeconds)}`);
            }
            if (thinkingTokens > 0) {
                pillTitleParts.push(`思考 ${formatCompactTokens(thinkingTokens)} tok`);
            }
            if (running) {
                pillTitleParts.push('正在运行');
            }
            if (!pillTitleParts.length) {
                pillTitleParts.push('模型生成速率与首字耗时');
            }

            return {
                mainText,
                subText,
                hasMetrics: primaryTps !== null || hasTtft || thinkingTokens > 0,
                pillTitle: pillTitleParts.join(' · '),
                tpsText,
                tpsTitle: tpsTitleParts.join(' / '),
            };
        }

        function detectDarkTheme(targetBox) {
            const html = document.documentElement;
            if (html.classList.contains('dark')) return true;
            if (html.classList.contains('light')) return false;
            const probeEls = [document.body, targetBox, html].filter(Boolean);
            for (const el of probeEls) {
                const bg = getComputedStyle(el).backgroundColor;
                const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (!m) continue;
                const alpha = m[4] === undefined ? 1 : Number(m[4]);
                if (alpha === 0) continue;
                const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
                return lum < 0.5;
            }
            return matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function findAllComposers() {
            const boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]')).filter(isVisible);
            const candidates = [];
            for (const box of boxes) {
                const footer = box.querySelector('.agy-composer-footer');
                if (footer && isVisible(footer) && footer.children.length >= 2) {
                    const leftGroup = footer.firstElementChild;
                    const rightGroup = footer.lastElementChild;
                    if (rightGroup && isVisible(rightGroup)) {
                        candidates.push({
                            box,
                            toolbar: footer,
                            mountParent: footer,
                            beforeNode: rightGroup,
                            afterNode: null,
                            leftGroup,
                            modelBtn: null,
                            speedParent: null,
                            speedAfter: null,
                        });
                        continue;
                    }
                }
                const surface = box.querySelector('.surface-composer, #antigravity\\.agentSidePanelInputBox');
                candidates.push({
                    box,
                    toolbar: surface || box,
                    mountParent: box,
                    beforeNode: null,
                    afterNode: surface && surface.parentElement === box ? surface : null,
                    leftGroup: null,
                    modelBtn: null,
                    speedParent: null,
                    speedAfter: null,
                });
            }
            return candidates;
        }

        function resolveConversationId(comp) {
            if (!comp || !comp.box || !comp.box.isConnected) return null;
            const readValidId = (el) => {
                if (!el) return null;
                const val = el.getAttribute('data-cascade-id');
                return UUID_RE.test(val || '') ? val.toLowerCase() : null;
            };

            let branch = null;
            for (let el = comp.box, hops = 0; el && el !== document.body && hops < 28; branch = el, el = el.parentElement, hops++) {
                if (el.matches('[data-testid="conversation-view"]')) {
                    return readValidId(el);
                }
                const direct = readValidId(el);
                if (direct) return direct;

                // 子代理或侧边问答标签页中，对话区通常是输入框父级容器的兄弟分支
                if (branch) {
                    for (const sibling of el.children) {
                        if (sibling === branch || sibling.contains(comp.box)) continue;
                        if (!isVisible(sibling)) continue;
                        const subView = sibling.matches('[data-testid="subagent-tab-conversation"],[data-testid="side-question-tab-conversation"]')
                            ? sibling
                            : sibling.querySelector('[data-testid="subagent-tab-conversation"],[data-testid="side-question-tab-conversation"]');
                        if (subView && isVisible(subView)) {
                            return readValidId(subView);
                        }
                    }
                }
                if (el.matches('[data-testid="side-question-tab-content"],[data-media-drop-scope="subpane"],aside,[role="tabpanel"],[data-pane-id]')) {
                    return null;
                }
            }

            const pathMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
            return pathMatch && UUID_RE.test(pathMatch[1]) ? pathMatch[1].toLowerCase() : null;
        }

        function h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
                }
            }
            for (const ch of children) {
                if (ch === undefined || ch === null) continue;
                el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
            }
            return el;
        }

        function svgEl(tag, attrs, ...children) {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
                }
            }
            for (const ch of children) {
                if (ch) el.appendChild(ch);
            }
            return el;
        }

        const THEME_VARS_CSS = `
            :host {
                --ctx-fg: rgba(235, 238, 245, 0.92);
                --ctx-muted: rgba(164, 173, 190, 0.78);
                --ctx-pill-hover: rgba(255, 255, 255, 0.08);
                --ctx-pill-active: rgba(255, 255, 255, 0.13);
                --ctx-track: rgba(255, 255, 255, 0.14);
                --ctx-card-bg: rgba(24, 27, 34, 0.94);
                --ctx-card-border: rgba(255, 255, 255, 0.12);
                --ctx-card-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
                --ctx-divider: rgba(255, 255, 255, 0.08);
                --ctx-badge-bg: rgba(255, 255, 255, 0.07);
                --ctx-accent: #38bdf8;
                --ctx-warn: #f59e0b;
                --ctx-danger: #ef4444;
                --ctx-idle: rgba(164, 173, 190, 0.52);
                --ctx-tone: var(--ctx-idle);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            :host([data-theme="light"]) {
                --ctx-fg: rgba(23, 27, 36, 0.92);
                --ctx-muted: rgba(88, 96, 112, 0.84);
                --ctx-pill-hover: rgba(15, 23, 42, 0.06);
                --ctx-pill-active: rgba(15, 23, 42, 0.10);
                --ctx-track: rgba(15, 23, 42, 0.14);
                --ctx-card-bg: rgba(255, 255, 255, 0.96);
                --ctx-card-border: rgba(15, 23, 42, 0.11);
                --ctx-card-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
                --ctx-divider: rgba(15, 23, 42, 0.08);
                --ctx-badge-bg: rgba(15, 23, 42, 0.05);
                --ctx-accent: #0284c7;
                --ctx-warn: #d97706;
                --ctx-danger: #dc2626;
                --ctx-idle: rgba(100, 116, 139, 0.55);
            }
            :host([data-level="normal"]) { --ctx-tone: var(--ctx-accent); }
            :host([data-level="warn"]) { --ctx-tone: var(--ctx-warn); }
            :host([data-level="danger"]) { --ctx-tone: var(--ctx-danger); }
            :host([data-level="idle"]) { --ctx-tone: var(--ctx-idle); }
            * { box-sizing: border-box; }
        `;

        function getPortalMountParent() {
            return document.body || document.documentElement;
        }

        function ensureCardPortal() {
            if (!cardPortal) {
                cardPortal = document.createElement('div');
                cardPortal.id = CARD_PORTAL_ID;
                cardPortal.setAttribute('data-ag-localization-skip', 'true');
                cardPortal.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
                cardRoot = cardPortal.attachShadow({ mode: 'open' });

                const styleEl = document.createElement('style');
                styleEl.textContent = `
                    ${THEME_VARS_CSS}
                    .card {
                        pointer-events: auto;
                        position: fixed;
                        z-index: 2147483647;
                        display: flex;
                        align-items: stretch;
                        width: auto;
                        max-width: calc(100vw - 16px);
                        max-height: calc(100vh - 20px);
                        overflow-y: auto;
                        padding: 13px 15px 12px;
                        border-radius: 14px;
                        background: var(--ctx-card-bg);
                        backdrop-filter: blur(14px);
                        -webkit-backdrop-filter: blur(14px);
                        border: 1px solid var(--ctx-card-border);
                        box-shadow: var(--ctx-card-shadow);
                        color: var(--ctx-fg);
                        font-size: 12px;
                    }
                    .card[hidden] { display: none; }
                    .card-main {
                        width: 288px;
                        max-width: calc(100vw - 46px);
                        flex: none;
                        min-width: 0;
                    }
                    .card-head {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                        margin-bottom: 12px;
                    }
                    .card-head-left {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        min-width: 0;
                    }
                    .card-title {
                        font-size: 12px;
                        font-weight: 600;
                        letter-spacing: 0.01em;
                    }
                    .bd-toggle {
                        appearance: none;
                        border: 0;
                        margin: 0;
                        background: transparent;
                        color: var(--ctx-muted);
                        display: inline-flex;
                        align-items: center;
                        gap: 3px;
                        height: 20px;
                        padding: 0 5px;
                        border-radius: 5px;
                        font: inherit;
                        font-size: 10px;
                        cursor: pointer;
                        transition: background-color 140ms ease, color 140ms ease;
                    }
                    .bd-toggle:hover,
                    .bd-toggle[aria-expanded="true"] {
                        background: var(--ctx-pill-hover);
                        color: var(--ctx-fg);
                    }
                    .bd-toggle:focus-visible {
                        outline: 1.5px solid var(--ctx-accent);
                        outline-offset: 1px;
                    }
                    .bd-chevron {
                        width: 11px;
                        height: 11px;
                        display: block;
                        flex: none;
                        transition: transform 160ms ease;
                    }
                    .bd-toggle[aria-expanded="true"] .bd-chevron {
                        transform: rotate(180deg);
                    }
                    .breakdown {
                        width: 248px;
                        flex: none;
                        min-width: 0;
                        max-height: 360px;
                        overflow-y: auto;
                        padding-left: 14px;
                        margin-left: 14px;
                        border-left: 1px solid var(--ctx-divider);
                        display: flex;
                        flex-direction: column;
                        gap: 7px;
                        scrollbar-width: thin;
                    }
                    .breakdown[hidden] { display: none; }
                    .bd-panel-title {
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--ctx-fg);
                        line-height: 1.25;
                        margin-bottom: 2px;
                    }
                    @media (max-width: 620px) {
                        .card { flex-direction: column; }
                        .breakdown {
                            width: auto;
                            margin-left: 0;
                            padding-left: 0;
                            margin-top: 10px;
                            padding-top: 10px;
                            border-left: 0;
                            border-top: 1px solid var(--ctx-divider);
                        }
                    }
                    .bd-bar {
                        display: flex;
                        align-items: stretch;
                        gap: 1.5px;
                        width: 100%;
                        height: 8px;
                        border-radius: 999px;
                        overflow: hidden;
                        background: var(--ctx-track);
                        margin-bottom: 4px;
                        flex: none;
                    }
                    .bd-bar[hidden] { display: none; }
                    .bd-seg {
                        height: 100%;
                        flex: 0 1 auto;
                        min-width: 2px;
                        transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
                    }
                    .bd-seg[data-free="true"] {
                        flex: 1 1 auto;
                        min-width: 0;
                        background: transparent !important;
                    }
                    .bd-list {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .bd-row {
                        display: grid;
                        grid-template-columns: 8px minmax(0, 1fr) auto 42px;
                        align-items: center;
                        gap: 7px;
                        font-size: 11px;
                        line-height: 1.35;
                    }
                    .bd-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 2px;
                        flex: none;
                    }
                    .bd-name {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        color: var(--ctx-fg);
                    }
                    .bd-row[data-free="true"] .bd-name,
                    .bd-row[data-free="true"] .bd-pct {
                        color: var(--ctx-muted);
                    }
                    .bd-tokens {
                        font-variant-numeric: tabular-nums;
                        color: var(--ctx-muted);
                        text-align: right;
                    }
                    .bd-pct {
                        font-variant-numeric: tabular-nums;
                        font-weight: 550;
                        text-align: right;
                    }
                    .bd-empty {
                        font-size: 11px;
                        color: var(--ctx-muted);
                        padding: 2px 0;
                    }
                    .state-badge {
                        font-size: 10px;
                        font-weight: 550;
                        padding: 2px 7px;
                        border-radius: 999px;
                        background: var(--ctx-badge-bg);
                        color: var(--ctx-tone);
                    }
                    .card-body {
                        display: flex;
                        align-items: center;
                        gap: 14px;
                    }
                    .big-gauge-wrap {
                        position: relative;
                        width: 64px;
                        height: 64px;
                        flex: none;
                    }
                    .big-gauge {
                        width: 64px;
                        height: 64px;
                        display: block;
                    }
                    .big-track {
                        fill: none;
                        stroke: var(--ctx-track);
                        stroke-width: 5;
                        stroke-linecap: round;
                    }
                    .big-arc {
                        fill: none;
                        stroke: var(--ctx-tone);
                        stroke-width: 5;
                        stroke-linecap: round;
                        transition: stroke-dasharray 260ms cubic-bezier(0.22, 1, 0.36, 1), stroke 180ms ease;
                    }
                    .big-center {
                        position: absolute;
                        inset: 0;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        padding-top: 2px;
                    }
                    .big-pct {
                        font-size: 14px;
                        font-weight: 650;
                        font-variant-numeric: tabular-nums;
                        letter-spacing: -0.02em;
                    }
                    .big-sub {
                        font-size: 9px;
                        color: var(--ctx-muted);
                        margin-top: 1px;
                    }
                    .stats {
                        flex: 1;
                        min-width: 0;
                        display: grid;
                        gap: 6px;
                    }
                    .stat-row {
                        display: flex;
                        align-items: baseline;
                        justify-content: space-between;
                        gap: 8px;
                    }
                    .stat-label {
                        font-size: 11px;
                        color: var(--ctx-muted);
                        white-space: nowrap;
                    }
                    .stat-value {
                        font-size: 11.5px;
                        font-weight: 550;
                        font-variant-numeric: tabular-nums;
                        text-align: right;
                    }
                    .card-foot {
                        margin-top: 11px;
                        padding-top: 9px;
                        border-top: 1px solid var(--ctx-divider);
                        display: grid;
                        gap: 5px;
                    }
                    .foot-row {
                        display: flex;
                        align-items: baseline;
                        justify-content: space-between;
                        gap: 10px;
                        font-size: 11px;
                    }
                    .foot-row .stat-value {
                        font-size: 11px;
                        font-weight: 500;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        max-width: 196px;
                    }
                    .quota-section {
                        margin-top: 11px;
                        padding-top: 10px;
                        border-top: 1px solid var(--ctx-divider);
                        display: grid;
                        gap: 10px;
                    }
                    .quota-section-title {
                        font-size: 11.5px;
                        font-weight: 500;
                        color: var(--ctx-muted);
                        line-height: 1.2;
                    }
                    .quota-groups {
                        display: grid;
                        gap: 9px;
                    }
                    .quota-group {
                        display: grid;
                        gap: 5px;
                    }
                    .quota-group-head {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--ctx-fg);
                        line-height: 1.25;
                    }
                    .quota-group-dot {
                        width: 6px;
                        height: 6px;
                        border-radius: 50%;
                        background: var(--ctx-accent);
                        flex: none;
                    }
                    .quota-bucket-row {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                    }
                    .quota-bucket-left {
                        display: inline-flex;
                        align-items: baseline;
                        gap: 4px;
                        min-width: 0;
                        flex: 1;
                        overflow: hidden;
                        white-space: nowrap;
                    }
                    .quota-bucket-label {
                        font-size: 11.5px;
                        color: var(--ctx-muted);
                        line-height: 1.25;
                        flex: none;
                    }
                    .quota-bucket-reset {
                        font-size: 10.5px;
                        color: var(--ctx-muted);
                        opacity: 0.78;
                        line-height: 1.2;
                        font-variant-numeric: tabular-nums;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                    .quota-bucket-right {
                        display: inline-flex;
                        align-items: center;
                        gap: 7px;
                        flex: none;
                        font-variant-numeric: tabular-nums;
                    }
                    .quota-bucket-pct {
                        font-size: 11.5px;
                        font-weight: 500;
                        color: var(--ctx-muted);
                        white-space: nowrap;
                    }
                    .quota-bucket-pct[data-qlevel="warn"] { color: var(--ctx-warn); }
                    .quota-bucket-pct[data-qlevel="danger"] { color: var(--ctx-danger); }
                    .quota-ring {
                        width: 16px;
                        height: 16px;
                        flex: none;
                        display: block;
                    }
                    .quota-ring-track {
                        fill: none;
                        stroke: var(--ctx-track);
                        stroke-width: 2;
                    }
                    .quota-ring-arc {
                        fill: none;
                        stroke: #569a47;
                        stroke-width: 2;
                        stroke-linecap: round;
                    }
                    :host([data-theme="dark"]) .quota-ring-arc { stroke: #4ade80; }
                    .quota-ring-arc[data-qlevel="warn"] { stroke: var(--ctx-warn); }
                    .quota-ring-arc[data-qlevel="danger"] { stroke: var(--ctx-danger); }
                `;

                const card = h(
                    'section',
                    { class: 'card', id: 'ctx-card', role: 'dialog', 'aria-label': '上下文窗口详情', hidden: '' },
                    h(
                        'div',
                        { class: 'card-main' },
                        h(
                            'div',
                            { class: 'card-head' },
                            h(
                                'div',
                                { class: 'card-head-left' },
                                h('span', { class: 'card-title' }, '上下文窗口'),
                                h(
                                    'button',
                                    {
                                        type: 'button',
                                        class: 'bd-toggle',
                                        id: 'card-breakdown-toggle',
                                        'aria-expanded': 'false',
                                        'aria-label': '向右展开上下文分类构成',
                                        title: '向右展开上下文分类构成',
                                    },
                                    h('span', { id: 'bd-toggle-text' }, '构成'),
                                    svgEl(
                                        'svg',
                                        { class: 'bd-chevron', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
                                        svgEl('path', {
                                            d: 'M4.5 2.5L8 6l-3.5 3.5',
                                            fill: 'none',
                                            stroke: 'currentColor',
                                            'stroke-width': '1.5',
                                            'stroke-linecap': 'round',
                                            'stroke-linejoin': 'round',
                                        })
                                    )
                                )
                            ),
                            h('span', { class: 'state-badge', id: 'card-badge' }, '待采样')
                        ),
                        h(
                            'div',
                            { class: 'card-body' },
                            h(
                                'div',
                                { class: 'big-gauge-wrap' },
                                svgEl(
                                    'svg',
                                    { class: 'big-gauge', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
                                    svgEl('circle', {
                                        class: 'big-track',
                                        cx: '32',
                                        cy: '32',
                                        r: String(BIG_R),
                                        'stroke-dasharray': `${BIG_ARC.toFixed(2)} ${BIG_C.toFixed(2)}`,
                                        transform: 'rotate(135 32 32)',
                                    }),
                                    svgEl('circle', {
                                        class: 'big-arc',
                                        id: 'big-arc',
                                        cx: '32',
                                        cy: '32',
                                        r: String(BIG_R),
                                        'stroke-dasharray': `0 ${BIG_C.toFixed(2)}`,
                                        transform: 'rotate(135 32 32)',
                                    })
                                ),
                                h(
                                    'div',
                                    { class: 'big-center' },
                                    h('span', { class: 'big-pct', id: 'card-pct' }, '--'),
                                    h('span', { class: 'big-sub' }, '已用')
                                )
                            ),
                            h(
                                'div',
                                { class: 'stats' },
                                h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '已用 Token'), h('span', { class: 'stat-value', id: 'card-used' }, '—')),
                                h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '剩余可用'), h('span', { class: 'stat-value', id: 'card-rem' }, '—')),
                                h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '窗口上限'), h('span', { class: 'stat-value', id: 'card-max' }, '—'))
                            )
                        ),
                        h(
                            'div',
                            { class: 'card-foot' },
                            h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '采样模型'), h('span', { class: 'stat-value', id: 'card-model', title: '' }, '—')),
                            h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '生成速率'), h('span', { class: 'stat-value', id: 'card-tps', title: '' }, '—')),
                            h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '本次缓存'), h('span', { class: 'stat-value', id: 'card-cache-last', title: '' }, '—')),
                            h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '累计缓存'), h('span', { class: 'stat-value', id: 'card-cache-total', title: '' }, '—'))
                        ),
                        h(
                            'div',
                            { class: 'quota-section', id: 'card-quota-section', hidden: '' },
                            h('div', { class: 'quota-section-title' }, '模型额度'),
                            h('div', { class: 'quota-groups', id: 'card-quota-groups' })
                        )
                    ),
                    h(
                        'div',
                        { class: 'breakdown', id: 'card-breakdown', hidden: '' },
                        h('div', { class: 'bd-panel-title' }, '上下文构成'),
                        h('div', { class: 'bd-bar', id: 'bd-bar', hidden: '' }),
                        h('div', { class: 'bd-list', id: 'bd-categories' }),
                        h('div', { class: 'bd-empty', id: 'bd-note', hidden: '' }, '')
                    )
                );

                const wrap = h('div', { class: 'ctx-portal-wrap', 'data-ag-localization-skip': 'true' }, card);
                cardRoot.appendChild(styleEl);
                cardRoot.appendChild(wrap);

                cardRoot.getElementById('card-breakdown-toggle').addEventListener('click', (e) => {
                    e.stopPropagation();
                    breakdownOpen = !breakdownOpen;
                    pinnedOpen = true;
                    updateCardVisibility();
                });

                card.addEventListener('pointerenter', () => {
                    clearTimeout(closeTimer);
                });
                card.addEventListener('pointerleave', () => {
                    scheduleHoverClose();
                });
                cardRoot.addEventListener('pointerdown', (e) => e.stopPropagation());
                cardRoot.addEventListener('click', (e) => e.stopPropagation());
            }

            const mountParent = getPortalMountParent();
            if (mountParent && cardPortal.parentElement !== mountParent) {
                mountParent.appendChild(cardPortal);
            }
        }

        function createInstance(comp) {
            const BAR_RING_R = 5.2;
            const BAR_RING_C = 2 * Math.PI * BAR_RING_R;

            const host = document.createElement('div');
            host.className = RING_HOST_CLASS;
            host.setAttribute('data-ag-ctx-role', 'footer-right-bar');
            host.setAttribute('data-ag-localization-skip', 'true');
            host.style.cssText = 'display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;margin-right:4px;position:relative;z-index:2;';

            const root = host.attachShadow({ mode: 'open' });
            const styleEl = document.createElement('style');
            styleEl.textContent = `
                ${THEME_VARS_CSS}
                :host {
                    --bar-fg: rgba(180, 189, 204, 0.82);
                    --bar-fg-hover: rgba(235, 238, 245, 0.96);
                    --bar-icon: rgba(164, 173, 190, 0.78);
                    --bar-ring-track: rgba(255, 255, 255, 0.16);
                    --bar-ring-normal: rgba(210, 218, 230, 0.85);
                }
                :host([data-theme="light"]) {
                    --bar-fg: rgba(100, 108, 122, 0.88);
                    --bar-fg-hover: rgba(23, 27, 36, 0.94);
                    --bar-icon: rgba(114, 122, 136, 0.82);
                    --bar-ring-track: rgba(15, 23, 42, 0.15);
                    --bar-ring-normal: rgba(75, 85, 99, 0.86);
                }
                :host([data-level="normal"]) { --bar-ring-stroke: var(--bar-ring-normal); }
                :host([data-level="warn"]) { --bar-ring-stroke: var(--ctx-warn); }
                :host([data-level="danger"]) { --bar-ring-stroke: var(--ctx-danger); }
                :host([data-level="idle"]) { --bar-ring-stroke: var(--ctx-idle); }
                :host([data-compact="hidden"]) { display: none !important; }
                .ctx-wrap {
                    display: inline-flex;
                    justify-content: center;
                    align-items: center;
                    max-width: 100%;
                }
                .status-bar {
                    appearance: none;
                    border: 0;
                    margin: 0;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 12px;
                    height: 24px;
                    padding: 0 8px;
                    border-radius: 999px;
                    background: transparent;
                    color: var(--bar-fg);
                    font: inherit;
                    font-size: 11.5px;
                    font-weight: 450;
                    line-height: 1;
                    font-variant-numeric: tabular-nums;
                    cursor: pointer;
                    user-select: none;
                    white-space: nowrap;
                    transition: background-color 140ms ease, color 140ms ease;
                }
                .status-bar:hover,
                .status-bar[aria-expanded="true"] {
                    background: var(--ctx-pill-hover);
                    color: var(--bar-fg-hover);
                }
                .status-bar:active { background: var(--ctx-pill-active); }
                .status-bar:focus-visible {
                    outline: 1.5px solid var(--ctx-accent);
                    outline-offset: 1px;
                }
                .bar-item {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    min-width: 0;
                }
                .bar-icon {
                    width: 14px;
                    height: 14px;
                    flex: none;
                    display: block;
                    color: var(--bar-icon);
                }
                .bar-ring-track {
                    fill: none;
                    stroke: var(--bar-ring-track);
                    stroke-width: 1.8;
                }
                .bar-ring-arc {
                    fill: none;
                    stroke: var(--bar-ring-stroke, var(--bar-ring-normal));
                    stroke-width: 1.8;
                    stroke-linecap: round;
                    transition: stroke-dasharray 240ms cubic-bezier(0.22, 1, 0.36, 1), stroke 180ms ease;
                }
                :host([data-running="true"]) .speed-icon {
                    color: var(--ctx-accent);
                    animation: agCtxPulse 1.3s ease-in-out infinite;
                }
                :host([data-quota-level="warn"]) #bar-quota-item { color: var(--ctx-warn); }
                :host([data-quota-level="warn"]) #bar-quota-item .bar-icon { color: var(--ctx-warn); }
                :host([data-quota-level="danger"]) #bar-quota-item { color: var(--ctx-danger); }
                :host([data-quota-level="danger"]) #bar-quota-item .bar-icon { color: var(--ctx-danger); }
                :host([data-compact="narrow"]) .status-bar {
                    gap: 9px;
                    font-size: 11px;
                    padding: 0 6px;
                }
                :host([data-compact="narrow"]) .cache-label { display: none; }
                :host([data-compact="minimal"]) .status-bar {
                    gap: 8px;
                    font-size: 11px;
                    padding: 0 5px;
                }
                :host([data-compact="minimal"]) #bar-cache-item { display: none; }
                :host([data-compact="tiny"]) .status-bar {
                    gap: 7px;
                    font-size: 11px;
                    padding: 0 4px;
                }
                :host([data-compact="tiny"]) #bar-cache-item,
                :host([data-compact="tiny"]) #bar-speed-item { display: none; }
                @keyframes agCtxPulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.45; }
                }
            `;

            const speedIcon = svgEl(
                'svg',
                { class: 'bar-icon speed-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
                svgEl('path', { d: 'M2.75 11.25a6 6 0 1 1 10.5 0' }),
                svgEl('path', { d: 'M8 9.2l2.6-3.1' }),
                svgEl('circle', { cx: '8', cy: '9.5', r: '1.1', fill: 'currentColor', stroke: 'none' })
            );

            const cacheIcon = svgEl(
                'svg',
                { class: 'bar-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
                svgEl('ellipse', { cx: '8', cy: '3.8', rx: '4.8', ry: '1.9' }),
                svgEl('path', { d: 'M3.2 3.8v4.2c0 1.05 2.15 1.9 4.8 1.9s4.8-.85 4.8-1.9V3.8' }),
                svgEl('path', { d: 'M3.2 8v4.2c0 1.05 2.15 1.9 4.8 1.9s4.8-.85 4.8-1.9V8' })
            );

            const ringIcon = svgEl(
                'svg',
                { class: 'bar-icon', viewBox: '0 0 14 14', 'aria-hidden': 'true' },
                svgEl('circle', { class: 'bar-ring-track', cx: '7', cy: '7', r: String(BAR_RING_R) }),
                svgEl('circle', {
                    class: 'bar-ring-arc',
                    id: 'mini-arc',
                    cx: '7',
                    cy: '7',
                    r: String(BAR_RING_R),
                    'stroke-dasharray': `0 ${BAR_RING_C.toFixed(2)}`,
                    transform: 'rotate(-90 7 7)',
                })
            );

            const quotaIcon = svgEl(
                'svg',
                { class: 'bar-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
                svgEl('path', { d: 'M9 1.75L3.75 8.75h4L7 14.25l5.25-7h-4L9 1.75z' })
            );

            const trigger = h(
                'button',
                {
                    type: 'button',
                    class: 'status-bar',
                    id: 'ctx-trigger',
                    'aria-label': '模型速率、缓存命中、上下文窗口与模型额度',
                    'aria-expanded': 'false',
                },
                h('span', { class: 'bar-item', id: 'bar-speed-item' }, speedIcon, h('span', { id: 'bar-tps' }, '-- tok/s')),
                h('span', { class: 'bar-item', id: 'bar-cache-item' }, cacheIcon, h('span', { class: 'cache-label' }, '缓存命中 '), h('span', { id: 'bar-cache' }, '--')),
                h('span', { class: 'bar-item', id: 'bar-ctx-item' }, ringIcon, h('span', { id: 'mini-pct' }, '--%')),
                h('span', { class: 'bar-item', id: 'bar-quota-item' }, quotaIcon, h('span', { id: 'bar-quota' }, '余 --'))
            );

            const wrap = h('div', { class: 'ctx-wrap', 'data-ag-localization-skip': 'true' }, trigger);
            root.appendChild(styleEl);
            root.appendChild(wrap);

            const inst = {
                box: comp.box,
                comp,
                host,
                root,
                barRingC: BAR_RING_C,
                speedHost: null,
                speedRoot: null,
                conversationId: null,
                latestPayload: null,
                lastFetchAt: 0,
                lastToolbarWidth: -1,
                isFetching: false,
                fetchEpoch: 0,
                resizeObserver: null,
            };

            bindCardTrigger(inst, trigger, 'ring');
            root.addEventListener('pointerdown', (e) => e.stopPropagation());
            root.addEventListener('click', (e) => e.stopPropagation());

            return inst;
        }

        function ensureInstanceUi(inst, comp) {
            inst.comp = comp;
            const { host } = inst;

            let ringMoved = false;
            const parent = comp.mountParent;
            const targetBefore = comp.beforeNode && comp.beforeNode.parentElement === parent ? comp.beforeNode : null;
            const targetAfter = comp.afterNode && comp.afterNode.parentElement === parent ? comp.afterNode : null;
            if (targetBefore) {
                if (host.parentElement !== parent || host.nextElementSibling !== targetBefore) {
                    parent.insertBefore(host, targetBefore);
                    ringMoved = true;
                }
            } else if (targetAfter) {
                if (host.parentElement !== parent || host.previousElementSibling !== targetAfter) {
                    parent.insertBefore(host, targetAfter.nextSibling);
                    ringMoved = true;
                }
            } else if (host.parentElement !== parent) {
                parent.appendChild(host);
                ringMoved = true;
            }
            if (ringMoved || !inst.resizeObserver) {
                observeToolbar(inst, comp);
            }
            return Boolean(ringMoved);
        }

        function bindCardTrigger(inst, btn, anchorName) {
            btn.addEventListener('pointerenter', () => {
                clearTimeout(closeTimer);
                if (pinnedOpen) return;
                hoverTimer = setTimeout(() => {
                    activeInst = inst;
                    activeAnchor = anchorName;
                    hoverOpen = true;
                    renderPortalCard(inst);
                    updateCardVisibility();
                    if (Date.now() - inst.lastFetchAt >= 5000) {
                        void refreshInstance(inst, true);
                    }
                }, 220);
            });
            btn.addEventListener('pointerleave', () => {
                clearTimeout(hoverTimer);
                scheduleHoverClose();
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                clearTimeout(hoverTimer);
                clearTimeout(closeTimer);
                if (pinnedOpen && activeInst === inst && activeAnchor === anchorName) {
                    pinnedOpen = false;
                    hoverOpen = false;
                } else {
                    activeInst = inst;
                    activeAnchor = anchorName;
                    pinnedOpen = true;
                    renderPortalCard(inst);
                    if (Date.now() - inst.lastFetchAt >= 5000) {
                        void refreshInstance(inst, true);
                    }
                }
                updateCardVisibility();
            });
        }

        function closeCard() {
            pinnedOpen = false;
            hoverOpen = false;
            updateCardVisibility();
        }

        function scheduleHoverClose() {
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                hoverOpen = false;
                updateCardVisibility();
            }, 160);
        }

        function getActiveAnchorTrigger() {
            if (!activeInst) return { mode: 'ring', el: null };
            return {
                mode: 'ring',
                el: activeInst.root.getElementById('ctx-trigger'),
            };
        }

        function updateCardVisibility(skipFetch = false) {
            ensureCardPortal();
            const card = cardRoot ? cardRoot.getElementById('ctx-card') : null;
            if (!card) return;
            const anchor = getActiveAnchorTrigger();
            const canShow = Boolean(
                activeInst &&
                activeInst.host.isConnected &&
                anchor.el &&
                activeInst.host.getAttribute('data-compact') !== 'hidden'
            );
            const open = Boolean((pinnedOpen || hoverOpen) && canShow);

            for (const inst of instances.values()) {
                const isThisInst = open && inst === activeInst;
                inst.root.getElementById('ctx-trigger').setAttribute('aria-expanded', String(isThisInst));
            }

            card.hidden = !open;
            if (open) {
                renderPortalCard(activeInst);
                positionCard();
            }
        }

        function positionCard() {
            if (!cardRoot) return;
            const card = cardRoot.getElementById('ctx-card');
            if (!card || card.hidden) return;
            const anchor = getActiveAnchorTrigger();
            if (!anchor.el || !anchor.el.isConnected) {
                card.hidden = true;
                return;
            }
            const tr = anchor.el.getBoundingClientRect();
            const cw = card.offsetWidth || 318;
            const ch = card.offsetHeight || 205;
            const anchorW = Math.min(cw, 318);
            const idealLeft = tr.left + (tr.width - anchorW) / 2;
            const left = Math.min(Math.max(8, idealLeft), Math.max(8, window.innerWidth - cw - 8));
            let top = tr.top - ch - 8;
            if (top < 8) {
                top = Math.min(Math.max(8, window.innerHeight - ch - 8), tr.bottom + 8);
            }
            card.style.left = `${Math.round(left)}px`;
            card.style.top = `${Math.round(top)}px`;
        }

        function observeToolbar(inst, comp) {
            if (inst.resizeObserver) inst.resizeObserver.disconnect();
            if (typeof ResizeObserver !== 'function') return;
            inst.resizeObserver = new ResizeObserver(() => {
                fitInstanceLayout(inst);
                if (inst === activeInst) positionCard();
            });
            if (comp.toolbar) inst.resizeObserver.observe(comp.toolbar);
            if (comp.mountParent && comp.mountParent !== comp.toolbar) {
                inst.resizeObserver.observe(comp.mountParent);
            }
        }

        function fitInstanceLayout(inst) {
            const { host, comp } = inst;
            if (!host || !comp || !comp.toolbar || !comp.toolbar.isConnected) return;
            const dark = detectDarkTheme(comp.box);
            const prevHostCompact = host.getAttribute('data-compact') || '';
            host.setAttribute('data-theme', dark ? 'dark' : 'light');
            host.removeAttribute('data-compact');

            const tbWidth = comp.toolbar.clientWidth || 0;
            inst.lastToolbarWidth = tbWidth;
            const leftOverflow = () => Boolean(comp.leftGroup && comp.leftGroup.isConnected && comp.leftGroup.scrollWidth > comp.leftGroup.clientWidth + 2);

            let nextHostCompact = '';
            if ((tbWidth > 0 && tbWidth < 590) || leftOverflow()) {
                nextHostCompact = 'narrow';
                host.setAttribute('data-compact', 'narrow');
                if ((tbWidth > 0 && tbWidth < 460) || leftOverflow()) {
                    nextHostCompact = 'minimal';
                    host.setAttribute('data-compact', 'minimal');
                    if ((tbWidth > 0 && tbWidth < 350) || leftOverflow()) {
                        nextHostCompact = 'tiny';
                        host.setAttribute('data-compact', 'tiny');
                        if ((tbWidth > 0 && tbWidth < 250) || leftOverflow()) {
                            nextHostCompact = 'hidden';
                            host.setAttribute('data-compact', 'hidden');
                        }
                    }
                }
            }

            if (inst === activeInst && (pinnedOpen || hoverOpen)) {
                if (prevHostCompact !== nextHostCompact) {
                    updateCardVisibility(true);
                } else {
                    positionCard();
                }
            }
        }

        function computeStatusState(payload) {
            const ctx = payload && payload.context;
            const hasRatio = Boolean(ctx && typeof ctx.usedFraction === 'number' && Number.isFinite(ctx.usedFraction));
            const ratio = hasRatio ? Math.max(0, ctx.usedFraction) : 0;
            const clampedRatio = Math.min(1, ratio);

            let level = 'idle';
            let badgeText = '待采样';
            if (payload && payload.status === 'offline') {
                badgeText = '等待服务';
            } else if (ctx && !hasRatio) {
                badgeText = '容量未知';
            } else if (hasRatio) {
                if (ratio >= 0.9) { level = 'danger'; badgeText = '接近上限'; }
                else if (ratio >= 0.7) { level = 'warn'; badgeText = '占用偏高'; }
                else { level = 'normal'; badgeText = '正常'; }
            }
            return { ctx, hasRatio, ratio, clampedRatio, level, badgeText };
        }

        function formatPct(fraction) {
            if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0) return '0.0%';
            if (fraction < 0.0005) return '<0.1%';
            return `${(fraction * 100).toFixed(1)}%`;
        }

        function replaceChildrenSafe(parent, nodes) {
            if (!parent) return;
            while (parent.firstChild) parent.removeChild(parent.firstChild);
            for (const n of nodes) parent.appendChild(n);
        }

        function renderBreakdownSection(inst) {
            if (!cardRoot) return;
            const breakdownEl = cardRoot.getElementById('card-breakdown');
            const toggleBtn = cardRoot.getElementById('card-breakdown-toggle');
            const toggleText = cardRoot.getElementById('bd-toggle-text');
            const barEl = cardRoot.getElementById('bd-bar');
            const catListEl = cardRoot.getElementById('bd-categories');
            const noteEl = cardRoot.getElementById('bd-note');
            if (!breakdownEl || !toggleBtn) return;

            const bd = inst && inst.latestPayload ? inst.latestPayload.breakdown : null;
            toggleBtn.setAttribute('aria-expanded', String(breakdownOpen));
            if (toggleText) {
                toggleText.textContent = '构成';
            }

            breakdownEl.hidden = !breakdownOpen;
            if (!breakdownOpen) return;

            const denom = bd && typeof bd.denomTokens === 'number' ? bd.denomTokens : 0;
            const segs = [];
            const catRows = [];
            const categories = bd && Array.isArray(bd.categories) ? bd.categories : [];
            for (const cat of categories) {
                const tokStr = formatCompactTokens(cat.tokens);
                const pctStr = cat.fraction === null || cat.fraction === undefined ? '—' : formatPct(cat.fraction);
                const title = `${cat.label}: ${formatExactTokens(cat.tokens)}${pctStr !== '—' ? ` · ${pctStr}` : ''}`;
                const frac = typeof cat.fraction === 'number'
                    ? cat.fraction
                    : (denom > 0 && typeof cat.tokens === 'number' ? cat.tokens / denom : 0);
                if (denom > 0 && typeof cat.tokens === 'number' && cat.tokens > 0 && frac > 0) {
                    const pct = Math.min(100, Math.max(0, frac * 100));
                    segs.push(
                        h('span', {
                            class: 'bd-seg',
                            title,
                            'data-free': cat.isFree ? 'true' : undefined,
                            style: `width:${pct.toFixed(2)}%;${cat.isFree ? '' : `background:${cat.color || '#64748b'};`}`,
                        })
                    );
                }
                catRows.push(
                    h(
                        'div',
                        { class: 'bd-row', title, 'data-free': cat.isFree ? 'true' : undefined },
                        h('span', { class: 'bd-dot', style: `background:${cat.color || '#64748b'}` }),
                        h('span', { class: 'bd-name' }, cat.label || cat.key),
                        h('span', { class: 'bd-tokens' }, tokStr),
                        h('span', { class: 'bd-pct' }, pctStr)
                    )
                );
            }
            if (barEl) {
                replaceChildrenSafe(barEl, segs);
                barEl.hidden = segs.length === 0;
            }
            replaceChildrenSafe(catListEl, catRows);

            if (noteEl) {
                if (!bd) {
                    noteEl.hidden = false;
                    noteEl.textContent = '等待首个请求后展示分类构成';
                } else if (categories.length === 0) {
                    noteEl.hidden = false;
                    noteEl.textContent = '暂无可拆分的构成数据';
                } else {
                    noteEl.hidden = true;
                    noteEl.textContent = '';
                }
            }
        }

        function getQuotaLevel(remFrac) {
            if (typeof remFrac !== 'number' || !Number.isFinite(remFrac)) return 'idle';
            if (remFrac <= 0.1) return 'danger';
            if (remFrac <= 0.3) return 'warn';
            return 'ok';
        }

        function formatResetSubtext(resetTime) {
            if (!resetTime) return '';
            const ts = Date.parse(resetTime);
            if (!Number.isFinite(ts)) return '';
            const diffMs = ts - Date.now();
            if (diffMs <= 0) return '不足1分后重置';
            const totalMins = Math.floor(diffMs / 60000);
            const days = Math.floor(totalMins / 1440);
            const hours = Math.floor((totalMins % 1440) / 60);
            const mins = totalMins % 60;
            if (days > 0) return hours > 0 ? `${days}天${hours}时后重置` : `${days}天后重置`;
            if (hours > 0) return mins > 0 ? `${hours}时${mins}分后重置` : `${hours}小时后重置`;
            return mins > 0 ? `${mins}分后重置` : '不足1分后重置';
        }

        function readDomSelectedModelText(inst) {
            const lg = inst && inst.comp && inst.comp.leftGroup;
            if (!lg || !lg.isConnected) return '';
            const trigger = lg.querySelector('[data-testid="model-selector-trigger"]');
            if (trigger && trigger.textContent) return trigger.textContent.replace(/\s+/g, ' ').trim();
            const btns = Array.from(lg.querySelectorAll('button'));
            for (const b of btns) {
                const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
                if (/gemini|claude|gpt|orchestrator/i.test(txt)) return txt;
            }
            return '';
        }

        function resolveActiveQuotaSummary(inst, quota) {
            if (!quota) return null;
            const domModel = readDomSelectedModelText(inst);
            const groups = Array.isArray(quota.groups) ? quota.groups : [];
            if (domModel && groups.length > 0) {
                const low = domModel.toLowerCase();
                let grp = null;
                if (/argon/i.test(low)) grp = groups.find((g) => /argon/i.test(g.displayName));
                else if (/claude|gpt|openai/i.test(low)) grp = groups.find((g) => /claude|gpt/i.test(g.displayName));
                else if (/gemini|orchestrator/i.test(low)) grp = groups.find((g) => /gemini models/i.test(g.displayName)) || groups.find((g) => /gemini/i.test(g.displayName));
                if (grp && Array.isArray(grp.buckets) && grp.buckets.length > 0) {
                    const b = grp.buckets.reduce((m, cur) => (cur.remainingFraction < m.remainingFraction ? cur : m), grp.buckets[0]);
                    return {
                        label: domModel,
                        groupName: grp.displayName,
                        windowLabel: b.windowLabel,
                        remainingFraction: b.remainingFraction,
                        usedFraction: b.usedFraction,
                        resetTime: b.resetTime,
                    };
                }
            }
            if (quota.current && typeof quota.current.remainingFraction === 'number') {
                return quota.current;
            }
            if (groups.length > 0 && Array.isArray(groups[0].buckets) && groups[0].buckets.length > 0) {
                const grp = groups[0];
                const b = grp.buckets.reduce((m, cur) => (cur.remainingFraction < m.remainingFraction ? cur : m), grp.buckets[0]);
                return {
                    label: grp.displayName,
                    groupName: grp.displayName,
                    windowLabel: b.windowLabel,
                    remainingFraction: b.remainingFraction,
                    usedFraction: b.usedFraction,
                    resetTime: b.resetTime,
                };
            }
            return null;
        }

        function renderQuotaSection(inst) {
            if (!cardRoot) return;
            const sectionEl = cardRoot.getElementById('card-quota-section');
            const groupsEl = cardRoot.getElementById('card-quota-groups');
            if (!sectionEl || !groupsEl) return;

            const quota = inst && inst.latestPayload ? inst.latestPayload.quota : null;
            const groups = quota && Array.isArray(quota.groups) ? quota.groups : [];
            if (!groups.length) {
                sectionEl.hidden = true;
                replaceChildrenSafe(groupsEl, []);
                return;
            }

            const activeQ = resolveActiveQuotaSummary(inst, quota);
            const activeGroupName = activeQ ? activeQ.groupName : '';
            const Q_RING_R = 6;
            const Q_RING_C = 2 * Math.PI * Q_RING_R;

            const groupNodes = [];
            for (const g of groups) {
                const isCur = activeGroupName ? g.displayName === activeGroupName : Boolean(g.isCurrent);
                const headChildren = [h('span', null, g.displayName)];
                if (isCur) headChildren.push(h('span', { class: 'quota-group-dot', title: '当前对话模型所属分组' }));

                const bucketNodes = [];
                for (const b of (g.buckets || [])) {
                    const rem = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
                        ? Math.min(1, Math.max(0, b.remainingFraction))
                        : 0;
                    const usedPct = ((1 - rem) * 100).toFixed(1);
                    const remPctExact = (rem * 100).toFixed(1);
                    const remPctInt = Math.round(rem * 100);
                    const qLevel = getQuotaLevel(rem);
                    const showReset = Boolean(b.hasDescription || rem < 0.999);
                    const resetText = showReset ? formatResetSubtext(b.resetTime) : '';
                    const rowTitle = `${g.displayName} · ${b.windowLabel}：已用 ${usedPct}% / 剩余 ${remPctExact}%${resetText ? `（${resetText}）` : ''}`;

                    const ringSvg = svgEl(
                        'svg',
                        { class: 'quota-ring', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                        svgEl('circle', { class: 'quota-ring-track', cx: '8', cy: '8', r: String(Q_RING_R) }),
                        svgEl('circle', {
                            class: 'quota-ring-arc',
                            'data-qlevel': qLevel,
                            cx: '8',
                            cy: '8',
                            r: String(Q_RING_R),
                            'stroke-dasharray': `${(Q_RING_C * rem).toFixed(2)} ${Q_RING_C.toFixed(2)}`,
                            transform: 'rotate(-90 8 8)',
                        })
                    );

                    const leftChildren = [h('span', { class: 'quota-bucket-label' }, b.windowLabel || '模型额度')];
                    if (resetText) leftChildren.push(h('span', { class: 'quota-bucket-reset' }, `· ${resetText}`));

                    bucketNodes.push(
                        h(
                            'div',
                            { class: 'quota-bucket-row', title: rowTitle },
                            h('div', { class: 'quota-bucket-left' }, ...leftChildren),
                            h(
                                'div',
                                { class: 'quota-bucket-right' },
                                h('span', { class: 'quota-bucket-pct', 'data-qlevel': qLevel }, `剩余 ${remPctInt}%`),
                                ringSvg
                            )
                        )
                    );
                }

                if (bucketNodes.length > 0) {
                    groupNodes.push(
                        h(
                            'div',
                            { class: 'quota-group', title: g.description || g.displayName },
                            h('div', { class: 'quota-group-head' }, ...headChildren),
                            ...bucketNodes
                        )
                    );
                }
            }

            replaceChildrenSafe(groupsEl, groupNodes);
            sectionEl.hidden = groupNodes.length === 0;
        }

        function renderPortalCard(inst) {
            ensureCardPortal();
            if (!cardPortal || !cardRoot || !inst) return;
            const dark = detectDarkTheme(inst.box);
            const payload = inst.latestPayload;
            const { ctx, hasRatio, ratio, clampedRatio, level, badgeText } = computeStatusState(payload);

            cardPortal.setAttribute('data-theme', dark ? 'dark' : 'light');
            cardPortal.setAttribute('data-level', level);

            const pctDetail = hasRatio ? `${(ratio * 100).toFixed(1)}%` : '--';
            cardRoot.getElementById('big-arc').setAttribute('stroke-dasharray', `${(BIG_ARC * clampedRatio).toFixed(2)} ${BIG_C.toFixed(2)}`);
            cardRoot.getElementById('card-pct').textContent = pctDetail;
            cardRoot.getElementById('card-badge').textContent = badgeText;

            const usedEl = cardRoot.getElementById('card-used');
            const remEl = cardRoot.getElementById('card-rem');
            const maxEl = cardRoot.getElementById('card-max');
            const modelEl = cardRoot.getElementById('card-model');
            const tpsEl = cardRoot.getElementById('card-tps');
            const cacheLastEl = cardRoot.getElementById('card-cache-last');
            const cacheTotalEl = cardRoot.getElementById('card-cache-total');

            if (ctx) {
                usedEl.textContent = formatCompactTokens(ctx.usedTokens);
                usedEl.title = formatExactTokens(ctx.usedTokens);
                remEl.textContent = ctx.remainingTokens === null ? '—' : formatCompactTokens(ctx.remainingTokens);
                remEl.title = ctx.remainingTokens === null ? '' : formatExactTokens(ctx.remainingTokens);
                maxEl.textContent = ctx.maxTokens === null ? '不可用' : formatCompactTokens(ctx.maxTokens);
                maxEl.title = ctx.maxTokens === null ? '' : formatExactTokens(ctx.maxTokens);
                modelEl.textContent = ctx.model || '—';
                modelEl.title = ctx.model || '';
            } else {
                usedEl.textContent = '—';
                usedEl.title = '';
                remEl.textContent = '—';
                remEl.title = '';
                maxEl.textContent = '—';
                maxEl.title = '';
                modelEl.textContent = '—';
                modelEl.title = '';
            }

            const isRunning = Boolean(payload && payload.running);
            const speedView = formatSpeedView(payload && payload.speed, isRunning);
            tpsEl.textContent = speedView.tpsText;
            tpsEl.title = speedView.tpsTitle;

            const cache = payload && payload.cache;
            const lastStat = formatCacheStat(cache && cache.latest);
            const totalStat = formatCacheStat(cache && cache.session, cache && cache.session && cache.session.requests);
            cacheLastEl.textContent = lastStat.text;
            cacheLastEl.title = lastStat.title;
            cacheTotalEl.textContent = totalStat.text;
            cacheTotalEl.title = totalStat.title;

            renderBreakdownSection(inst);
            renderQuotaSection(inst);
        }

        function renderInstance(inst) {
            const { host, root, barRingC } = inst;
            const dark = detectDarkTheme(inst.box);
            const payload = inst.latestPayload;
            const { hasRatio, ratio, clampedRatio, level } = computeStatusState(payload);
            const isRunning = Boolean(payload && payload.running);

            host.setAttribute('data-theme', dark ? 'dark' : 'light');
            host.setAttribute('data-level', level);
            host.setAttribute('data-running', String(isRunning));

            const miniArc = root.getElementById('mini-arc');
            miniArc.setAttribute('stroke-dasharray', `${(barRingC * clampedRatio).toFixed(2)} ${barRingC.toFixed(2)}`);

            const pctShort = hasRatio ? `${Math.round(ratio * 100)}%` : '--%';
            const pctDetail = hasRatio ? `${(ratio * 100).toFixed(1)}%` : '--%';
            root.getElementById('mini-pct').textContent = pctShort;

            const speedView = formatSpeedView(payload && payload.speed, isRunning);
            root.getElementById('bar-tps').textContent = speedView.mainText;

            const cache = payload && payload.cache;
            const cacheEntry = (cache && cache.latest && typeof cache.latest.hitRate === 'number')
                ? cache.latest
                : (cache && cache.session && typeof cache.session.hitRate === 'number' ? cache.session : null);
            const cachePctText = cacheEntry && Number.isFinite(cacheEntry.hitRate)
                ? `${(cacheEntry.hitRate * 100).toFixed(cacheEntry.hitRate >= 0.9995 || cacheEntry.hitRate === 0 ? 0 : 1)}%`
                : '--';
            root.getElementById('bar-cache').textContent = cachePctText;

            const activeQuota = resolveActiveQuotaSummary(inst, payload && payload.quota);
            const quotaEl = root.getElementById('bar-quota');
            if (activeQuota && typeof activeQuota.remainingFraction === 'number') {
                const remInt = Math.round(activeQuota.remainingFraction * 100);
                const qLevel = getQuotaLevel(activeQuota.remainingFraction);
                host.setAttribute('data-quota-level', qLevel);
                if (quotaEl) quotaEl.textContent = `余 ${remInt}%`;
            } else {
                host.removeAttribute('data-quota-level');
                if (quotaEl) quotaEl.textContent = '余 --';
            }

            const quotaAria = activeQuota && typeof activeQuota.remainingFraction === 'number'
                ? ` · ${activeQuota.groupName || '额度'} ${activeQuota.windowLabel || ''} 剩余 ${Math.round(activeQuota.remainingFraction * 100)}%`
                : '';
            root.getElementById('ctx-trigger').setAttribute(
                'aria-label',
                `${speedView.mainText} · 缓存命中 ${cachePctText} · 上下文 ${pctDetail}${quotaAria}`
            );

            fitInstanceLayout(inst);
            if (inst === activeInst && (pinnedOpen || hoverOpen)) {
                renderPortalCard(inst);
                positionCard();
            }
        }

        async function refreshInstance(inst, force = false) {
            if (inst.isFetching) {
                return;
            }
            const convId = inst.conversationId;
            const myEpoch = inst.fetchEpoch;
            inst.isFetching = true;
            inst.lastFetchAt = Date.now();
            try {
                const res = await window.__agCtxBridge.getMetrics(convId || null, force);
                if (myEpoch !== inst.fetchEpoch || convId !== inst.conversationId) return;
                inst.latestPayload = res || { status: convId ? 'error' : 'new', running: false, conversationId: convId || null, context: null, cache: null, speed: null, breakdown: null, quota: null };
                renderInstance(inst);
            } catch {
                // 保持已有显示，待下一轮自动重连
            } finally {
                if (myEpoch === inst.fetchEpoch) {
                    inst.isFetching = false;
                }
            }
        }

        function sync() {
            const comps = findAllComposers();
            const seen = new Set(comps.map((c) => c.box));

            for (const [box, inst] of instances.entries()) {
                if (seen.has(box)) continue;
                if (inst.resizeObserver) inst.resizeObserver.disconnect();
                if (inst.host.isConnected) inst.host.remove();
                if (inst.speedHost && inst.speedHost.isConnected) inst.speedHost.remove();
                instances.delete(box);
                if (activeInst === inst) {
                    activeInst = null;
                    closeCard();
                }
            }

            if (!comps.length) return;
            ensureCardPortal();

            for (const comp of comps) {
                let inst = instances.get(comp.box);
                const isNew = !inst;
                if (isNew) {
                    inst = createInstance(comp);
                    instances.set(comp.box, inst);
                }
                const moved = ensureInstanceUi(inst, comp);
                const nextId = resolveConversationId(comp);
                const nextDomModel = readDomSelectedModelText(inst);
                if (isNew || nextId !== inst.conversationId) {
                    inst.conversationId = nextId;
                    inst.lastDomModel = nextDomModel;
                    inst.fetchEpoch++;
                    inst.latestPayload = null;
                    inst.lastFetchAt = 0;
                    inst.lastToolbarWidth = -1;
                    inst.isFetching = false;
                    renderInstance(inst);
                    void refreshInstance(inst, true);
                } else if (nextDomModel !== inst.lastDomModel) {
                    inst.lastDomModel = nextDomModel;
                    renderInstance(inst);
                    void refreshInstance(inst, false);
                } else if (moved || (comp.toolbar && comp.toolbar.clientWidth !== inst.lastToolbarWidth)) {
                    fitInstanceLayout(inst);
                }
            }
        }

        function scheduleSync() {
            if (layoutScheduled) return;
            layoutScheduled = true;
            requestAnimationFrame(() => {
                layoutScheduled = false;
                sync();
            });
        }

        function isOwnUiTarget(target) {
            if (cardPortal && (target === cardPortal || cardPortal.contains(target))) return true;
            for (const inst of instances.values()) {
                if (target === inst.host || inst.host.contains(target)) return true;
                if (inst.speedHost && (target === inst.speedHost || inst.speedHost.contains(target))) return true;
            }
            return false;
        }

        const domObserver = new MutationObserver((records) => {
            if (records.some((r) => !isOwnUiTarget(r.target))) {
                scheduleSync();
            }
        });
        domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'inert', 'data-cascade-id', 'data-testid'],
        });

        document.addEventListener('pointerdown', () => {
            if (pinnedOpen || hoverOpen) closeCard();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && (pinnedOpen || hoverOpen)) closeCard();
        });
        document.addEventListener('focusin', scheduleSync);
        window.addEventListener('resize', () => {
            for (const inst of instances.values()) {
                fitInstanceLayout(inst);
            }
            positionCard();
        });

        const triggerForegroundRefresh = () => {
            if (document.hidden) return;
            const now = Date.now();
            for (const inst of instances.values()) {
                if (now - inst.lastFetchAt >= 15000) {
                    void refreshInstance(inst, false);
                }
            }
        };
        document.addEventListener('visibilitychange', triggerForegroundRefresh);
        window.addEventListener('focus', triggerForegroundRefresh);

        setInterval(() => {
            sync();
            const now = Date.now();
            for (const inst of instances.values()) {
                const interval = document.hidden ? 10000 : (inst.latestPayload && inst.latestPayload.running ? 1100 : 2200);
                if (now - inst.lastFetchAt >= interval) {
                    void refreshInstance(inst, false);
                }
            }
        }, 1000);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', sync, { once: true });
        } else {
            sync();
        }
    }

    const RENDERER_INJECT_SOURCE = `'use strict';(${rendererBootstrap.toString()})();`;

    function isTargetHubWebContents(wc) {
        if (!wc || wc.isDestroyed()) return false;
        const wcType = typeof wc.getType === 'function' ? wc.getType() : '';
        if (wcType === 'webview' || wcType === 'devtools' || wcType === 'remote' || wcType === 'offscreen' || wcType === 'backgroundPage') {
            return false;
        }
        if (hubUtils && typeof hubUtils.getLocalHubWindows === 'function' && typeof hubUtils.getHubWebContents === 'function') {
            try {
                const hubWins = hubUtils.getLocalHubWindows();
                if (Array.isArray(hubWins) && hubWins.length > 0) {
                    return hubWins.some((w) => hubUtils.getHubWebContents(w) === wc);
                }
            } catch {}
        }
        return true;
    }

    function injectIntoWebContents(wc) {
        if (!isTargetHubWebContents(wc)) return;
        const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
        if (!LOCAL_ORIGIN_RE.test(url)) return;
        Promise.resolve(wc.executeJavaScript(RENDERER_INJECT_SOURCE, false)).catch((err) => {
            if (err && err.message) {
                console.warn('[ag-ctx-monitor] renderer inject failed:', err.message);
            }
        });
    }

    app.on('web-contents-created', (_event, wc) => {
        wc.on('dom-ready', () => injectIntoWebContents(wc));
        wc.on('did-finish-load', () => injectIntoWebContents(wc));
    });

    try {
        const list = typeof webContents?.getAllWebContents === 'function'
            ? webContents.getAllWebContents()
            : BrowserWindow.getAllWindows().map((w) => !w.isDestroyed() && w.webContents).filter(Boolean);
        for (const wc of list) {
            injectIntoWebContents(wc);
        }
    } catch {}
})();
