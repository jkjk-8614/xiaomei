# DeepSeek Harness 官方桌面端集成

小美画布的 DeepSeek 对话入口使用 `vendor/deepseek-harness` 固定版本构建的官方 Desktop Host 和官方 Web UI。桌面壳通过 Host IPC 获取认证地址，再用受控 `WebContentsView` 显示官方会话界面；不会再显示自制 Harness 工具栏。

## 小美画布桌面端联动

桌面端打开 DeepSeek 对话时，DeepSeek Harness 使用与 FastAPI 后端一致的配置目录下的
`data/api_providers.json` 和 `API/.env` 生成 profile：模型选择器只显示已启用且已配置 Key 的聊天模型，
请求通过同一平台的 Base URL 和 Key 发送。小美画布 API 设置是唯一配置源，Harness 的 Models 和 Account
设置入口被禁用，不能再单独录入 DeepSeek 密钥或维护另一套模型列表。密钥只通过 `apiKeyEnv` 引用传入，
不会写进生成的 `cordis.patch.yml`。

Harness 自带的 `deepseek-official` 路由和单独 Key 设置始终停用，默认模型使用小美画布 API 设置中的
首选可用平台和首个聊天模型。没有可用聊天平台时，顶部提示前往 API 设置，不显示官方模型作为兜底。
配置目录由 `desktop/main.cjs` 的 `xiaomeiApiConfigRoot()` 按后端启动方式解析，与 `main.py` 的
`_runtime_root()` 保持一致；Electron 的用户数据目录不作为 API 配置来源。

Harness 的 Skill 搜索目录指向小美画布的 `data/agent_skills`，会话持久化仍在
`.xiaomei-data/deepseek-harness/sessions`，工作区根目录固定为当前小美画布项目目录。桌面端顶部
会显示“API 由小美画布统一管理”和已同步的平台/模型数量，并提供 API 设置、历史、素材和技能入口；
这些入口打开的仍是小美画布原有页面和数据。

在小美画布 API 设置中保存平台、模型或密钥后，桌面端会向已打开的 Harness 发送刷新请求；配置指纹
发生变化时自动重启官方 Host 并重新加载当前会话页面，不需要重新部署模型或重新填写 Key。

## 更新方式

从 GitHub Release 安装的软件使用 `bundled/deepseek-harness` 中已构建的 Desktop Host、Web UI 和依赖，
并使用安装包自带的 Node。Harness 随小美画布安装包一起更新；在软件内检查 Harness 更新时会提示检查小美画布的新版本。
发布构建由 `scripts/prepare-harness-runtime.mjs` 准备运行目录，`scripts/smoke-harness-runtime.mjs` 验证 Host 可以启动。

从源码运行时，桌面端会检查 `vendor/deepseek-harness` 的官方 `master` 分支。发现上游提交更新时会弹出确认，
不会静默替换正在运行的 Harness。选择“立即更新”后，程序会依次：

1. 停止当前 Harness Host，保存小美画布适配补丁到 `.xiaomei-data/deepseek-harness-updates/`；
2. 只对 `vendor/deepseek-harness` 做快进更新，并重新应用本地适配补丁；
3. 执行依赖安装和 Host、Client、Web 构建；
4. 构建成功后重新打开当前 Harness 会话。

如果本地修改与上游发生冲突，更新会停止并恢复旧版本，提示手动处理；不会覆盖 `API/.env`、历史、素材、
画布或 Harness 会话。更新状态也可由桌面端 `electronAPI.checkDeepSeekHarnessUpdate()` 查询。

## 官方功能

- 左侧包含新会话、插件、工作区、会话搜索、置顶、分叉和归档。
- Composer 支持 `/` Skill 补全、调用和 Instructions 卡片。
- 右侧提供 Skill、文件、浏览器、终端和文档预览。
- Harness 的运行日志写入 `.xiaomei-data/deepseek-harness/`，模型、技能目录和工作区由小美画布启动层联动提供。
- 聊天中的图片悬浮在右下角显示“复制图片”，预览大图时同样保留该按钮；图片先由 Harness 页面读取，再通过桌面剪贴板写入，支持带登录态的会话附件。

### 网关兼容

6789API 对 Gemini 模型的流式工具调用会拆散函数名和参数，桌面适配器对 Gemini 使用完整 Chat Completions 响应后再转回 Harness 流，避免把拆散的调用写入会话历史。回复会在完整响应返回后显示。模型仍由 API 设置的动态列表提供；上游本身返回 503 或“不支持模型”时，界面显示原始模型错误。已出现缺失函数名的旧会话可新建对话后重试，原记录保留。

## Skill 目录

官方 `dsh-skill-filesystem` 会读取 `data/agent_skills/`。每个 Skill 使用目录 bundle 格式：`data/agent_skills/<skill-name>/SKILL.md`。设计 Skill 已包含 `ecommerce-visual`、`poster-design`、`brand-visual`、`social-visual`。

## 设计桥接

`POST /api/harness/design` 负责识别设计类别并返回现有 `/api/chat/agent` 请求形状，不会绕过确认直接生图。生成仍使用小美画布原有模型、供应商、历史和素材接口；供应商和模型列表继续由 `/api/providers` 动态提供。

## 历史记录

启动官方 Host 前会运行 `tools/migrate_harness_conversations.py`。脚本递归读取
`data/conversations/<工作区>/*.json` 和旧版根目录 JSON，原文件不会移动或覆盖；迁移副本写入
`.xiaomei-data/deepseek-harness/imported-workspace/`，并在 Harness 工作区列表增加“小美画布历史”，
同时生成 `conversation-migration.json`。这份桥接副本用于在官方界面查看旧记录，新的对话仍由 Harness
保存在自己的 JSONL 会话目录；小美画布历史页继续读取原始 `data/conversations`。

## 构建与排查

```powershell
pnpm install --frozen-lockfile
pnpm run build:lib:host
pnpm run build:lib:client
pnpm run build:web
```

桌面端需要 Node 22.19+ 或 Node 24，可用 `XIAOMEI_HARNESS_NODE` 指定 Node。Host 默认使用 19387 端口；启动失败会在小美画布工作区显示错误，不会留下空白区域。不要把 API Key 写入源码、文档、Skill 或 Git。
