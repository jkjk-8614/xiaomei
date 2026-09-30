# API 与模型适配

## 1. 配置位置

- 安全密钥：`API/.env`。
- 平台元数据：`data/api_providers.json`。
- 通用平台的多账号 Key 记录元数据：`data/api_key_profiles.json`；真实 Key 仍只写入 `API/.env`，记录文件不保存明文密钥。
- 设置界面：`static/api-settings.html` + `static/js/api-settings.js`。
- 后端默认配置和协议适配：`main.py`。

首次部署复制 `API/.env.example` 为 `API/.env`。不要把真实 `.env` 发送给他人。

设置页中，支持通用 API 协议的平台可以保存多条命名 Key 记录。下拉框切换记录时，后端会把所选 Key 同步为该平台当前运行 Key；删除当前记录后会自动切换到下一条可用记录。旧版本只有一条平台 Key 时，首次读取平台配置会自动登记为“账号 1”，不会要求重新填写。

相关接口为 `GET/POST /api/providers/{provider_id}/key-profiles`、`POST /api/providers/{provider_id}/key-profiles/{profile_id}/activate` 和 `DELETE /api/providers/{provider_id}/key-profiles/{profile_id}`。各 CLI 登录态继续使用原有专用配置，不纳入通用记录；RunningHub 的 Key 仍通过“推荐 API”区域的快捷卡片保存，历史数据由后端兼容读取。

## 2. 支持的协议族

后端现有协议集合包括：

- `openai`：OpenAI 兼容接口。
- `apimart`：异步任务类接口。
- `gemini`：Google/Gemini 原生或兼容接口。
- `gemini-cli`：本地 Antigravity CLI。点击“拉取模型”时读取本机 `agy models` 返回的账号可用聊天/代理模型；图片模型固定显示为 `auto`，表示调用当前 CLI 会话的原生 `generate_image` 工具。图片请求不会绑定、调用或回退到其他平台。
- `volcengine`：火山引擎。
- `runninghub`：RunningHub 应用/工作流的兼容协议；当前只在“推荐 API”区域提供 Key 快捷配置，不出现在左侧平台列表或画布来源下拉框。
- `jimeng`：即梦 CLI/API。
- `codex`：Codex/GPT CLI。

图片请求模式还包括 OpenAI 标准、JSON、视频代理和 Responses 风格。每个平台的真实能力应以连接验证和模型拉取结果为准。

### 本地 ComfyUI 的独立入口

普通 API/生成节点只负责在线模型和方舟/Ark；RunningHub 只在“推荐 API”区域保留快捷 Key 配置，不出现在 API 平台列表或来源下拉框。本地 ComfyUI 不混入在线 API 设置，而是从主侧栏“更多设置 → ComfyUI 设置”进入已有 ComfyUI 工作台；画布创建菜单保留独立的“ComfyUI”卡片。历史 RunningHub 节点仍按原配置保留，以避免打开旧画布时丢失数据，但不会被新节点或启动流程主动调用。

- ComfyUI 工作台的设置页读取 `GET /api/comfyui/instances` 和现有 `GET /api/workflows`；工作流字段仍在该工作台的工作流设置页维护，不复制工作流 JSON 或另建字段库。已有 ComfyUI 应用库条目仍可通过 `GET /api/comfy-apps/catalog` 合并展示。
- 从画布创建菜单选择“ComfyUI”后，节点只选择一个已存在的本地工作流，并保存工作流引用、字段值和运行设置；工作流内部节点图仍回到 ComfyUI 工作台维护。
- 应用库工作流的参考图上传和任务提交都通过应用库解析本机 ComfyUI 后端，避免图片上传到默认端口而任务运行在独立端口。
- 本地 ComfyUI 节点使用 `POST /api/canvas-comfy-tasks` 执行并轮询；不经过在线 API、RunningHub 或其他云端工作流接口。排队阶段显示排队状态，运行阶段在 ComfyUI 未提供数字进度时显示按任务耗时递增的预计进度；预计值不代表上游实时百分比。
- 本地节点的提示词默认绑定第一个提示词字段，图片、视频和音频按字段类型与顺序绑定；未能自动判断的字段保留为可编辑参数。执行结果继续写回原节点并进入历史记录。

### Codex GPT CLI 生图

- GPT CLI 的 Codex 协议继续读取本机 Codex 登录态（`codex login` 生成的 `auth.json`），不要求在项目中填写 OpenAI API Key。
- 点击“拉取模型”或“验证地址”时，聊天模型从本机 Codex App Server 的 `model/list` 读取当前可见清单；读取失败会显示错误，不会把初始化默认值当作实时结果。新模型需在“选择模型”中勾选并应用到设置。
- `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 只有在本机 helper 的 `models list` 返回的 Codex `image_generation_tool` 能力中明确出现时，才会加入设置页和画布模型列表；未检测到时只显示 `gpt-image-2`。
- 检测结果会短暂缓存；旧配置中残留的 2.5 模型不会被删除，但在当前 Codex 能力未声明支持时不会对用户显示，生成前也会被拦截。
- `gpt-image-2` 保留原有 helper 高级命令和 Codex CLI 回退路径。2.5 选择失败时不会静默降级到旧模型，避免用户误以为已经使用了 2.5。
- Codex 默认图片/聊天模型只用于初始化模型列表；用户在 API 设置中勾选、删除或编辑后，以保存的列表为准，不会在重新渲染或重启时自动补回已移除的模型。
- 2.5 是否可用仍由当前 Codex 账号、地区和上游权限决定；“可选”不代表绕过账号权限或额度限制。

### OpenAI 兼容接口的 GPT Image 2.5 参数

- 当 API 平台选择 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 或对应网关后缀模型时，在线生图、智能画布和电商工作台会动态显示 `quality=auto/low/medium/high/xhigh/max` 与 `background=opaque/transparent`（默认 `opaque`）；质量选项仍按模型分别处理。AI 分层对 GPT Image 2/2.5 显式指定的背景参数会透传到标准 OpenAI 图片生成、编辑及 Responses 图片工具；未指定背景的 GPT Image 2 请求保持原行为，其他模型不附加该参数。
- 选择 `background=transparent` 时，后端同时提交 `output_format=png`，不会把透明结果转成 JPEG。
- `size` 可以使用 `auto` 或自定义像素尺寸；自定义值提交前会统一收敛到边长 16 的倍数、长边不超过 3840、总像素不超过 8,294,400、宽高比不超过 3:1 的范围。画布/在线生图的方形 4K 选项使用 2880×2880，避免提交 3840×3840 超过像素上限；3:4 4K 的 2448×3264 仍然有效。
- 这些参数会同时写入任务与历史记录，便于复用和排查；模型列表仍以 `/api/providers` 与 `/api/providers/fetch-models` 的动态结果为准。

### 在线生图页的本地 ComfyUI 模式

- 在线生图页默认不调用 `/api/online-image`，而是通过 `POST /api/canvas-comfy-tasks` 提交本机任务；前端先读取 `/api/comfyui/status`，ComfyUI 不在线时不会创建任务。
- 本地文生图使用 `ComfyUI/workflows/Z-Image.json`；本地去噪、去色块和保构图使用 `ComfyUI/workflows/Z-Image-Enhance.json`。增强模式先把参考图上传到本机 ComfyUI，再通过节点 `15` 注入图片、节点 `204` 注入 `local_denoise`、节点 `23` 注入净化提示。
- `local_denoise` 由前端限制在 `0.1–1.0`，默认 `0.35`；`local_include_portrait` 只影响本地净化提示词。任务结果由既有 `generate(GenerateRequest)` 落盘并写入本地历史，不经过任何付费 API。
- 用户显式切换“API 生图”后，页面才继续使用现有 `/api/online-image` 与动态供应商/模型配置；本地模式不会读取 API Key，也不会把本地任务改发到云端。

### Antigravity CLI 原生 Gemini 生图

- 画布调用本机 `agy -p ... --dangerously-skip-permissions`，并在任务提示中强制要求调用当前会话的原生 `generate_image` 工具。工具参数使用 `Prompt`、`ImageName`、`toolAction`、`toolSummary`，参考图最多透传 3 个 `ImagePaths`，比例按支持值透传 `AspectRatio`。
- `agy --model` 只接收 `agy models` 返回的聊天/代理模型；图片模型不应填写 `gemini-*-image` 之类未被 CLI 识别的 slug。原生图片工具使用当前 Antigravity 账号的图片能力。
- 原生工具生成的文件通常落在 `%USERPROFILE%\.gemini\antigravity-cli\brain` 或 `scratch`。应用只扫描本次调用新生成的图片，并复制到 `assets/output` 供画布访问；不会调用 6789、Gemini API 或其他生图平台，也不需要在项目保存新的 API Key。
- 如果账号图片配额耗尽、工具调用失败或没有落盘文件，任务会保留失败状态并显示具体原因，不伪造文字成功，也不切换到其他生成器。
- `agy` 返回图片后，应用只在本机 ComfyUI 已启动、且 SeedVR2 节点与模型可用时接入本地 AI 超分；当前官方节点使用 `ComfyUI/workflows/seedvr2-official-upscale.json`，旧版节点保留 `ComfyUI/workflows/upscale.json` 兼容路径。未就绪时保留原图，并且绝不使用普通插值冒充高分辨率。这个本地步骤不调用第三方 API，但会占用本机 GPU。

### 本地放大接口（保留接口，无画布工具栏入口）

- 状态入口为 `GET /api/local-upscale/status`；Real-ESRGAN 首次下载使用 `POST /api/local-upscale/models/real-esrgan/download`，进度读取使用同路径的 `GET`；单图执行入口为 `POST /api/image/local-upscale`。
- Real-ESRGAN 固定使用官方 `realesrgan-ncnn-vulkan-20220424-windows.zip`，包大小 `45,474,481` 字节，SHA-256 为 `abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`。校验通过后解压到 `data/models/upscale/`，运行时使用 `realesrgan-x4plus` 的原生 4x 推理和 Vulkan GPU；用户选择 2x 或目标分辨率时再缩放到目标尺寸，不走该便携版容易产生错位拼块的 2x 推理路径。不需要 PyTorch/CUDA Python 包。
- SwinIR 通过 `ComfyUI/workflows/swinir-upscale.json` 接入本机 ComfyUI；状态检测只接受 `upscale_models` 中名称含 `SwinIR` 的真实权重。当前官方 SeedVR2 节点使用 `SeedVR2`、`SeedVR2ExtraArgs` 和 `SeedVR2BlockSwap`，从 `models/SEEDVR2` 加载 3B FP8 DiT 与 FP16 VAE；旧版节点仍兼容 `ComfyUI/workflows/upscale.json`。
- 三个入口均为本机派生处理，不读取 API 平台、Key 或额度，不会回退到 6789、Gemini、RunningHub 或其他付费接口。结果元数据固定记录 `paid_api=false` 和 `derived_from.operation=local-upscale`。
- `XIAOMEI_LOCAL_UPSCALE_TIMEOUT_SECONDS` 可调整单次本地处理超时，默认 900 秒、范围 60–1800 秒；`XIAOMEI_REALESRGAN_TILE_SIZE` 可调整 Vulkan 分块，默认 256；`XIAOMEI_REALESRGAN_BIN` 可指定自行安装的兼容可执行文件。

通用 New API 网关的视频生成会按平台兼容路径提交并轮询；Base URL 应保留平台给出的 API 根地址。
6789API 的新版 Seedance 视频协议使用专用路径：`POST /v1/videos` 创建任务，`GET /v1/videos/{taskId}` 按约 5 秒轮询，完成后优先读取返回的 `file`，没有文件地址时通过带 Bearer 鉴权的 `GET /v1/videos/{taskId}/content` 下载 MP4。请求体使用 `model`、`prompt`、`duration`、`ratio` 和固定 `resolution: "720p"`；参考图必须是公网 HTTPS `image_urls`。

## 3. 添加一个 OpenAI 兼容平台

在“API 设置”中：

1. 新增平台，设置名称和唯一平台 ID。
2. 请求地址填写 API 根地址，不要重复拼接错误的 `/v1`。
3. 填写 Key。
4. 协议选择 OpenAI 直连。
5. 图片协议选择平台实际支持的格式。
6. 先“验证地址”和“验证协议”。
7. 点击“拉取模型”，再按图片/对话/视频选择需要使用的模型。

前端模型下拉框必须实时读取该平台保存的模型，不能维护另一份固定列表。

## 4. 6789API 与 Comfly

示例环境变量：

```dotenv
COMFLY_BASE_URL=https://ai.comfly.org
COMFLY_API_KEY=填写自己的Key
API_PROVIDER_API_6789_KEY=填写自己的Key
```

实际 Base URL、路径和协议以平台当时文档为准。若出现“生成接口没有返回图片数据”，依次检查：

1. 选中的模型 ID 是否为图片模型。
2. 平台是否需要异步任务协议。
3. 返回结构中是 URL、base64、任务 ID 还是 Responses 输出。
4. 轮询地址和成功状态字段是否匹配。
5. 平台后台是否显示任务成功但本地解析漏掉了第 4 张图。

6789API 视频模型需要在设置页重新拉取并勾选上游返回的 Seedance 模型。当前支持 `seedance2.0`、`seedance2.0fast`（5/10/15 秒）、`seedance2.0mini`（5/10 秒）和 `seedance2.5`（30 秒）；比例支持 `1:1`、`3:4`、`4:3`、`9:16`、`16:9`、`21:9`。

相关后端入口：`/api/online-image`、`/api/image-task-query`、`/api/canvas-image-tasks`、`/api/canvas-video`。

### CainFlow 风格视角控制

- `smart-camera` 是相机提示词与参考图透传节点，不是独立生图模型，不新增 API Key，也不自动切换平台。
- 节点参数为 `pitch`、`yaw`、`distance`、`fov`、`roll`，提示词由 `static/js/smart-camera-node.js` 根据 CainFlow 规则重新编译。
- 下游绘画节点继续走原有通用执行链路和用户选择的 API/模型；视角节点不会读取或启动 ModelScope、Qwen 2511 或 ComfyUI 专用工作流。
- CainFlow 来源、作者和 GPL-3.0 归属见项目根目录的 `NOTICE`。

## 5. 模型分类

模型拉取后按用途分类：

- 图片模型：进入在线生图、小美画布、电商工作台。
- 对话模型：进入 GPT 对话、智能分析、分段策划。
- 视频模型：进入视频模式。

名称展示可按 Google/Gemini、OpenAI/GPT 等家族分组，但请求必须使用平台返回的原始模型 ID。

## 6. 同步与异步

- 默认优先异步：提交快、长任务更稳定、可轮询进度。
- 同步：连接保持到平台直接返回结果，平台或代理容易超时。
- 小美画布图片生成固定使用异步任务提交和轮询；旧画布或浏览器偏好中保存的同步值也会按异步处理。
- 画布后台生图默认同时执行最多 2 个任务，其余保持 `queued`，避免兼容网关在批量请求时断连；可用 `CANVAS_IMAGE_TASK_CONCURRENCY` 在 1–8 间调整。上游未返回真实百分比时，界面只显示排队/生成状态和耗时，不显示估算百分比。
- 画布 Agent/策划的聊天请求遇到 502、503、429 或 `Service temporarily unavailable` 时，后端默认在同一模型上有限重试 2 次；生图提交不采用此重试，避免重复扣费。
- GPT Image 2/2.5 的 `/images/edits` multipart 提交默认按“平台 + 模型”最多 2 路并发，避免 4 张批量图被迫串行等待；可通过 `GPT_IMAGE2_EDIT_CONCURRENCY` 调整（范围 1–8）。如果某个兼容网关返回断连或“系统繁忙”，可在 `API/.env` 中设为 `1`。
- 异步失败时必须保留失败卡片、错误消息、模型、耗时和重试入口。

## 7. 参考图上传

不同平台可能要求：

- 公网 URL；
- multipart 文件；
- base64；
- 平台内部文件 ID。

后端已有上传、URL 导入和本地文件桥接。新增平台时不要把 Windows 本地路径直接发给远程 API。
GPT Image 2/2.5 走 `/images/edits` 时，后端会在内存中把超出长边 3840px 或总像素 8,294,400 限制的参考图/遮罩等比缩小后再上传，不会改写用户原图。

## 8. 新增供应商的代码步骤

1. 在 `main.py` 搜索 `SUPPORTED_PROVIDER_PROTOCOLS` 和现有供应商辅助函数。
2. 增加平台默认值、验证逻辑、模型拉取解析。
3. 在统一生图函数中增加请求转换和响应解析。
4. 若为异步接口，增加提交、轮询、成功/失败状态映射。
5. 在 `api-settings.js` 增加必要配置字段，优先复用现有 UI。
6. 验证在线生图、小美画布和电商工作台三条链路。
7. 更新本文件和依赖清单。

## 9. 商品分析与桌面通信

- `POST /api/commerce-analysis/jobs` 接受 `backend=edge|electron`、`session_id` 和 `tab_id`，旧版只传 `url/browser` 仍兼容。
- `POST /api/commerce-analysis/operations/capture` 保存千牛/生意参谋可见页面数据；`GET /api/commerce-analysis/operations` 和 `GET /api/commerce-analysis/operations/{id}` 查询记录。
- 商品结果 schema v3 新增 `videos`、`operations`、`moduleStatus.videos` 与 `collection.backend/sessionId/tabId`，读取 v2 快照时由后端补默认值。
- Electron 只负责白名单导航、可见 WebContents/CDP Agent 截图与鼠标滚轮操作、可见页面“评价→问大家→目标 mtop 响应”只读采集和状态 IPC；评价解析 `rateList`，问大家解析 `questionList`，不会从整页文字推导样本。AI 请求、任务轮询、资源下载与数据持久化继续由 FastAPI 完成。采集进度只回传模块、动作、数量和响应计数，不回传 Cookie、密码或整页原始状态。
- 六站点页内分析不新增 HTTP 路由：桌面端内部 `commerce:capture-assistant-context({tabId})` 返回 `source=electron-visible-dom-assistant` 的只读可见页快照，前端继续通过既有 `/api/chat` 和 `/api/chat/stream` 的 `page_context` 发送。
- 后端仅接受已标记的千牛、生意参谋、达摩盘、小红书、抖音和 1688 快照；按站点白名单清理 URL 和文本，并把内容标注为“不可信网页资料”。快照中的站点图片 URL 不会传给模型下载，只保留可见文字、结构和图片存在信号；未返回的标题、指标、表格、卡片、评论或图片细节必须在模型回答中视为未返回；不会把快照中的文字当作指令执行。

## 10. 安全

- 不在浏览器控制台、日志和错误弹窗中输出完整 Key。
- 不把 `.env`、`data/api_providers.json`、`data/api_key_profiles.json`、真实请求日志打入发布包。
- 对公网部署前加入登录、CSRF/来源限制、HTTPS、反向代理和速率限制。
