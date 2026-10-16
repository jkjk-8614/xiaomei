# 小美画布：Codex 接手说明

本文件给后续 Codex/开发者作为项目入口。收到本项目后，先按以下顺序阅读：

1. `交付文档/00-项目总览.md`
2. `交付文档/01-部署与启动.md`
3. `交付文档/02-功能链路.md`
4. `交付文档/03-API与模型适配.md`
5. `交付文档/04-数据与目录结构.md`
6. `交付文档/05-二次开发指南.md`
7. `交付文档/06-验收与故障排查.md`

## 项目定位

小美画布是一个本地优先的 AI 电商视觉工作台。后端为单文件 FastAPI 应用 `main.py`，主应用前端为 `static/` 下的原生 HTML/CSS/JavaScript，通过 iframe 组成主界面。默认端口为 `3000`。

ComfyUI 页面、CSS 和 JavaScript 的唯一物理来源是 `ComfyUI/web/`。运行时保留的 `/static/...` 地址只是兼容访问 URL，由后端优先映射到 `ComfyUI/web/`；不要恢复 `static/comfyui-settings.*` 的重复副本。

## 关键规则

- 不要把真实 API Key 写进源码、文档或 Git；本包只保留 `API/.env.example`。
- API 平台和模型列表必须由 `/api/providers` 与 `/api/providers/fetch-models` 动态驱动，禁止重新写死模型下拉框。
- 生图、异步轮询、历史记录、小美画布和电商工作台共享同一套后端生成接口；修改接口时必须回归这些入口。
- `main.py` 是历史演进形成的单体文件。修改前先搜索路由、请求模型、辅助函数和所有前端调用点，避免只改一处。
- 前端没有打包步骤，改动后必须检查浏览器缓存版本参数；必要时更新 HTML 中资源 URL 的 `?v=`。
- 用户目录、历史图片、素材、画布、日志属于运行数据，不应进入发布源码包。
- 启动入口以 `README-小美画布.md` 为准；本文件是开发交接入口，详细部署说明见 `交付文档/01-部署与启动.md`。
- 保持 Windows 中文路径兼容；文件操作使用绝对路径、UTF-8 和 `pathlib/os.path`，不要假定项目位于英文目录。

## 最小验证

```powershell
python -m py_compile main.py
python -c "import fastapi,uvicorn,requests,pydantic,httpx,PIL; print('dependencies ok')"
python main.py
```

启动后验证：

```text
GET http://127.0.0.1:3000/
GET http://127.0.0.1:3000/api/app-info
GET http://127.0.0.1:3000/api/providers
GET http://127.0.0.1:3000/api/history
```

## 重点文件

- `main.py`：后端、API 适配、任务轮询、文件与数据持久化。
- `static/index.html`：应用壳、侧栏、页面切换、主题与历史抽屉。
- `static/js/smart-canvas.js`：小美画布核心交互与节点执行。
- `static/css/smart-canvas.css`：小美画布布局和节点样式。
- `static/js/commerce.js`：一键主图/详情页、电商策划、分段提示词和批量生成。
- `static/js/api-settings.js`：API 平台、模型拉取、协议验证和 CLI 设置。
- `static/js/asset-manager.js`：素材库、分类、目录、上传和资源管理。
- `static/history.html`：历史列表及与主界面大图预览的消息桥接。
- `requirements.txt`：Python 依赖。

## 修改后的交付要求

- 执行与改动风险相称的验证。
- 不覆盖用户已有数据或配置。
- 文档与实际行为保持一致。
- 如果新增外部依赖，同步更新 `requirements.txt` 和 `交付文档/依赖与资源清单.md`。

## 固定发布规则

- 默认依赖和安装包只包含 CPU 版 ONNX Runtime。`onnxruntime-gpu[cuda,cudnn]` 由 `tools/install-windows-gpu-runtime.ps1` 按需单独下载，安装到持久用户数据目录；禁止将 GPU、CUDA、cuDNN 依赖重新并入基础包。构建与最终 Windows 运行时必须通过 `scripts/verify_cpu_runtime.py`。

- 发布前以 `D:\小美画布` 当前程序功能为准，将其源码改动安全同步到隔离发布检出；不要只修改版本号。保留发布仓库的桌面自动更新、安装器和用户数据保护实现，合并冲突后验证实际界面。`source-snapshot.json` 记录当前开发源码和发布源码的指纹；`prepare-release.mjs` 会核对开发目录，若出现未同步功能则停止发布。构建后的安装包也必须通过关键界面文件一致性检查。
- 收到“发布更新”后，从 GitHub 最新正式 Release 读取版本，运行 `node scripts/prepare-release.mjs`。显示版本按 `v1.07 → v1.08 → v1.09 → v1.10` 递增，内部版本分别为 `1.0.7 → 1.0.8 → 1.0.9 → 1.0.10`；同步 `VERSION`、根目录和桌面端 `package.json`、锁文件、`static/update-notes.json` 与 Git 标签。若本次发布未通过全部验证，重试沿用本次标签和版本，不再递增。构建编号由同一次 GitHub Actions 运行号写入各平台包和 `update.json`。
- 发布前检查 Git 跟踪文件和发布输入；禁止上传或打包真实 API Key、私人 `.env`、用户图片、历史记录、素材、个人配置和缓存等运行数据。安装包构建后检查解包内容和更新清单。保留本地所有数据，不清理或覆盖用户目录。
- GitHub Release 标题固定为 `小美画布 v<显示版本>`，标签固定为 `v<显示版本>`。正文必须为空；不写功能列表、日期、平台说明、隐私声明，也不自动生成发布说明。附件只包含 Windows x64、macOS arm64 安装包及供旧版识别新版的 `update.json`；今后不构建或发布 macOS x64。
- 先上传到草稿 Release 并核对标题、空正文、附件、构建编号；正式公开后验证最新版下载入口，以及启动自动检查、手动检查、下载、校验和升级流程。升级验收在隔离的 Windows 环境中从旧版安装包开始，实际下载并覆盖安装新版，检查构建编号和本地数据保留。断网时提示用户检查网络或系统代理，提供重试与官方下载入口。只有新版验证通过后才删除旧 GitHub Releases 和附件，最终发布列表只保留最新版；不要删除 Git 标签或源码提交历史。
- 发布流程以 `.github/workflows/desktop-release.yml` 为准。任何验证失败都停止旧版清理；修复后重跑同一标签。不要从含本地运行数据的日常目录直接打包。

