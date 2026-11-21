# Antigravity Status Bar & Usage Monitor

轻量级的 **Antigravity Desktop** 英文原版增强工具：在不修改官方英文界面的前提下，在聊天输入框底部工具栏内常驻显示 **Token 生成速率、Prompt 缓存命中率、上下文窗口占用** 以及 **模型剩余额度**，悬停或点击即可展开完整的上下文构成与多模型组 **`Usage`** 额度面板。

## 核心特性

- **100% 保留官方英文原版 UI**：仅向 `app.asar` 注入只读监控模块与最小 IPC 桥接，不改写任何官方文案或业务数据。
- **输入框内极简状态条**：紧贴工具栏右侧按钮组（`Auto / Turbo` 左侧）一行展示，自动适配明暗主题与窄窗渐进折叠：
  - **生成速率**：`tok/s`（支持最新单轮速率与会话均速）
  - **缓存命中**：Prompt Cache 命中百分比
  - **上下文占用**：动态进度圆环 + 已用百分比（`≥ 70%` 橙色预警、`≥ 90%` 红色告警）
  - **模型剩余额度**：当前模型分组的实时剩余百分比（`≤ 30%` 橙色、`≤ 10%` 红色）
- **浮卡详情 & `Usage` 额度面板**：
  - 上下文窗口大圆环、已用 / 剩余 / 上限 Token、TTFT 首字耗时、本次/累计缓存统计及**上下文分类构成**（系统提示词、MCP 工具、技能、对话消息、已读文件）。
  - 直连本地 Language Server `RetrieveUserQuotaSummary` 接口，分组展示 **Gemini Models / Claude and GPT models / Gemini 4 Argon** 等全部模型池的 **Weekly limit / 5h limit** 剩余百分比、进度圆环与重置倒计时（如 `Resets in 3d 23h`、`Resets in 4h 29m`）。
- **零依赖原生 ASAR 注入 & 升级防呆**：
  - 纯 Node.js 标准库实现，无需 `npm install` 或联网下载工具包。
  - 自动兼容 Antigravity `v2.34.0+` 的 `languageServer.getLsCsrfToken()` 鉴权机制与旧版 `--csrf_token` 启动参数。
  - 自动检测官方客户端更新并刷新 `app.asar.bak` 基线备份，避免覆盖后版本回退。

## 环境要求

- **Antigravity Desktop**（Windows / macOS / Linux，已验证至 `v2.34.0`）
- **Node.js**（任意 LTS 版本即可，无需安装第三方依赖）

## 快速使用

### Windows
1. 双击运行 **`install.bat`**（自动关闭客户端、备份原版 `app.asar.bak`、注入状态条并自动重启 Antigravity）。
2. 如需还原官方纯净版，双击运行 **`uninstall.bat`** 即可无损恢复。

### macOS / Linux
```bash
chmod +x install.sh uninstall.sh
./install.sh          # 安装
./uninstall.sh        # 还原官方原版
```
*(若安装在系统目录提示权限不足，请使用 `sudo ./install.sh`；如需手动指定目录，可附加 `--install-dir "/path/to/Antigravity"`。)*

### 客户端更新后
当 Antigravity 官方自动更新覆盖 `app.asar` 后，只需重新运行一次 `install.bat`（或 `./install.sh`）即可，脚本会自动识别新版本并刷新备份基线。

## 文件结构

```text
antigravity-status-bar/
├── context_monitor.js   # 主进程只读采集 + 渲染层 Shadow DOM 状态条与 Usage 浮卡
├── installer.js         # 原生 ASAR 打包注入、自动基线备份与无损还原引擎
├── install.bat          # Windows 一键安装脚本
├── uninstall.bat        # Windows 一键卸载还原脚本
├── install.sh           # macOS / Linux 安装脚本
├── uninstall.sh         # macOS / Linux 还原脚本
├── LICENSE              # MIT 协议
└── README.md
```

## 致谢

本项目在原生 ASAR 流式修补协议与上下文监控采集思路上参考并致谢开源项目 [Silas-02/antigravity-desktop-cn](https://github.com/Silas-02/antigravity-desktop-cn) 及其上游 [qqxpee/antigravity2-cn](https://github.com/qqxpee/antigravity2-cn)。
