# 去掉六个内核旁边走不到的旧分支

日期：2026-11-09

English: this pass deletes only the Daxiong/Infinite-Canvas fallback bodies that the six next kernels already replace. It does not change `LICENSE`, rewrite Git history, claim commercial clearance, or move the app to another stack. CainFlow stays. The deprecated commerce workbench UI is not restored.

六个内核（视口、节点、历史、文档、调度、素材壳）在 PR #12 之后已经是唯一路径：`isActive()` 和 `selected()` 恒为真，查询参数、存储键和请求头都不能再选旧实现。本轮删的是因此走不到的 `else`，以及内核分支已经 `return` 之后的旧函数体。调用处改成直接走内核。没有为了掩盖来源而改名或重排仍在执行的 A 类代码。

没有整文件删除。删完之后，下面这些路径仍被页面、测试或 `electron-builder.yml` 的 `static/**`、根目录 `*.py` 打进运行和安装包。

## 1. 已从发行路径去掉的旧分支

这些分支在内核脚本和 `import dispatch_kernel` / `import asset_kernel` 存在时不会执行。删掉之后，缺内核脚本会直接报找不到对象，不再退回旧公式。

| 区域 | 文件 | 去掉的内容 |
| --- | --- | --- |
| 视口、节点、历史、文档、调度、素材壳 | `static/js/canvas.js`、`static/js/smart-canvas.js` | `Xiaomei*Kernel.isActive()` 为真时的 `else`，以及该分支 `return` 之后的旧公式、旧小地图、旧存盘体、旧连线和旧轮询判断 |
| 调度 | `main.py` 的 `provider_endpoint_url`、`image_task_url_for_provider`、`image_task_status`、`image_task_fail_reason` | `dispatch_kernel.selected()` 提前返回之后的旧地址拼接和旧状态解析 |
| 调度 | `static/js/image-task-client.js` 的 `defaultTaskDecision` | 内核 `pollDecision` 之后的旧状态字符串判断 |
| 素材与壳 | `main.py` 里提前返回的资产库、路径、扩展名、命名和批量删除函数；`image_space.py` 的 `matches_filters` | `asset_kernel.selected()` 之后的旧实现 |
| 素材与壳 | `static/js/asset-manager.js`、`image-space.js`、`image-preview.js`、`history-bulk-manager.js` | 壳内核之后的旧筛选、旧滚轮、旧多选和旧请求体。`shellBatch` 不再接收第二套蛇形字段 |
| 设置 | `static/js/api-settings.js` 的 `performProviderSave` | `if (!useShell)` 里的旧平台整理，以及 `shellBody` 为空时手写的请求体 |
| 主题 | `static/js/theme.js` | `shellOn()` 为假时的外观和缩放计算。`shellOn` 本身已无调用 |
| 只被删掉的分类回退使用 | `main.py` 的 `_safe_asset_tag` | 删掉分类字段旧实现之后，全仓库没有调用点 |

`static/commerce.html` 原先加载 `image-task-client.js`，但没有加载调度内核。已在该客户端之前加上 `xiaomei-dispatch-kernel.js`。电商工作台的页面结构没有恢复，也没有改 `static/js/commerce.js`。

`ComfyUI/web/comfyui.html` 和 `comfyui-settings.html` 原先只加载 `theme.js`。主题回退删掉之后，这两页会在 `theme.js` 之前加载 `xiaomei-shell-kernel.js`，外观和缩放走壳内核。

抽出函数做单测的命名空间现在放入 `asset_kernel`，让 `storage_file_path` 和 `_normalize_asset_classification_fields` 走内核，而不是靠「命名空间里没有模块就执行旧分支」。`tests/image_space_support.py` 不再按名字提取已删除的 `_safe_asset_tag`。`tests/smart-canvas-task-progress.test.cjs` 在跑 `pollSmartCanvasTask` 之前加载调度内核，取消任务仍由 `pollDecision` 标成 `cancelledTask`。

## 2. 明确留下的代码，以及原因

这些不是「内核分支恒真所以走不到」的 `else`。删它们会拆掉仍在执行的页面，或者把仍被调用的公式改写成另一种样子。本轮不做。

| 留下的路径 | 原因 |
| --- | --- |
| `static/js/canvas.js`、`static/js/smart-canvas.js` 里内核调用之外的节点渲染、菜单、生成和快捷键尾部 | 文件仍是画布程序本身。`XiaomeiHistoryKernel.chord()` 对 Delete、Escape、方向键和部分组合键返回 `null`，后面的按键处理仍会执行，不是被 `return` 盖住的旧分支 |
| `main.py` 的 `storage_kind_dir` 在 `asset_kernel.storage_bucket` 之后的目录映射；`normalize_provider` 在 `provider_core` 之后的模型、端点和锁定规则 | 内核只先整理入参，后面的语句是两条路径共用的后续逻辑，内核打开时本来就会执行 |
| `static/js/canvas-editor-core.js`、`static/js/canvas-list.js` | 没有 `isActive()` 回退。列表和编辑器仍调用这里的 `screenToWorld`。视口内核没有接到这些调用点。把公式换掉是另一次行为改写，不是删除走不到的分支 |
| `static/js/touch-mouse.js`、`ltx-director-timeline.js`、`comfyui-settings.js` 及其 CSS、`i18n.js`、`i18n/**`、`i18n-core.js` | 六个内核没有替换这些脚本和词典。页面仍加载它们 |
| `static/css/canvas.css`、`smart-canvas.css`、`api-settings.css`、`asset-manager.css`、`theme.css`、`canvas-editor-common.css`，以及对应 HTML 壳 | 样式和页面标记仍在用。本轮没有换皮 |
| `static/angle.html`、`enhance.html`、`klein.html`、`zimage.html`、`gpt-chat.html`、`online.html` 的页面正文 | 卫星页仍打开。只更新了已改脚本的 `?v=` |
| `static/system-prompts/infinite-canvas-prompt-templates.md`、`static/runninghub/api_providers.json` | 仍被产品读取的数据，不是内核回退分支 |
| `tools/chrome-local-asset-importer/**`、`tools/photoshop-asset-connector/**` | 安装输入仍可能带上这些工具。`packages/photoshop-bridge/` 不是它们的替代品 |
| `workflows/2511.json`、`Flux2-Klein.json`、`LTXDirectorv2-API.json` 及其 config、`Z-Image.json`、`Z-Image-Enhance.json`、`upscale.json` | 随仓库分发的工作流。不能把用户目录里的同名文件一起删掉，本轮也不迁移用户目录 |
| `mac-启动服务.sh`、`mac-启动服务.command`、`mac-安装依赖.sh`、`mac-修复权限.command`、`MAC-使用说明.md`、`运行说明.txt`、`安装依赖.bat`、`新手运行与使用教程.md`，以及 `CLI/` 里仍高相似的安装脚本 | 启动和说明仍被文档引用。不把它们改写成与上游无关 |
| `static/js/smart-camera-node.js` | CainFlow，额外作者授权。不改，不并进内核 |
| `static/commerce.html`、`static/js/commerce.js` 的工作台界面 | 产品上已废弃，但是否下线要单独决定。本轮只给共享的生图客户端接上调度内核 |
| 根目录 `LICENSE`、Git 历史 | 不在本轮范围。不改许可证正文，不宣称闭源或商用许可已经完成 |

`electron-builder.yml` 的 `files` 没有改。A 类文件仍会进安装包。这不表示产品已经独立，也不表示 B 类不再为空。第五阶段的商用清单仍然有效。
