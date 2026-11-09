# 第一阶段只读审计：大熊代码来源与相似度

审计日期：2026-11-09

审计结论先说在前面：**本阶段只识别来源，不改业务代码。** 报告写完即停止，等待用户批准后再进入替换实现。本次没有修改 `main.py`、`static/**`、`desktop/**`、`ComfyUI/**`、`API/**` 或其他产品源码，没有改 `LICENSE` / `NOTICE`，没有清理 Git 历史，没有发布。

## 对照范围

| 角色 | 仓库 | 审计用提交 |
| --- | --- | --- |
| 当前 / 目标 | `jkjk-8614/xiaomei` | `28622ea269cdc1d6e68c61c26a0e15550b9f0700`（`release: publish Xiaomei Canvas v1.21`） |
| 上游大熊 | `hero8152/Infinite-Canvas` | `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e`（2026-08-28 09:39 +0800） |

上游 README 写明该公开项目已于 2026-08-28 停更。小美公开历史的第一笔提交是 `e09d4955`（2026-09-30，`Initial upload of Xiaomei Canvas`）。两边没有共同 merge-base：小美历史是一次性整树导入，再叠加后续发布提交。因此「小美某次提交才开始分叉」这种说法不成立；能证明继承关系的，是文本、函数体和调用链，不是 Git 合并记录。

用户本机 `D:\小美画布` 的 remote 仍指向 `hero8152/Infinite-Canvas`，且工作区有未提交改动。那份目录**不是**本报告的事实来源。以下全部以 GitHub 上的 `jkjk-8614/xiaomei` 与 `hero8152/Infinite-Canvas` 为准。

上游许可（`LICENSE`，两边规范化后一致）限制商业封装，并要求基于其代码的软件保持开源且注明原作者。这是 A 类必须替换实现的原因。替换实现不等于改写许可证文件；`LICENSE` 与历史版权声明保持不动。

## 判定尺

分类只回答来源，不回答「这个功能好不好、要不要下线」。

| 类 | 含义 | 本轮动作 |
| --- | --- | --- |
| A | 大熊受限代码，必须替换实现 | 只出替换纲要，不动代码 |
| B | 有正面证据的小美独立原创 | 本轮**没有**达到这条证据线的模块 |
| C | 已额外授权的第三方，本轮保留 | CainFlow 视角控制 |
| D | 许可证允许的独立依赖，按条件保留 | ComfyUI、DeepSeek Harness、MIT 前端库等 |
| E | 来源不明，待核实 | 功能按用户约束保留，不得写成小美原创 |

判 A 的量化门槛（满足任一即可，且要能指出对应文本）：

- 规范化后文本相同，或连续 8 行片段对上游的召回率为 1。
- 上游去重行召回率 ≥ 0.55，或 8 行片段召回率 ≥ 0.25，或最长连续相同行 ≥ 40。
- 上游函数里，同名且函数体高度相同（精确或比率 ≥ 0.80）的占多数。
- 文件是从上述 A 文件抽出去的连续代码块（例如编辑器公共函数）。

明确**不算**独立的处理：改名、调格式、翻译界面文案、AI 改写、删署名、把函数拆小、把同一公式换一个参数列表。这些仍然是 A。

来源对不上大熊、又没有作者证据的，一律 E。E 可以继续使用，但不能在后续 PR 里被叫成「已原创」。

规范化规则：统一换行，去掉空行和整行注释，压缩空白。8 行片段使用按行内容稳定的哈希，避免「两个文件各自编号」造成的假低相似。函数体用同一规范化文本的 SHA1。Python 用语法树取函数；JavaScript 只统计 `function 名称()` 声明，且函数体短于 8 行或长于约 1200 行的不进入函数表。所以函数数字是**下限**，文件级行召回和最长连续行才是主体证据。

## 1. 大熊代码来源与相似度审计报告

### 1.1 仓库形态

上游公开树大约 174 个文件，核心是单文件 `main.py`（约 1.9 万行）和 `static/js` 里的画布、设置、素材脚本。其中没有 Electron 工程，没有 `desktop/`，没有设计大脑、商品分析、SKU、批量生成这些独立包，也没有 CainFlow 相机文件。

小美当前树约 1.7 万个文件。多出来的大头是 `ComfyUI/`、`vendor/deepseek-harness/`、`static/photocraft/`、桌面端和一批根目录 Python 模块。同路径文件 136 个。上游有而小美没有的，主要是嵌入式 wheel、`API/.env`、`static/comfyui-settings.html`、MiniMax 工作流 JSON、Midjourney/ModelScope 的部分旧路由，以及一张打赏图。小美用 `API/.env.example`，没有把上游 `.env` 带进仓库，这一点应保持。

小美 `README.md` 已写明项目基于 Infinite-Canvas 二次开发，并感谢 hero8152 与 CainFlow。`NOTICE` 单独记载 CainFlow、qrcode-generator、perfect-freehand、Real-ESRGAN。这些声明和下面的文本测量一致。

### 1.2 重点文件测量

「行召回」= 上游规范化去重行里，仍出现在小美同路径文件中的比例。「片段召回」= 上游连续 8 行窗口仍出现在小美文件中的比例。「小美占比」= 小美文件自己的 8 行窗口里，能在上游找到的比例。最长连续行是两边都存在的最长相同代码段。

| 文件 | 行召回 | 片段召回 | 小美占比 | 最长连续行 | 函数（上游 / 精确同体 / 近同 / 同名改写） | 类 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `static/js/canvas.js` | 0.878 | 0.823 | 0.917 | 1488 | 566 / 454 / 34 / 11 | A |
| `static/css/api-settings.css` | 0.970 | 0.953 | 0.714 | 1559 | — | A |
| `static/js/api-settings.js` | 0.862 | 0.618 | 0.442 | 1242 | 135 / 76 / 25 / 21 | A |
| `static/js/asset-manager.js` | 0.918 | 0.658 | 0.393 | 190 | 167 / 101 / 29 / 30 | A |
| `main.py` | 0.841 | 0.568 | 0.208 | 492 | 652 / 344 / 95 / 108 | A 内核 + 文件内追加 |
| `static/js/smart-canvas.js` | 0.785 | 0.479 | 0.247 | 432 | 687 / 296 / 90 / 151 | A 内核 + 文件内追加 |
| `static/css/canvas.css` | 0.862 | 0.767 | 0.731 | 254 | — | A |
| `static/index.html` | 0.807 | 0.611 | 0.401 | 264 | — | A |
| `static/canvas.html` | 0.873 | 0.782 | 0.782 | 142 | — | A |
| `static/js/canvas-list.js` | 0.937 | 0.682 | 0.431 | 272 | 39 / 24 / 7 / 5 | A |
| `static/js/theme.js` | 0.979 | 0.775 | 0.548 | 175 | 10 / 7 / 1 / 2 | A |
| `static/js/history-bulk-manager.js` | 1.000 | 0.960 | 0.893 | 143 | 5 / 4 / 1 / 0 | A |
| `static/smart-canvas.html` | 0.837 | 0.446 | 0.179 | 60 | — | A |
| `static/css/asset-manager.css` | 0.870 | 0.416 | 0.240 | 58 | — | A |
| `static/css/smart-canvas.css` | 0.593 | 0.093 | 0.017 | 28 | — | A（规则被打散后仍在） |
| `static/api-settings.html` | 0.636 | 0.314 | 0.325 | 61 | — | A |
| `static/asset-manager.html` | 0.370 | 0.000 | 0.000 | 5 | — | A-trace（壳改大，逻辑在 JS） |
| `static/js/canvas-editor-core.js` | 上游无此路径 | 对 `canvas.js` 有 10 行连续块 | — | 10 | — | A（从经典画布抽出） |

读这张表时要同时看「行召回」和「小美占比」：

- `canvas.js` 两边几乎是同一份程序。小美占比 0.917，说明这个文件的主体就是上游代码，追加很少。上游函数 80%（454/566）规范化后函数体哈希相同；同名可对上的达到 88%。`screenToWorld`、`performUndo` 与上游逐行相同。`renderNode` 同名比率 0.94，`startBoardPan` 0.83。
- `smart-canvas.js` 和 `main.py` 是另一种形态：上游内容大部分还在（行召回 0.79 和 0.84，同名函数能对上的约 78% 和 84%），但文件已经长出一倍以上，所以「小美占比」只有 0.25 和 0.21。多出来的函数**坐在继承文件里面**，通过 `pushUndo`、`scheduleSave`、`createNode`、`/api/canvases` 和原来的节点结构工作。它们没有单独的作者证据，标 E（依附于 A），不能剪下来当作已独立模块。
- `static/css/smart-canvas.css` 上游去重行仍有 59% 留在文件里，但连续片段只剩 9%。这是打散、穿插、追加之后的样式表，不是重写后的新设计系统。按「格式化不算独立」，继承规则仍是 A；文件里对不上的选择器标 E。

`static/js/canvas-editor-core.js` 全文件只有约 205 行规范化文本，和整份 `canvas.js` 的 8 行片段重合很低，但存在一段 10 行连续相同的文字测量代码（`measureText`、`actualBoundingBoxAscent`、`pad = size * 0.18`），对应经典画布里的编辑文字命中逻辑。同文件的 `screenToWorld(clientX, clientY, rect, viewport)` 仍是上游公式：`(client - rect 原点 - viewport 平移) / viewport.scale`。这是抽出的公共函数，标 A，随画布视口一起换掉。

### 1.3 坐标公式没有被换掉

上游 `static/js/smart-canvas.js` 的 `screenToWorld` / `applyViewport` 是：

- 屏幕点换世界点：`(clientX - shell.left - viewport.x) / viewport.scale`，Y 同理。
- 世界容器：`translate(viewport.x, viewport.y) scale(viewport.scale)`。

小美经典画布 `static/js/canvas.js` 的 `screenToWorld` 与这个公式一致，且与上游该函数逐行相同，只是元素从 `shell` 换成 `board`。`applyViewport` 仍写 `translate3d(...) scale(...)`。

小美 `smart-canvas.js` 把 `screenToWorld` 收成一行，转给 `clientToWorldPoint` → `createClientToWorldMapper`。映射器优先用连线 SVG 的 `getScreenCTM()`，以便应付 iframe、CSS zoom 和 Electron。失败时的回退仍是同一公式，分母改成 `world` 矩形宽高比，最后一档仍是 `(client - shell 原点 - viewport.x) / viewport.scale`。`viewportCenter` 也仍是 `(半宽 - viewport.x) / viewport.scale`。`applyViewport` 的第一件事实操作仍是给 `#world` 写 `translate(...) scale(...)`。

因此：后面加上的矩阵缓存、协作光标和工具条反向缩放，是在大熊视口模型上的追加，不是另一套坐标系。阶段 1 要换的是这套模型和它的渲染循环，外部画布 JSON 里的 `viewport: {x, y, scale}` 与节点 `x/y` 继续可读。

### 1.4 撤销、保存和路由

经典画布 `pushUndo` / `performUndo` 与上游相同：快照是 `nodes` 与 `connections` 的 `JSON.parse(JSON.stringify(...))`，上限后丢弃最旧一帧，撤销时直接替换数组并 `render()` + `scheduleSave()`。

小美画布把同一快照拆成 `snapshotForUndo`、`pushUndo`、`performUndo`、`performRedo`、`restoreSmartUndoSnapshot`。`snapshotForUndo` 与上游的字段一致（`nodes`、`connections`、`selectedId`、`selectedIds`、`selectedImage`），小美多记了 `composerReferences`。`performUndo` 相对上游那一版加了 `redoStack`。快照结构本身仍是 A；重做栈是依附在 A 上的追加，标 E。`pushUndo()` 在 `smart-canvas.js` 里被节点拖拽、分组、粘贴、生成和菜单大量调用，是阶段 3 的扇入点。

保存链路：

- 读：`loadCanvas()` → `GET /api/canvases/{id}`。该函数与上游同名比率约 0.61，加载后多了分享、协作、旧节点迁移和视口落在空白处时的重新适配。
- 写：`saveCanvas()` 现在只是队列，真正发送在 `performCanvasSave()`。非增量时 `PUT /api/canvases/{id}`，体为 `title`、`icon`、`nodes`、`connections`、`viewport`、`logs`、`settings`。协作增量走 `PATCH /api/canvases/{id}/nodes`。
- 上游同样有 `GET` 与 `PUT /api/canvases/{canvas_id}`。小美 `main.py` 的 `load_canvas` 同名比率约 0.75。

`@app` 路由：上游 164 条，小美 361 条，两边路径与方法都相同的 154 条。上游 164 条里有 154 条原样留在小美，约占 94%。上游有而小美 `@app` 上不再出现的 10 条，包括 Midjourney、`/api/ms/generate`、角度云轮询、MiniMax 导出和旧的 `POST /generate`。小美多出来的 207 条集中在设计大脑、商品分析、Agent、Skills、分享和协作，这些路由名本身不能证明实现原创，只说明产品表面是后加的。

两边都还在的关键路由包括：`GET/PUT /api/canvases/{canvas_id}`、`GET /api/providers`、`PUT /api/providers`、`POST /api/providers/fetch-models`、`POST /api/providers/test-connection`、`POST /api/generate`、`POST /api/canvas-image-tasks`、`GET /api/canvas-image-tasks/{task_id}`、`POST /api/canvas-video`、`POST /api/canvas-llm`、`GET /api/history`、`GET/POST /api/local-assets/*`、`/api/asset-library/*`、RunningHub 与即梦、ComfyUI 实例。这组路由是约束 8 要保住的协议面：替换的是处理函数正文，路径、字段和用户素材目录约定要留下来。

`main.py` 共享的请求模型包括 `GenerateRequest`、`CanvasSaveRequest`、`CanvasCreateRequest`、`ApiProviderPayload`、`ImageTaskQueryRequest`、`ConnectionManager`，以及一整组素材库请求体。上游已不再出现的类主要是 `Midjourney*Request`、`MsGenerateRequest`、`CloudGenRequest`、`MiniMaxTimeline*`。小美多出的类名集中在 `DesignBrain*`、`CommerceAnalysis*`、`AgentSkill*`、`CanvasShare*`、`CanvasAgent*`。类同名不等于函数体相同；函数体证据见上表。

### 1.5 字节级相同的同路径文件

下列文件规范化后与上游相同（第三方库另标 D，见第 3 节）。它们是 A，除非另行注明：

- 画布与界面：`static/js/comfyui-settings.js`、`static/js/image-preview.js`、`static/js/ltx-director-timeline.js`、`static/js/touch-mouse.js`、`static/js/i18n-core.js`、`static/js/i18n/comfyui-settings.js`、`static/js/i18n/validate-i18n.js`、`static/css/comfyui-settings.css`
- 提示词底稿：`static/system-prompts/infinite-canvas-prompt-templates.md`
- RunningHub 静态清单：`static/runninghub/api_providers.json`（规范化后几乎相同）
- 浏览器采集插件：`tools/chrome-local-asset-importer/` 下的 `background.js`、`popup.js`、`popup.css`、`popup.html`、`sidepanel.html`、`manifest.json`、`README.md` 全部相同
- Photoshop 连接器：`tools/photoshop-asset-connector/` 中 `js/agent.js`、`app.js`、`net.js`、`ps.js`、`socket.js`、`sources.js`、`state.js`、`ui.js`、`style.css`、`manifest.json`、`README.md` 相同；`js/generate.js` 片段召回 0.878、最长连续 382 行；`index.html` 片段召回 0.959
- 工作流 JSON：`workflows/2511.json`、`Flux2-Klein.json`、`LTXDirectorv2-API.json` 及其 config、`Z-Image.json`、`Z-Image-Enhance.json`、`upscale.json`
- 启动与 CLI 脚本：`mac-启动服务.sh`、`mac-启动服务.command`、`mac-安装依赖.sh`、`mac-修复权限.command`、`MAC-使用说明.md`、即梦登录脚本、多数 Gemini/即梦/Codex 安装脚本、`运行说明.txt`
- 许可证正文：`LICENSE` 与上游一致。本审计及后续替换都不得改这个文件

词典不是整包字节相同，但上游句子大多还在，标 A：`static/js/i18n.js` 行召回 0.958、片段召回 0.882；`static/js/i18n/canvas.js` 行召回 0.982、片段召回 0.867；`static/js/i18n/common.js` 行召回 0.796、片段召回 0.108（句子还在，顺序被打散）；`static/js/i18n/api-settings.js` 行召回 0.803、片段召回 0.403；`static/js/i18n/smart-canvas.js` 行召回 0.907、片段召回 0.498；`static/js/i18n/studio.js` 行召回 0.967、片段召回 0.539。这三份仍保留上游词典的大部分句子，并追加了键，不是新写的词典。`static/angle.html`、`enhance.html`、`klein.html`、`zimage.html`、`gpt-chat.html`、`online.html` 都有上百行连续相同。`安装依赖.bat` 片段召回约 0.97。`新手运行与使用教程.md` 仍有约 279 行连续相同，其中还留着 `D:\Infinite-Canvas\` 这类路径，标 A（文档），替换代码时不要顺手把它改写成「已与大熊无关」。

`static/css/canvas-editor-common.css` 对上游 `static/css/canvas.css` 的片段精度约 0.61，标 A，跟经典画布样式一起换。

### 1.6 跨文件搜索

对小美里不在 `ComfyUI/`、`vendor/`、`static/photocraft/`、wheel 包中的源码做了上游全树 8 行片段索引（约 12.2 万个窗口）。除同路径文件和上面抽出的 CSS / `canvas-editor-core.js` 外，**没有**再发现另一份业务文件以 ≥ 8% 的片段精度整段搬自上游。

这只说明那些文件的**表面文本**对不上这份公开的 Infinite-Canvas。它不证明作者是小美。小美第一笔提交已经是完整大树，导入之前的来源（包括上游停更后的非公开版本）无法用这段 Git 历史核销。所以这些文件标 E。

抽查过、片段精度为 0、体积较大的文件包括：`design_brain_*.py`、`static/js/design-brain.js`、`static/js/commerce.js`、`static/js/commerce-analysis.js`、`static/js/smart-canvas-sku.js`、`static/js/canvas-folder-batch.js`、`canvas_folder_batches.py`、`static/js/product-3d.js`、`product_fidelity.py`、`canvas_image_layers.py`、`static/js/canvas-agent.js`、`multi_agent_*.py`、`runtime_paths.py`、`main.cjs`、`desktop/main.cjs`、`desktop/updater.cjs`、`static/history.html`、`static/js/smart-camera-node.js`。

`packages/photoshop-bridge/main.js` 与上游 Photoshop 连接器各 JS 文件的去重行交集只有约 9 到 10 行，Jaccard 约 0.01。新桥接标 E；旧的 `tools/photoshop-asset-connector/` 仍是 A。两套同时存在。保留 PS 修图，指的是能力留下来，不是把 A 类连接器改个名留着。

### 1.7 节点类型

经典画布两边共有的 `type` 包括 `image`、`generator`、`video`、`llm`、`comfy`、`prompt`、`group`、`loop`、`ltx-director`、`rh`、`enhance`、`klein`、`zimage`、`workflow`。这些类型的创建、渲染和运行函数落在 A 类 `canvas.js` 里。

小美画布两边共有：`smart-image`、`smart-prompt`、`smart-loop`、`smart-group`。上游还有 `smart-minimax`，当前小美树没有。替换时不必为了「对齐上游」把 MiniMax 节点加回来。

只在小美常量里出现、上游文件没有的类型包括：`smart-upload`、`smart-paint`、`smart-video`、`smart-ai-render`、`oneClickReplica`、`smart-product-fidelity`、`smart-comfy-workflow`、`smart-drawing-board`、`smart-camera`、`smart-compare`、`smart-color`、`smart-table`、`smart-timeline`。类型名是产品表面。实现若写在 `smart-canvas.js` 内部，随该文件标 E（依附于 A）；若写在独立文件且片段精度为 0，文件本身标 E 或 C（相机）。旧画布里这些 `type` 字符串都要继续读得出来。

### 1.8 方法边界

- 第一轮跨文件片段哈希曾按「每个文件单独编号」，那个召回率作废，没有写入上表。本报告的片段召回、行召回和最长连续行来自内容稳定哈希的复算。
- JavaScript 箭头函数、对象方法和嵌在大函数里的闭包没有逐个命名。`smart-canvas.js` 里大量逻辑在长函数中，文件级 0.785 的行召回已经把它们算进去了。
- 没有把小美当前文件去对上游每一个历史 blob 做第二轮片段召回。上游 HEAD 已是公开仓库最后一次更新；小美导入日晚于这一天。字节级相同的文件，用当前 HEAD 就足以定性。
- 没有克隆 CainFlow 做逐函数 diff。C 的依据是仓库内 SPDX、`NOTICE`、交付文档和用户的额外授权，加上该文件对大熊的片段精度为 0。
- 没有把 `D:\小美画布` 的未提交 diff 算进来。若那份工作区还有另一批来源，需要第二阶段单独对照。

## 2. 必须替换的文件和函数清单

下面每个 A 类模块都给出路径、关键函数、谁在调用、影响面，以及**独立重写**纲要。纲要指新的模块边界和数据合同，不是逐行对照改写清单。获准实施前，这些函数一个都不要动。

### 2.1 经典画布引擎 `static/js/canvas.js`（A，整文件）

关键函数：

- 视口与渲染：`screenToWorld`、`applyViewport`、`currentWorldViewRect`、`renderMinimap`、`updateMinimapViewport`、`minimapEventToWorld`、`centerViewportOnWorldPoint`、`fitAllNodesViewport`、`startBoardPan`、`renderNode`、`scheduleLinksRender`
- 节点：`createNodeByType`、`addLoopNode`、`addLLMNode`、`addVideoNode`、`addRhNode`、`addLTXDirectorNode`、`addComfyNode`、`openLinkCreateMenu`、`defaultNodeSize`、`cropDragModeFromPointer`
- 历史：`pushUndo`、`performUndo`、`startSelection`、`updateSelectionBox`、`finishSelection`、`cloneNode`、`duplicateNodesForAltDrag`
- 文档：`scheduleSave`、`saveCanvas`、`applyRemoteCanvasData`、`loadCanvasList`、`serializableCanvasNode`
- 生成：`renderGeneratorBody`、`renderVideoBody`、`runGenerator`、`pollCanvasImageTask`、`createCanvasComfyTask`、`imageModelOptions`、`videoModelOptions`

引用关系：`static/canvas.html` 在 `canvas-editor-core.js` 之后加载本文件。页面上的板、世界层、小地图、连线层都由这些函数直接改 DOM。保存打到 `PUT /api/canvases/{id}` 一类接口；生成打到 `/api/canvas-image-tasks`、`/api/canvas-video`、`/api/canvas-llm`、`/api/generate` 和 Comfy 任务接口。`canvas-editor-core.js` 从这里抽出文字测量和坐标换算，`canvas-editor-common.css` 从 `canvas.css` 抽出样式。

影响面：旧版画布页、画布列表里打开的非智能画布、生成器 / 视频 / LLM / Comfy / RunningHub / LTX 时间轴节点、框选、撤销、快捷键。`ltx-director-timeline.js` 与本文件一起工作，且该时间轴文件与上游字节级相同。

替换纲要：新建一套不从本文件裁剪的经典画布运行时。对外只保留三件事：旧 JSON（节点 `type/x/y/w/h`、连线 `from/to`、`viewport`）、现有 HTTP 路径、现有快捷键行为。内部用独立的视口对象、命中测试和命令历史，DOM 结构可以重做，但用户看到的板、节点卡片、连线和缩放百分比要保持。不要在旧函数体内改公式。

### 2.2 小美画布内核 `static/js/smart-canvas.js`（A 内核；文件内新增函数标 E）

关键继承函数（精确同体或同名比率 ≥ 0.8 的代表）：

- 视口：`minimapEventToWorld`、`exitZoomPreview`、`exitZoomPreviewToNode`、`applyImageEditZoom`；`renderMinimap`、`nodeScale` 为同名改写（比率 0.52、0.63）。`applyViewport`、`screenToWorld`、`clientToWorldPoint`、`createClientToWorldMapper` 见 1.3 节，模型仍是 A。
- 节点与分组：`exportSelectedSmartWorkflow`、`smartGroupLayoutSize`、`smartGroupMembers`、`smartGroupImageRefs`、`groupImageGridLayout`、`connectedSmartClusterIds`、`translateSmartNodeWithMembers`、`addNodeToSmartGroup`、`arrangeSmartGroupMembers`、`arrangeSmartIdsByConnections`、`createNode`、`createNodeFromMenu`
- 撤销：`snapshotForUndo`、`pushUndo`、`capturePendingUndo`、`commitPendingUndo`；`performUndo` / `performRedo` / `restoreSmartUndoSnapshot` 是在同一快照上的拆分
- 文档：`mediaItemForStorage`、`canvasForStorage`、`loadCanvas`、`saveCanvas`、`performCanvasSave`、`scheduleSave`、`normalizeLegacySmartNode`
- 运行：`volcengineProvider`、`runningHubEntries`、`renderRunningHubParams`、`renderComfyParams`、`renderComfySettingField`、`isGptImageAutoSizeModel`、`playGenerationCompleteSound`、`uploadMediaRefToCloud`
- 素材侧栏：`localAssetFolderCategories`、`assetThumbHtml`、`renderAssetLibrary`、`bindAssetItemEvents`、`showAssetHoverPreview`

引用关系：`static/smart-canvas.html` 是宿主。它还加载相机节点（C）、`canvas-editor-core.js`（A）、以及复刻、SKU、批量、图层、画板、专家流等独立脚本（E）。内核用 `pushUndo` 包住几乎所有变更，用 `scheduleSave` 把文档送到 `/api/canvases`。节点运行再调用与 `main.py` 共享的生成和素材路由。`window.SmartCanvasReplica`、`SmartExpertWorkflow`、`ProjectAgent`、`CanvasAgentReferenceBridge` 是后加脚本挂到这个内核上的口子。

影响面：主工作台、旧智能画布 JSON、分组、连线、小地图、生成、素材侧栏、工作流导入导出。设计大脑、商品分析、3D、相机提示词若只通过节点类型和 HTTP 与内核交接，可以留在核外；一旦把它们的逻辑继续写进这个文件，就会重新黏回 A。

替换纲要：按第 4 节的顺序重写内核，而不是把 3.7 万行文件「清理一遍」。新内核提供稳定的文档模型、视口、命中、连线、历史和保存端口。现有 E/C 脚本只允许依赖这些端口和旧的 `type` 字符串，不允许复制 `pushUndo` 或坐标公式。同文件里对不上上游的函数（第一轮统计约 688 个具名函数）在新内核上按行为重接，不整段剪切。

### 2.3 后端单体 `main.py`（A 内核；后加路由标 E）

关键继承函数（代表，不是全表）：

- 平台与任务：`model_list`、`normalize_provider`、`get_api_provider`、`get_api_provider_exact`、`provider_endpoint_url`、`default_api_providers`、`test_provider_connection`、`normalize_runninghub_entry`、`merge_runninghub_system_entries`、`collect_required_comfy_media`，以及约 105 个精确同体的模型/任务函数
- 画布文档：`load_canvas`、`load_projects`、`ensure_default_project`、`project_record`、`export_canvas_workflow`、`import_canvas_workflow`、`export_smart_canvas_group`
- 素材：`storage_kind_dir`、`_storage_abs_path`、`load_asset_classification_prompt`、`import_local_assets_from_urls`、`volcengine_ensure_asset_group`
- 共享类：`GenerateRequest`、`CanvasSaveRequest`、`ApiProviderPayload`、`ConnectionManager`、`QuietAccessLogFilter` 及素材库请求体一族

上游 652 个足够长的函数里，344 个函数体哈希相同，95 个同名近同，108 个同名但已改写。三者合计覆盖上游函数的约 84%，与 0.841 的行召回一致。小美侧另有约 1024 个对不上的具名函数，以及设计大脑、商品分析、Agent 等通过 `include_router` 挂进来的模块。那些路由文件文本对不上大熊，标 E；它们调用的若是上面这些 A 函数，替换 A 时要给 E 留原来的 URL 和字段。

影响面：全部页面的生成、轮询、历史、画布读写、素材路径、RunningHub、即梦、Comfy 实例。桌面端和浏览器都打这一个进程。

替换纲要：不要把 `main.py` 按行拆开就算完成。按协议面切新的服务模块：画布文档、任务调度、平台适配、素材存储。每个模块用新的内部类型，在边界上转换成现在的 JSON。`CanvasSaveRequest` 仍接受没有版本号的旧画布。用户数据目录继续走现有 `runtime_paths` 约定（该文件本身标 E，行为必须保留）。`API/.env` 仍只存在于用户机器，仓库只留 example。

### 2.4 API 设置 `static/js/api-settings.js` 与 `static/css/api-settings.css`（A）

上游函数 135 个，精确同体 76，近同 25，同名改写 21，合计约 90%。样式表片段召回 0.953，最长连续 1559 行。页面 `static/api-settings.html` 同样是 A。

关键行为：平台列表、拉模型、协议探测、连接测试、密钥配置。前端只许继续调用 `GET/PUT /api/providers`、`POST /api/providers/fetch-models`、`POST /api/providers/test-connection`、`POST /api/providers/probe-async`。禁止把模型下拉重新写死，这是项目既有规则，也是这次替换的验收项。

替换纲要：新的设置页只描述「平台记录 + 探测结果」。请求体沿用 `ApiProviderPayload` 的外部字段。界面布局保持现在的设置页，样式表按新页面重写，不从旧 CSS 删选择器。

### 2.5 素材库 `static/js/asset-manager.js`（A）

上游函数 167 个，精确同体 101，近同 29，同名改写 30，合计约 96%。行召回 0.918。`static/css/asset-manager.css` 行召回 0.870。HTML 壳改动较大（最长连续只有 5 行），标 A-trace，逻辑以 JS 为准。

关键函数覆盖分类、库、批量移动/删除/裁切、重命名、上传和悬停预览，对应 `/api/asset-library/*` 与 `/api/local-assets/*`。画布侧栏里的 `renderAssetLibrary`、`localAssetFolderCategories` 是同一套数据的另一入口，必须和素材页一起换，避免两套分类规则。

替换纲要：新的素材索引服务拥有库、分类、文件 ID 和缩略图。画布侧栏和素材页都只调用它。磁盘上的用户目录结构不变，不迁移、不覆盖已有素材。

### 2.6 壳、样式和卫星页面（A）

| 路径 | 证据 | 和谁一起换 |
| --- | --- | --- |
| `static/index.html` | 行召回 0.807，最长连续 264 | 阶段 6，应用壳 |
| `static/canvas.html` | 行召回 0.873，片段召回 0.782 | 阶段 1–3，经典画布宿主 |
| `static/smart-canvas.html` | 行召回 0.837，最长连续 60 | 阶段 1–3，智能画布宿主 |
| `static/css/canvas.css` | 片段召回 0.767，最长连续 254 | 阶段 1 |
| `static/css/smart-canvas.css` | 上游行仍在 59%，片段已被打散 | 阶段 1 和 6 |
| `static/css/canvas-editor-common.css` | 61% 片段来自上游 `canvas.css` | 阶段 1 |
| `static/js/canvas-editor-core.js` | 抽出的测量与坐标 | 阶段 1 |
| `static/js/canvas-list.js`、`static/canvas-list.html`、`static/css/canvas-list.css` | 行召回 0.94 量级 | 阶段 4 |
| `static/js/theme.js`、`static/css/theme.css` | 行召回 0.979 与 0.910 | 阶段 6 |
| `static/js/touch-mouse.js` | 字节级相同 | 阶段 1，指针 |
| `static/js/image-preview.js` | 字节级相同 | 阶段 6 |
| `static/js/history-bulk-manager.js` | 片段召回 0.960 | 阶段 6，历史批量 |
| `static/js/comfyui-settings.js` 与其 CSS | 字节级相同 | 阶段 5，Comfy 设置页。运行时页面可由 `ComfyUI/web` 提供，这份静态脚本仍是 A |
| `static/js/ltx-director-timeline.js` | 字节级相同，约 3465 行 | 阶段 2，LTX 节点 |
| `static/js/i18n-core.js`、`i18n/comfyui-settings.js`、`i18n/validate-i18n.js` | 规范化后相同 | 阶段 6 |
| 其余 `static/js/i18n.js` 与 `static/js/i18n/**` | 行召回 0.796–0.982，见 1.5 节 | 阶段 6。文案可以保留意思，文件不能靠翻译假装独立 |
| `static/angle.html`、`enhance.html`、`klein.html`、`zimage.html`、`gpt-chat.html`、`online.html` | 最长连续 83–303 行 | 阶段 5 和 6 |
| `static/system-prompts/infinite-canvas-prompt-templates.md` | 字节级相同 | 阶段 6，系统提示词库 |
| `static/runninghub/api_providers.json` | 几乎相同 | 阶段 5，静态清单 |

### 2.7 工具、工作流和脚本（A）

- `tools/photoshop-asset-connector/**`：除 `generate.js` 和 `index.html` 有少量差异外，其余为字节级相同。PS 修图能力要留，这份连接器的实现要换。`packages/photoshop-bridge/` 是另一份、文本几乎不重合的桥，标 E，不能把 A 文件合并进去充数。
- `tools/chrome-local-asset-importer/**`：整包相同。浏览器采集若继续随产品分发，需要新写扩展，清单和弹层都不要从这份改。
- `workflows/*.json` 中与上游相同的那些图：是随上游仓库分发的工作流数据，标 A（数据）。用户自己的工作流不在这批哈希里，替换时不要覆盖用户目录中的 JSON。
- CLI 安装脚本、`mac-*.sh`、`mac-*.command`、`运行说明.txt`、`新手运行与使用教程.md`、`安装依赖.bat`：同源脚本和文档，标 A。改功能时不要只做中文润色。

### 2.8 不在「必须替换」里、但容易误判的边界

- `LICENSE`：与上游一致，**保留文件，禁止修改**。要换的是受它约束的程序文本。
- `get-pip.py`、`static/vendor/js/three-0.160.0.module.js`、`lucide.js`、`tailwindcss-cdn.js`、`fonts.css`：字节也与上游那份镜像相同，权利人不是大熊，标 D。
- 电商工作台 `static/js/commerce.js`、商品分析、SKU、批量生成：文本对不上大熊，**不是** A，也**不是**本审计建议删除的对象。见第 3 节。

## 3. 可以直接保留的小美功能清单

「保留」在这里的意思是：下一阶段不要把它们当成大熊受限代码去替换，也不要因为电商工作台过时而删掉仍在使用的独立入口。它**不等于**已证明为小美原创。

### 3.1 B 类

**本轮 B 类为空。** 公开的两段 Git 历史里，没有任何一个模块同时具备「对大熊全树无实质文本继承」和「可核验的独立作者记录」。小美第一笔提交是整树上传，上传前的写作过程不在仓库里。把对不上的文件写成原创，会直接违反本次约束 12。

### 3.2 C 类：本轮保留，不建议替换

| 模块 | 依据 | 保留条件 |
| --- | --- | --- |
| `static/js/smart-camera-node.js` | 文件头 SPDX `GPL-3.0-or-later`，写明改编自 RingoCaviar/CainFlow 的相机控制和提示词编译；`NOTICE` 与 `交付文档/03-API与模型适配.md` 一致。对大熊片段精度为 0。用户已给额外授权 | 继续只编译相机提示词，不在这个文件里调用生图。不要把它并进新的画布内核源文件，以免 GPL 文本和将来的替换内核搅在一起。`smart-canvas.js` 里的 `normalizeSmartCameraNode` 和菜单入口是集成点，换内核时重接，不重写相机算法 |

本轮没有对照 CainFlow 上游逐函数核对改编幅度。若以后要改相机算法，先做那次对照。本轮不建议替换。

### 3.3 D 类：独立依赖，按许可证条件保留

| 依赖 | 许可证证据 | 条件 |
| --- | --- | --- |
| `ComfyUI/core` 及随包自定义节点 | `ComfyUI/core/LICENSE` 为 GPL-3.0；部分自定义节点为 MIT 或 GPL。上游 Infinite-Canvas 树里没有这份 ComfyUI 源码 | 按用户要求保留。分发时遵守 GPL。GPU/CUDA 运行时继续走现有按需安装脚本，不要写回基础依赖。`static/js/comfyui-settings.js` 是大熊那份设置脚本，属 A，和 ComfyUI 本体不是一回事 |
| `vendor/deepseek-harness` | 根 `LICENSE` 为 MIT，Copyright (c) 2026 DeepSeek | 保留版权头和 MIT 声明。小美自己的接线（如 `deepseek_harness.py`、对话页里的 MCP 入口）文本对不上大熊，标 E，随 DeepSeek 能力一起留 |
| `static/vendor/js/three-0.160.0.module.js` | 上游镜像与小美字节相同；上游 `MANIFEST` 指向 three r160 | 保留 three 的许可证。3D 软装页面 `static/js/product-3d.js` 对大熊片段精度为 0，标 E |
| `lucide.js`、`tailwindcss-cdn.js`、`fonts.css` 与配套字体 | 两边 `MANIFEST` 都写明是本地镜像 | 按各自上游许可证保留，不把字体和脚本改写成「小美资源」 |
| `perfect-freehand`、`qrcode-generator`、`ag-psd` / pako、Fluent UI 本地包 | `NOTICE` 与 `static/vendor/MANIFEST.md` | 保留声明。画板节点 `smart-drawing-board-node.js` 对大熊片段精度为 0，标 E，可以继续调用 perfect-freehand |
| `get-pip.py` | 字节级相同的 pip 引导脚本 | 第三方引导器，不是大熊业务代码 |
| `requirements.txt` 中的 FastAPI、Uvicorn、httpx、Pillow、ONNX Runtime CPU 等 | 各自的上游许可证 | 保持 CPU 版 ONNX Runtime 的现有发布约束 |

### 3.4 E 类：对大熊无文本命中，作者未证实，功能保留

这些文件在上游全树 8 行片段索引里的精度为 0（或仅有个位数行的通用语句）。它们可以继续留在产品里。后续如果发现另一处上游（例如非公开的 DX-OS 或其他仓库）有同样文本，再降级重判。在那之前，不要称它们为原创，也不要因为「不像大熊」就删。

设计、对话与代理：

- `design_brain_*.py`、`static/js/design-brain.js`、`static/js/design-brain-team.js`、`static/design-brain.html`、`static/css/design-brain.css`
- `static/js/canvas-agent.js`、`project-agent`、`multi_agent_*.py`、`agent_skill_store.py`、`skill_capabilities.py`、`static/js/skill-market.js`
- DeepSeek 接线与 MCP 设置（配置仍只有 `data/mcp_servers.json` 这一份）

电商相关，分开对待：

- `static/js/commerce.js` 与 `static/commerce.html`：对大熊无文本命中。产品上电商工作台已废弃。本审计**不**把它判成可删除；要不要下线是单独的产品决定，不能借这次替换顺便删。
- `static/js/commerce-analysis.js`、`tools/commerce-analysis/**`、对应 CSS 和 `/api/commerce-analysis/*`：商品分析，保留。
- `static/js/smart-canvas-sku.js`、`canvas_sku.py`：SKU，保留。
- `static/js/canvas-folder-batch.js`、`canvas_folder_batches.py`：批量生成，保留。
- `product_fidelity.py`、`static/js/product-fidelity.js`、`static/js/smart-product-retouch.js`、`local_fusion.py`、`image_vectorizer.py`、`canvas_image_layers.py`：商品保真、修图、融合、分层，保留。

其他用户点名要留的表面：

- 历史页 `static/history.html`（文本已与上游历史页对不上，标 E；批量操作脚本 `history-bulk-manager.js` 仍是 A）
- 3D 软装 `static/js/product-3d.js`、`static/product-3d.html`（three 本体是 D）
- PS 新桥 `packages/photoshop-bridge/**`（旧连接器是 A）
- 桌面壳 `main.cjs`、`desktop/main.cjs`、`desktop/updater.cjs`、`electron-builder.yml`。上游没有 Electron 工程。壳标 E，继续用 Electron + 本地 FastAPI
- `runtime_paths.py`：用户数据根、旧目录迁移。标 E，路径约定必须原样保留
- 复刻、专家流、比对、调色、表格、时间轴、画板等只存在于小美的节点脚本：文件标 E；若其逻辑实际上写在 `smart-canvas.js` 里，随内核重接

测试文件若只覆盖上述 E 功能，随功能保留，用来防止替换内核时把这些入口弄丢。名字里带 `upstream` 的测试（如 `tests/smart-canvas-upstream-run.browser.cjs`）文本本身对不上大熊，但它锁定的是继承行为，替换阶段应改成对新内核的验收，而不是删掉场景。

## 4. 各模块依赖关系与替换顺序

用户给定的顺序就是依赖顺序。后面的阶段调用前面的阶段，不能倒过来先换 API 却留着旧视口。

```text
静态宿主 (index / canvas.html / smart-canvas.html)
        │
        ▼
阶段 1  视口、缩放、平移、节点渲染、指针
        │  依赖：viewport {x,y,scale}、节点 x/y、CSS 变换
        ▼
阶段 2  拖拽、连线、分组、节点菜单、LTX 时间轴
        │  依赖：阶段 1 的世界坐标和命中
        ▼
阶段 3  撤销、重做、复制粘贴、快捷键、框选
        │  依赖：阶段 2 的文档突变都走同一历史端口
        ▼
阶段 4  保存、读取、旧 JSON 转换、画布列表
        │  依赖：阶段 3 的快照形状 = 对外 JSON
        ▼
阶段 5  平台适配、任务调度、Comfy 设置脚本、RunningHub / 即梦
        │  依赖：阶段 4 的节点上仍挂着原来的 runSettings
        ▼
阶段 6  素材索引、采集插件、PS 连接器、壳、主题、i18n、预览
```

核外保留项（C / D / E）不插进这条替换链，只在对应阶段把挂钩接上：

- 阶段 1 结束时，相机节点（C）、3D 页（E + three D）、画板（E + perfect-freehand D）仍能打开。
- 阶段 4 结束时，旧画布、SKU 节点、批量节点、商品分析页的数据还在。
- 阶段 5 结束时，DeepSeek（D）和 ComfyUI 本体（D）仍走现有进程；被换掉的只是大熊那份 Comfy 设置脚本和 `main.py` 里的任务函数。
- 阶段 6 结束时，素材目录、历史记录和 PS 新桥（E）仍指向原来的用户数据。A 类旧连接器和旧采集插件在新实现验收通过前并列保留，通过之后再从发行包移除。

`main.py` 横跨阶段 4、5、6。实施时按路由组分批替换处理函数，保留 URL。不要在阶段 1 去拆这个文件。

## 5. 每阶段实施步骤及验收标准

每阶段都是一次独立变更，当时的计划是默认关着新内核，用开关打开。旧文件留在树里直到该阶段验收通过。通过前不删除 A 文件。任何阶段都不改 `LICENSE`、不改用户目录、不发布安装包。六个内核的当前默认已经改为 next，回滚仍走这些旧文件，见 `docs/audits/kernel-defaults-next.md`。

### 阶段 1：画布坐标、缩放、平移与节点渲染

步骤：

1. 写新的纯函数视口：世界点、屏幕点、滚轮锚点缩放、平移边界。用测试锁定旧公式的**结果**（同一 `viewport` 下点映射一致），函数体新写。
2. 新渲染循环只消费节点列表和连线列表，输出现在的卡片和线。经典画布与智能画布可以共用视口数学，DOM 类名按各自页面保持。
3. 小地图、适应全部节点、缩放滑杆走同一视口。
4. `canvas-editor-core.js` 的坐标和文字测量改由新模块提供，调用方暂时保留旧签名。
5. 指针命中替换 `touch-mouse.js` 的职责；Electron 下 CSS zoom 与 iframe 的偏差用新映射器的测试覆盖，不复制 `createClientToWorldMapper`。

验收：

- 打开一份现有智能画布和一份经典画布，节点位置与缩放百分比与旧内核一致（允许亚像素 1px 内）。
- 滚轮以光标为锚缩放，拖动画布，小地图点击能把该世界点移到视口中心。
- 连线端点落在节点边缘，不落进卡片内部。
- 相机节点、3D 页、画板仍能打开。
- 此阶段不要求替换拖拽创建和保存；旧内核的那些路径还可以暂时留着，但视口数学不能双份同时写 DOM。

### 阶段 2：节点管理、拖拽、连接、分组

步骤：

1. 新的交互控制器负责按下、移动、松开、框选起点、端口拖线、分组吸收。
2. 节点工厂按 `type` 注册。先注册两边共有的类型，再原样注册只存在于小美的类型，让 E/C 脚本继续挂上。
3. 分组的成员、网格和「按连线整理」用新的布局函数，对照旧画布的分组结果做快照测试。
4. LTX 时间轴改成新的节点附属视图，去掉对字节级相同的 `ltx-director-timeline.js` 的依赖。时间轴的外部 JSON 字段保持可读。

验收：

- 从菜单创建图像、提示词、循环、分组、上传、视频、相机、SKU、批量、Comfy 工作流节点，类型字符串与现在一致。
- 拖拽移动单节点和分组，成员跟随。
- 从输出端口拖到输入端口能连上，删除节点会去掉悬空连线。
- 旧文件里的 MiniMax 类型不会被重新加入。

### 阶段 3：撤销、重做、复制粘贴、快捷键

步骤：

1. 新历史栈记录文档命令或整帧快照，上限行为与现在的 40 步同量级，并保留重做。
2. 阶段 2 的每一种突变只通过历史端口进入文档，禁止模块自己 `JSON.parse(JSON.stringify(nodes))` 后塞进全局数组。
3. 复制、粘贴、Alt 拖拽复制、框选、删除的快捷键与现在相同。
4. 生成进行中的节点在撤销时的保留规则（小美 `restoreSmartUndoSnapshot` 会保住正在跑的任务结果）写成显式策略，并配测试。

验收：

- 移动、连线、分组、粘贴各做一次，撤销与重做后文档 JSON 与操作前一致。
- 生成未完成时撤销，不把正在跑的任务结果抹掉。
- 复制节点得到新 id，不把旧 id 写回造成保存冲突。

### 阶段 4：项目保存、读取与数据转换

步骤：

1. 新的文档存储只在边界上说话：读入现在的画布 JSON，写出现在的 `PUT` 体和增量 `PATCH` 体。
2. 转换器接受没有版本号的旧画布，补齐缺省的 `connections`、`viewport`、`settings`，不改用户已经写下的节点类型和坐标。
3. `load_canvas` / 保存处理函数换成新模块，URL 仍是 `GET/PUT /api/canvases/{id}` 与 `PATCH /api/canvases/{id}/nodes`。
4. 画布列表、回收站、项目 id（`canvasListCurrentProjectId` 这类现有键）继续有效。
5. 分享只读、协作增量若仍由 E 类代码提供，只重接存储端口。

验收：

- 用当前版本保存的画布、以及只含 `nodes` + `viewport` 的更旧画布，都能打开且节点不丢。
- 保存后再读，`type`、`x`、`y`、连线、视口、日志和设置一致。
- 加载未完成时刷新，不会用空画布覆盖服务端。这条是现有 `smartCanvasReady` 在防的事故，新存储必须有同样的闸门。
- 商品分析、SKU、批量生成的节点或页面数据还在。

### 阶段 5：模型 API 适配与任务调度

步骤：

1. 把平台记录、模型列表、任务创建、轮询分成新模块。外部仍是 `ApiProviderPayload`、`/api/providers*`、`/api/generate`、`/api/canvas-image-tasks`、`/api/canvas-video`、`/api/canvas-llm`、历史与即梦、RunningHub 路由。
2. 模型列表继续只来自 `/api/providers` 与 `/api/providers/fetch-models`。
3. 设置页换成新前端，布局保持，旧 `api-settings.js` 在开关后不再加载。
4. ComfyUI 程序本体不动。替换 `comfyui-settings.js` 这份 A 脚本，以及 `main.py` 里精确同体的 Comfy 任务函数。工作流 JSON 若是上游那一批相同文件，改为用户可选的示例，不放进新代码的字符串里。
5. 任务记录仍写入现有历史存储，供历史页和画布节点读取。

验收：

- 现有平台配置不需要用户重新填写即可被新模块读出（只读验证，不回写密钥）。
- 文生图、图生图、视频、LLM、Comfy 任务能创建、能轮询、失败能在节点上看到原因。
- 拉模型失败时界面保持空列表或错误态，不出现写死的模型名。
- DeepSeek 对话和 MCP 设置仍可用。

### 阶段 6：资源管理、公共工具与界面

步骤：

1. 新素材索引实现库、分类、上传、移动、删除、裁切。画布侧栏和素材页共用。磁盘布局不变。
2. 应用壳、主题、预览、历史批量操作换成新界面文件，视觉沿用现在的布局和密度。i18n 键的**意思**保留，词典文件新写。
3. 浏览器采集插件与 Photoshop A 类连接器在新工具验收通过后从发行清单移除。`packages/photoshop-bridge`（E）若已覆盖直连修图，就作为保留实现，并补一次它与旧连接器的行为对照，确认没有把 A 文件再包进去。
4. 启动脚本和教程中的 Infinite-Canvas 路径、按钮说明，在产品行为已经由新内核提供之后再改。那是文档替换，不是这一阶段的第一步。

验收：

- 已有素材库分类、缩略图和画布引用都能打开。
- 历史列表能预览、能批量管理。
- 壳层页面切换、主题、侧栏和现在一致。
- 发行包清单里不再包含第 2 节列出的 A 类源文件；C 与 D 仍在，且许可证声明还在。
- `python -m py_compile main.py` 以及现有与画布、素材、提示词相关的测试通过。浏览器里走通：打开画布、缩放、连线、撤销、保存、再打开、发起一次任务、打开素材、打开相机节点、打开商品分析或 SKU 入口。

## 6. 风险评估与回滚方案

### 6.1 风险

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 把「文件变长」当成已经独立 | `smart-canvas.js` 和 `main.py` 有大量新函数，但内核行召回仍超过 0.78 | 新函数标 E，随内核重接，禁止整段剪切进新文件 |
| 替换时改坏旧画布 | 保存写出新字段或在加载前就保存空文档 | 阶段 4 单独做；加载闸门和往返测试先于切换默认内核 |
| 双视口同时写 DOM | 新旧 `applyViewport` 抢 `#world` | 每阶段只用一个内核写变换；开关互斥 |
| Electron 缩放与 CSS 变换叠加 | 端口和工具条错位 | 阶段 1 用桌面壳加浏览器两种视口做命中测试 |
| 误删仍在使用的电商能力 | 工作台废弃被扩大成删掉商品分析、SKU、批量 | 第 3 节的 E 清单是保留清单；删除需另一次产品决定 |
| GPL 文本混进新内核 | 相机算法或 ComfyUI 源被抄进替换后的画布文件 | C 与 ComfyUI 保持独立文件；新内核只调用结果 |
| 素材和密钥被迁移覆盖 | 替换脚本「整理」用户目录或把 example 写成真实 `.env` | 禁止迁移作业。仓库继续只有 `API/.env.example` |
| 文档润色冒充替换 | 教程和 i18n 只改措辞 | A 类文档和词典按阶段 6 的新文件标准验收 |
| 本地 `D:\小美画布` 与 GitHub 不一致 | 本报告没覆盖的未提交文件后来被当成已审计 | 实施前以 GitHub `xiaomei` 为准再对一次脏工作区；对不上的标 E |
| 一次性替换 `main.py` | 画布、生成、素材同时坏 | 按路由组切换，旧处理函数留到该组验收之后 |

### 6.2 回滚

- 每个阶段一个分支，默认关闭新内核。验收失败时把开关拨回旧脚本，不需要恢复用户数据。
- 旧 A 文件在该阶段验收通过前不删除，所以回滚是配置回退，不是从备份里找代码。
- 不修改用户画布、素材、历史、日志和 `data/`。若某次试验写入了测试画布，只删测试 id。
- 不使用 `git filter-repo`、强推改历史或改 `LICENSE` 来「去掉大熊」。历史保留，许可证文件保留。
- 发布流程不在本阶段启动。即便某一阶段验收通过，也要等全部 A 类发行输入都已替换，再单独走现有发布规则。
- 任一阶段发现新的高相似文件：停在该阶段，把文件补进 A 或 E，得到确认后再继续。不把不确定文件升成 B。

## 审计停止

本文件是第一阶段的全部交付。审计到此停止，等待用户批准后再改产品代码。

未做的事：没有改业务源码，没有改版权和许可证，没有清理 Git 历史，没有打安装包，没有删除旧 Release，没有把任何 E 类模块写成小美原创。
