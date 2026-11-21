#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const vm = require('vm');

if (process.platform === 'win32') {
    const defaultNodePaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'node'),
        path.join(process.env.APPDATA || '', 'npm')
    ];
    for (const nodePath of defaultNodePaths) {
        if (fs.existsSync(nodePath) && !process.env.PATH.includes(nodePath)) {
            process.env.PATH = `${nodePath};${process.env.PATH}`;
        }
    }
}

const MONITOR_START = "'__AG_CTX_MONITOR_START__';";
const MONITOR_END = "'__AG_CTX_MONITOR_END__';";
const BRIDGE_START = "'__AG_CTX_BRIDGE_START__';";
const BRIDGE_END = "'__AG_CTX_BRIDGE_END__';";

function removeMarkedBlocks(content, startMark, endMark) {
    let cleaned = content;
    let startIdx = cleaned.indexOf(startMark);
    while (startIdx !== -1) {
        const endIdx = cleaned.indexOf(endMark, startIdx + startMark.length);
        if (endIdx === -1) break;
        cleaned = cleaned.substring(0, startIdx) + cleaned.substring(endIdx + endMark.length);
        startIdx = cleaned.indexOf(startMark);
    }
    return cleaned;
}

function sleepSync(milliseconds) {
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitArray, 0, 0, milliseconds);
}

function getPosixTargetUid() {
    const sudoUidText = String(process.env.SUDO_UID || '');
    if (/^\d+$/.test(sudoUidText)) return Number(sudoUidText);
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function getPosixProcessTable() {
    try {
        const stdout = child_process.execFileSync(
            'ps',
            ['-eo', 'pid=,ppid=,uid=,stat=,comm=,args='],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return stdout.split(/\r?\n/).map(line => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
            if (!match) return null;
            return {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                uid: Number(match[3]),
                stat: match[4],
                comm: match[5],
                args: match[6] || ''
            };
        }).filter(Boolean);
    } catch {
        return [];
    }
}

function isPosixAntigravityMainProcess(entry, targetUid = getPosixTargetUid()) {
    if (targetUid !== null && entry.uid !== targetUid) return false;
    if (/(?:^|\s)--type(?:=|\s)/i.test(entry.args)) return false;
    const commBase = path.basename(entry.comm).toLowerCase();
    if (commBase === 'antigravity') return true;
    return /^\s*\/.*\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/i.test(entry.args);
}

function getPosixAntigravityMainProcesses(processTable = getPosixProcessTable()) {
    const targetUid = getPosixTargetUid();
    return processTable.filter(entry => isPosixAntigravityMainProcess(entry, targetUid));
}

function collectPosixProcessTreePids(processTable, rootPids) {
    const collected = new Set(rootPids);
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of processTable) {
            if (!collected.has(entry.ppid) || collected.has(entry.pid)) continue;
            collected.add(entry.pid);
            changed = true;
        }
    }
    return collected;
}

function refreshPosixProcessTree(trackedPids) {
    const processTable = getPosixProcessTable();
    const expanded = collectPosixProcessTreePids(processTable, trackedPids);
    for (const pid of expanded) trackedPids.add(pid);
    return processTable.filter(entry => trackedPids.has(entry.pid) && !entry.stat.toUpperCase().startsWith('Z'));
}

function signalPosixProcesses(processEntries, signal) {
    for (const entry of processEntries) {
        try {
            process.kill(entry.pid, signal);
        } catch (e) {
            if (e.code !== 'ESRCH') {
                console.warn(`[warn] Failed to signal pid ${entry.pid} (${entry.comm}): ${e.message}`);
            }
        }
    }
}

function waitForPosixProcessTreeExit(trackedPids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let remaining = refreshPosixProcessTree(trackedPids);
    while (remaining.length > 0 && Date.now() < deadline) {
        sleepSync(100);
        remaining = refreshPosixProcessTree(trackedPids);
    }
    return remaining;
}

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.toLowerCase().includes('antigravity.exe');
        }
        const processTable = getPosixProcessTable();
        if (processTable.length === 0) return true;
        return getPosixAntigravityMainProcesses(processTable).length > 0;
    } catch {
        return false;
    }
}

function closeAntigravityProcesses() {
    console.log('[1] Closing running Antigravity processes...');
    try {
        if (process.platform === 'win32') {
            child_process.execSync('taskkill /f /im Antigravity.exe /t >nul 2>nul');
            sleepSync(1500);
            return true;
        }
    } catch (e) {
        console.error(`[error] Failed to close Antigravity: ${e.message}`);
        return false;
    }

    const processTable = getPosixProcessTable();
    if (processTable.length === 0) {
        console.error('[error] Cannot read process list; please close Antigravity manually first.');
        return false;
    }
    const mainProcesses = getPosixAntigravityMainProcesses(processTable);
    if (mainProcesses.length === 0) return true;

    const trackedPids = collectPosixProcessTreePids(processTable, mainProcesses.map(e => e.pid));
    const mainPids = new Set(mainProcesses.map(e => e.pid));

    signalPosixProcesses(mainProcesses, 'SIGTERM');
    let remaining = waitForPosixProcessTreeExit(trackedPids, 10000);
    if (remaining.length > 0) {
        const remainingMain = remaining.filter(e => mainPids.has(e.pid));
        if (remainingMain.length > 0) {
            signalPosixProcesses(remainingMain, 'SIGTERM');
            remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
        }
    }
    if (remaining.length > 0 && !remaining.some(e => mainPids.has(e.pid))) {
        signalPosixProcesses(remaining, 'SIGTERM');
        remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
    }
    if (remaining.length > 0) {
        console.error('[error] Antigravity did not exit cleanly. Please close it manually and retry.');
        return false;
    }
    console.log('[ok] Antigravity exited cleanly.');
    return true;
}

function detectInstallationDir(manualDir, options = {}) {
    const quiet = Boolean(options && options.quiet);
    const hasAntigravityResources = (candidate) => (
        fs.existsSync(path.join(candidate, 'resources', 'app.asar')) ||
        fs.existsSync(path.join(candidate, 'resources', 'app.asar.bak')) ||
        fs.existsSync(path.join(candidate, 'app.asar')) ||
        fs.existsSync(path.join(candidate, 'app.asar.bak')) ||
        fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar')) ||
        fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar.bak'))
    );

    if (manualDir) {
        if (!fs.existsSync(manualDir)) {
            if (quiet) return null;
            console.error(`[error] Specified install path does not exist: ${manualDir}`);
            process.exit(1);
        }
        let resolved = path.resolve(manualDir);
        if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
            resolved = path.dirname(resolved);
        }
        return resolved;
    }

    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (!seen.has(key)) {
            candidates.push(normalized);
            seen.add(key);
        }
    };

    addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
    addCandidate(process.env.ANTIGRAVITY_HOME);

    if (process.platform === 'win32') {
        const localAppdata = process.env.LOCALAPPDATA;
        if (localAppdata) {
            addCandidate(path.join(localAppdata, 'Programs', 'Antigravity'));
            addCandidate(path.join(localAppdata, 'antigravity'));
        }
        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const root of registryRoots) {
            try {
                const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
                for (const line of output.split(/\r?\n/)) {
                    const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!match) continue;
                    let value = match[2].trim().replace(/^"|"$/g, '');
                    if (/Antigravity\.exe/i.test(value)) value = path.dirname(value);
                    addCandidate(value);
                }
            } catch {}
        }
        addCandidate('C:\\Program Files\\Antigravity');
        addCandidate('C:\\Program Files (x86)\\Antigravity');
    } else if (process.platform === 'darwin') {
        addCandidate('/Applications/Antigravity.app');
        if (process.env.HOME) addCandidate(path.join(process.env.HOME, 'Applications', 'Antigravity.app'));
        try {
            const mdfindOut = child_process.execSync('mdfind "kMDItemFSName == \'Antigravity.app\'" 2>/dev/null', { encoding: 'utf-8' });
            for (const line of mdfindOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.includes('/.Trash') && !trimmed.startsWith('/Volumes/')) {
                    addCandidate(trimmed);
                }
            }
        } catch {}
    } else {
        if (process.env.HOME) {
            addCandidate(path.join(process.env.HOME, '.local', 'share', 'antigravity'));
            addCandidate(path.join(process.env.HOME, '.local', 'share', 'Antigravity'));
        }
        addCandidate('/opt/antigravity');
        addCandidate('/opt/Antigravity');
        addCandidate('/usr/share/antigravity');
        addCandidate('/usr/lib/antigravity');
    }

    for (const p of candidates) {
        if (fs.existsSync(p) && hasAntigravityResources(p)) {
            if (!quiet) console.log(`[detect] Found Antigravity installation: ${p}`);
            return path.resolve(p);
        }
    }

    if (quiet) return null;
    console.error('[error] Could not locate Antigravity installation directory. Use --install-dir <path>.');
    process.exit(1);
}

function findMacAppBundle(resourcesDir) {
    if (!resourcesDir) return null;
    let current = path.resolve(resourcesDir);
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app') && fs.existsSync(current)) return current;
        current = path.dirname(current);
    }
    return null;
}

function canWriteResources(resourcesDir) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) return true;
    try {
        fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
        if (fs.existsSync(asarPath)) fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
        if (fs.existsSync(bakPath)) fs.accessSync(bakPath, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    } catch (e) {
        console.error(`[error] No write permission to ${resourcesDir}: ${e.code || e.message}`);
        console.error(process.platform === 'win32'
            ? '[hint] Right-click install.bat and choose "Run as administrator".'
            : '[hint] Try running with sudo (e.g. sudo ./install.sh).');
        return false;
    }
}

function resignAppOnMac(resourcesDir) {
    if (process.platform !== 'darwin') return true;
    let targetApp = findMacAppBundle(resourcesDir);
    if (!targetApp) return true;
    try { targetApp = fs.realpathSync(targetApp); } catch {}

    console.log(`[sign] Re-signing macOS app bundle: ${targetApp}`);
    child_process.spawnSync('xattr', ['-cr', targetApp], { stdio: 'pipe' });

    const frameworksDir = path.join(targetApp, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksDir)) {
        try {
            for (const entry of fs.readdirSync(frameworksDir)) {
                const fullPath = path.join(frameworksDir, entry);
                if (entry.endsWith('.framework') || entry.endsWith('.app')) {
                    child_process.spawnSync('codesign', ['--force', '--deep', '--sign', '-', fullPath], { stdio: 'pipe' });
                } else if (entry.endsWith('.dylib')) {
                    child_process.spawnSync('codesign', ['--force', '--sign', '-', fullPath], { stdio: 'pipe' });
                }
            }
        } catch {}
    }

    const res = child_process.spawnSync('codesign', ['--force', '--deep', '--sign', '-', targetApp], { encoding: 'utf-8', stdio: 'pipe' });
    if (res.status !== 0) {
        console.error(`[error] macOS codesign failed: ${res.stderr || res.stdout}`);
        return false;
    }
    console.log('[ok] macOS ad-hoc signing completed.');
    return true;
}

class AsarArchive {
    static align4(n) {
        return (n + 3) & ~3;
    }

    static readHeader(asarPath) {
        const fd = fs.openSync(asarPath, 'r');
        try {
            const sizeBuf = Buffer.alloc(8);
            fs.readSync(fd, sizeBuf, 0, 8, 0);
            const headerSize = sizeBuf.readUInt32LE(4);
            const headerBuf = Buffer.alloc(headerSize);
            fs.readSync(fd, headerBuf, 0, headerSize, 8);
            const jsonLen = headerBuf.readUInt32LE(4);
            const header = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'));
            return { header, baseOffset: 8 + headerSize };
        } finally {
            fs.closeSync(fd);
        }
    }

    static createHeaderBuffer(headerJson) {
        const jsonBuf = Buffer.from(headerJson, 'utf8');
        const jsonLen = jsonBuf.length;
        const alignedJsonLen = this.align4(jsonLen);
        const headerPayloadSize = 4 + alignedJsonLen;
        const headerBuf = Buffer.alloc(4 + headerPayloadSize);
        headerBuf.writeUInt32LE(headerPayloadSize, 0);
        headerBuf.writeUInt32LE(jsonLen, 4);
        jsonBuf.copy(headerBuf, 8);

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeUInt32LE(4, 0);
        sizeBuf.writeUInt32LE(headerBuf.length, 4);
        return Buffer.concat([sizeBuf, headerBuf]);
    }

    static readFile(sourceAsar, relPath) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const parts = relPath.replace(/\\/g, '/').split('/');
        let cur = header.files;
        for (const p of parts) {
            if (!cur || !cur[p]) return null;
            cur = cur[p].files ? cur[p].files : cur[p];
        }
        if (cur.unpacked) {
            const unpackedPath = path.join(`${sourceAsar}.unpacked`, ...parts);
            return fs.existsSync(unpackedPath) ? fs.readFileSync(unpackedPath) : null;
        }
        if (cur.offset === undefined || cur.size === undefined) return null;
        const fd = fs.openSync(sourceAsar, 'r');
        try {
            const buf = Buffer.alloc(cur.size);
            fs.readSync(fd, buf, 0, cur.size, baseOffset + parseInt(cur.offset, 10));
            return buf;
        } finally {
            fs.closeSync(fd);
        }
    }

    static patchArchive(sourceAsar, targetAsar, filePatches) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const srcFd = fs.openSync(sourceAsar, 'r');
        let destFd = null;
        try {
            const fileEntries = [];
            function walk(dir, currentPath) {
                for (const [name, entry] of Object.entries(dir)) {
                    const fullPath = currentPath ? `${currentPath}/${name}` : name;
                    if (entry.files) walk(entry.files, fullPath);
                    else fileEntries.push({ path: fullPath, entry });
                }
            }
            walk(header.files, '');

            const existingPaths = new Set(fileEntries.map(f => f.path));
            const packedFiles = fileEntries.filter(f => !f.entry.unpacked && f.entry.offset !== undefined);
            packedFiles.sort((a, b) => parseInt(a.entry.offset, 10) - parseInt(b.entry.offset, 10));

            for (const item of packedFiles) {
                item.oldOffset = parseInt(item.entry.offset, 10);
                item.oldSize = item.entry.size;
                const patch = filePatches[item.path];
                if (patch !== undefined && patch !== null) {
                    const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, 'utf8');
                    item.patchBuffer = patchBuf;
                    item.entry.size = patchBuf.length;
                }
            }

            for (const [rawPatchPath, patch] of Object.entries(filePatches)) {
                const patchPath = rawPatchPath.replace(/\\/g, '/').replace(/^\/+/, '');
                if (!patchPath || existingPaths.has(patchPath) || patch === undefined || patch === null) continue;
                const parts = patchPath.split('/');
                let dir = header.files;
                for (let i = 0; i < parts.length - 1; i++) {
                    const seg = parts[i];
                    if (!dir[seg] || !dir[seg].files) dir[seg] = { files: {} };
                    dir = dir[seg].files;
                }
                const fileName = parts[parts.length - 1];
                const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, 'utf8');
                const newEntry = { size: patchBuf.length, offset: '0' };
                dir[fileName] = newEntry;
                existingPaths.add(patchPath);
                packedFiles.push({ path: patchPath, entry: newEntry, oldOffset: 0, oldSize: 0, patchBuffer: patchBuf });
            }

            let currentOffset = BigInt(0);
            for (const item of packedFiles) {
                item.entry.offset = currentOffset.toString();
                currentOffset += BigInt(item.entry.size);
            }

            const newHeaderBuf = this.createHeaderBuffer(JSON.stringify(header));
            destFd = fs.openSync(targetAsar, 'w');
            fs.writeSync(destFd, newHeaderBuf, 0, newHeaderBuf.length, 0);

            let writePos = newHeaderBuf.length;
            const copyBuf = Buffer.alloc(256 * 1024);

            for (const item of packedFiles) {
                if (item.patchBuffer) {
                    fs.writeSync(destFd, item.patchBuffer, 0, item.patchBuffer.length, writePos);
                    writePos += item.patchBuffer.length;
                } else {
                    let remaining = item.oldSize;
                    let readPos = baseOffset + item.oldOffset;
                    while (remaining > 0) {
                        const toRead = Math.min(remaining, copyBuf.length);
                        fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
                        fs.writeSync(destFd, copyBuf, 0, toRead, writePos);
                        readPos += toRead;
                        writePos += toRead;
                        remaining -= toRead;
                    }
                }
            }
        } finally {
            if (srcFd) fs.closeSync(srcFd);
            if (destFd) fs.closeSync(destFd);
        }
    }
}

function installMonitor(resourcesDir) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');
    const monitorPath = path.join(__dirname, 'context_monitor.js');

    if (!fs.existsSync(monitorPath)) {
        console.error(`[error] Missing context_monitor.js at ${monitorPath}`);
        return false;
    }
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
        console.error(`[error] app.asar not found in ${resourcesDir}`);
        return false;
    }

    // Auto-refresh baseline backup whenever official update overwrites app.asar
    let needRefreshBackup = !fs.existsSync(bakPath);
    if (!needRefreshBackup && fs.existsSync(asarPath)) {
        try {
            const curMain = AsarArchive.readFile(asarPath, 'dist/main.js');
            const curPreload = AsarArchive.readFile(asarPath, 'dist/preload.js');
            const mainText = curMain ? curMain.toString('utf8') : '';
            const preloadText = curPreload ? curPreload.toString('utf8') : '';
            const isPatched =
                mainText.includes(MONITOR_START) ||
                preloadText.includes(BRIDGE_START) ||
                preloadText.includes('__ANTIGRAVITY_CHINESE_LOCALIZATION_START__');
            if (!isPatched) {
                console.log('[detect] Official Antigravity update detected; refreshing app.asar.bak baseline...');
                needRefreshBackup = true;
            }
        } catch {}
    }

    if (needRefreshBackup) {
        console.log('[backup] Creating clean backup: app.asar.bak...');
        try {
            fs.copyFileSync(asarPath, bakPath);
        } catch (e) {
            console.error(`[error] Failed to create backup: ${e.message}`);
            return false;
        }
    }

    const sourceAsar = fs.existsSync(bakPath) ? bakPath : asarPath;
    const mainBuf = AsarArchive.readFile(sourceAsar, 'dist/main.js');
    const preloadBuf = AsarArchive.readFile(sourceAsar, 'dist/preload.js');
    if (!mainBuf || !preloadBuf) {
        console.error('[error] Could not locate dist/main.js or dist/preload.js inside app.asar.');
        return false;
    }

    let monitorSrc;
    try {
        monitorSrc = fs.readFileSync(monitorPath, 'utf8');
        new vm.Script(monitorSrc);
    } catch (e) {
        console.error(`[error] context_monitor.js syntax check failed: ${e.message}`);
        return false;
    }

    const mainBase = removeMarkedBlocks(mainBuf.toString('utf8'), MONITOR_START, MONITOR_END);
    const preloadBase = removeMarkedBlocks(preloadBuf.toString('utf8'), BRIDGE_START, BRIDGE_END);

    const filePatches = {
        'dist/contextMonitor.js': monitorSrc,
        'dist/main.js': `${mainBase}\n${MONITOR_START}\ntry{require('./contextMonitor.js');}catch(_e){}\n${MONITOR_END}\n`,
        'dist/preload.js': `${preloadBase}\n${BRIDGE_START}\ntry{electron_1.contextBridge.exposeInMainWorld('__agCtxBridge',{getMetrics:(id,force,details)=>electron_1.ipcRenderer.invoke('ag-ctx:metrics',id,Boolean(force),Boolean(details))});}catch(_e){}\n${BRIDGE_END}\n`,
    };

    const tempAsarPath = path.join(resourcesDir, 'app.asar.tmp');
    try {
        console.log('[patch] Repacking app.asar with status bar & usage monitor...');
        AsarArchive.patchArchive(sourceAsar, tempAsarPath, filePatches);
        try {
            if (fs.existsSync(asarPath)) fs.unlinkSync(asarPath);
            fs.renameSync(tempAsarPath, asarPath);
        } catch {
            fs.copyFileSync(tempAsarPath, asarPath);
            fs.unlinkSync(tempAsarPath);
        }
    } catch (e) {
        try { if (fs.existsSync(tempAsarPath)) fs.unlinkSync(tempAsarPath); } catch {}
        console.error(`[error] Failed to write app.asar: ${e.message}`);
        return false;
    }

    console.log('[ok] Antigravity status bar installed successfully!');
    return resignAppOnMac(resourcesDir);
}

function uninstallMonitor(resourcesDir) {
    const asarPath = path.join(resourcesDir, 'app.asar');
    const bakPath = path.join(resourcesDir, 'app.asar.bak');
    if (!fs.existsSync(bakPath)) {
        console.log('[info] app.asar.bak not found; nothing to restore.');
        return false;
    }
    try {
        console.log('[restore] Restoring original app.asar from app.asar.bak...');
        fs.copyFileSync(bakPath, asarPath);
        fs.unlinkSync(bakPath);
    } catch (e) {
        console.error(`[error] Failed to restore app.asar: ${e.message}`);
        return false;
    }
    console.log('[ok] Original Antigravity app.asar restored!');
    return resignAppOnMac(resourcesDir);
}

function launchAntigravity(installDir, resourcesDir) {
    try {
        if (process.platform === 'win32') {
            const exePath = path.join(installDir, 'Antigravity.exe');
            if (fs.existsSync(exePath)) {
                child_process.spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
                console.log('[launch] Antigravity started.');
                return;
            }
        } else if (process.platform === 'darwin') {
            const targetApp = findMacAppBundle(resourcesDir) || (installDir.endsWith('.app') ? installDir : null);
            child_process.spawn('open', targetApp ? [targetApp] : ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' }).unref();
            console.log('[launch] Antigravity started.');
            return;
        } else {
            const runningUnderSudo = typeof process.getuid === 'function' && process.getuid() === 0 && process.env.SUDO_USER && process.env.SUDO_USER !== 'root';
            if (runningUnderSudo) {
                console.log('[hint] Running under sudo; please start Antigravity manually.');
                return;
            }
            for (const candidate of [path.join(installDir, 'antigravity'), path.join(installDir, 'Antigravity'), path.join(installDir, 'bin', 'antigravity')]) {
                if (fs.existsSync(candidate)) {
                    child_process.spawn(candidate, [], { detached: true, stdio: 'ignore' }).unref();
                    console.log('[launch] Antigravity started.');
                    return;
                }
            }
        }
    } catch (e) {
        console.warn(`[warn] Could not auto-launch Antigravity: ${e.message}`);
    }
}

function main() {
    let uninstall = false;
    let manualDir = '';
    let noKill = false;
    let checkWriteOnly = false;

    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--uninstall' || args[i] === '--restore') {
            uninstall = true;
        } else if (args[i] === '--install-dir') {
            manualDir = args[++i] || '';
        } else if (args[i] === '--no-kill') {
            noKill = true;
        } else if (args[i] === '--check-write') {
            checkWriteOnly = true;
        }
    }

    const installDir = detectInstallationDir(manualDir, { quiet: checkWriteOnly });
    if (!installDir) process.exit(3);

    let resourcesDir = '';
    if (fs.existsSync(path.join(installDir, 'resources'))) resourcesDir = path.join(installDir, 'resources');
    else if (fs.existsSync(path.join(installDir, 'Contents', 'Resources'))) resourcesDir = path.join(installDir, 'Contents', 'Resources');
    else if (fs.existsSync(path.join(installDir, 'app.asar'))) resourcesDir = installDir;
    else resourcesDir = path.join(installDir, 'resources');

    if (!fs.existsSync(resourcesDir)) {
        console.error(`[error] Resources directory not found: ${resourcesDir}`);
        process.exit(1);
    }

    if (checkWriteOnly) {
        process.exit(canWriteResources(resourcesDir) ? 0 : 1);
    }
    if (!canWriteResources(resourcesDir)) process.exit(1);

    const wasRunning = checkIfAppIsRunning();
    if (!noKill && wasRunning) {
        if (!closeAntigravityProcesses()) process.exit(1);
    }

    const ok = uninstall ? uninstallMonitor(resourcesDir) : installMonitor(resourcesDir);
    if (!ok) process.exit(1);

    if (!noKill && (!uninstall || wasRunning)) {
        launchAntigravity(installDir, resourcesDir);
    }
}

main();
