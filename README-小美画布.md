# 小美画布源码交付包

这是经过测试的“小美画布”可迁移源码包，包含：

- 全部应用源码和必要静态资源；
- Windows 便携 Python 运行环境；
- API/CLI/工作流相关脚本；
- 面向开发者和 Codex 的完整交付文档；
- 安全的环境变量示例；
- 文件清单与 SHA-256 校验表。

## 快速开始

1. 阅读 `AGENTS.md`（交给 Codex 时让它先读此文件）。
2. 将 `API/.env.example` 复制成 `API/.env`。
3. 填写自己的 API Key，或启动后进入“API 设置”。
4. Windows 首次运行先执行 `npm install --prefix desktop`（桌面依赖已存在时跳过）。
5. 双击 `run.bat`，直接打开“小美画布”桌面端；不需要手动打开浏览器。

Windows `Setup-x64` 和 macOS ZIP 版支持从 GitHub Releases 检查更新；发布流程见 `交付文档/01-部署与启动.md`。Windows 会下载并启动新版 Setup，macOS 会下载并打开经过校验的 ZIP，Portable 版不参与软件内自动安装更新。

## 重要安全说明

本包不包含原电脑上的真实 API Key、历史记录、个人素材、画布和日志。不要把以后生成的 `API/.env` 公开发送。

## 给 Codex 的推荐指令

```text
请先完整阅读根目录 AGENTS.md 和交付文档目录中的所有 Markdown 文件，再检查项目结构。先运行现有验证，不要重构或删除兼容代码。告诉我项目如何启动、我提出的改动会影响哪些前后端文件，然后再开始修改。
```
