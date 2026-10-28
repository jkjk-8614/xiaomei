# 小美画布快速开始

这是用户启动和配置“小美画布”的唯一入口。开发交接请阅读 `AGENTS.md`，详细技术说明请阅读 `交付文档/`。

## Windows 启动

1. 启动后在“API 设置”中填写平台和模型；也可以将 `API/.env.example` 复制到 `%LOCALAPPDATA%\小美画布\API\.env` 预置环境变量。
2. 如果 `desktop/node_modules/` 不完整，在项目根目录执行 `npm install --prefix desktop`。
3. 双击 `run.bat`，打开“小美画布”桌面端；不需要手动打开浏览器。

Windows 桌面版的画布、Skill、模型与 API 配置、历史和素材保存在 `%LOCALAPPDATA%\小美画布`，更新安装包不会覆盖这里。旧版本安装目录中的运行数据会在新版首次启动时自动迁移。

只启动本地服务进行开发或排障时，运行 `python main.py`，然后访问 `http://127.0.0.1:3000/`。

更新桌面代码后，需要完全退出并重新启动小美画布。

## ComfyUI 页面来源

ComfyUI 页面、CSS 和 JavaScript 统一存放在 `ComfyUI/web/`，这是项目的唯一物理来源。界面仍使用 `/static/comfyui.html`、`/static/comfyui-settings.html` 等兼容 URL，这是后端映射出来的访问地址，不是第二套源码。不要在 `static/` 下重新建立 ComfyUI 页面副本。

## 文档入口

- 开发交接：`AGENTS.md`
- 部署与启动：`交付文档/01-部署与启动.md`
- 项目总览：`交付文档/00-项目总览.md`
- 其他历史启动说明：`交付文档/归档/`

## 安全说明

本包不包含应公开发送的真实 API Key。不要把 `API/.env`、历史记录、个人素材、画布和运行日志上传到源码仓库或发给他人。
