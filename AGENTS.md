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

小美画布是一个本地优先的 AI 电商视觉工作台。后端为单文件 FastAPI 应用 `main.py`，前端为 `static/` 下的原生 HTML/CSS/JavaScript，通过 iframe 组成主界面。默认端口为 `3000`。

## 关键规则

- 不要把真实 API Key 写进源码、文档或 Git；本包只保留 `API/.env.example`。
- API 平台和模型列表必须由 `/api/providers` 与 `/api/providers/fetch-models` 动态驱动，禁止重新写死模型下拉框。
- 生图、异步轮询、历史记录、小美画布和电商工作台共享同一套后端生成接口；修改接口时必须回归这些入口。
- `main.py` 是历史演进形成的单体文件。修改前先搜索路由、请求模型、辅助函数和所有前端调用点，避免只改一处。
- 前端没有打包步骤，改动后必须检查浏览器缓存版本参数；必要时更新 HTML 中资源 URL 的 `?v=`。
- 用户目录、历史图片、素材、画布、日志属于运行数据，不应进入发布源码包。
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

