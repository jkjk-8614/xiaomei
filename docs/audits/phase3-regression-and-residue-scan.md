# 第三阶段：回归检查与残留扫描

日期：2026-11-09

这一阶段只核对第二阶段已经交付的六个可选内核，并对照公开上游 `hero8152/Infinite-Canvas` 的 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e` 重新扫描。当时没有把任何新内核改成默认，没有删除旧文件，没有改 `LICENSE`、版权声明或 Git 历史，没有改 CainFlow，没有读写用户素材目录。商用独立性准备没有开始。

下面各表记录的是本阶段当时的状态：默认 `legacy`，并且可以用查询参数回滚。那不是现在的行为。查询参数、存储键和请求头后来被去掉，运行时只走新内核；A 类旧文件仍在安装包里，但不再是可切换的回滚路径。见 `docs/audits/kernel-defaults-next.md`。六个内核已经盖住的 `else` 和提前返回后面的旧函数体，后来从这些文件里删掉了；没有整文件删除。删了什么、为什么其余 A 类文件还在，见 `docs/audits/residual-fallback-removal.md`。

上游本次检出 118 个文本文件，规范化后的连续 8 行窗口共 160759 个。规范化规则是去掉首尾空白、把行内连续空白收成一个空格、丢掉空行。

## 1. 六个内核与默认路径

本节记录第三阶段当时的开关。现在不能再按这张表打开或关闭内核。

六个开关当时互不影响。不带地址参数、也没有把对应的 `localStorage` 写成 `next` 时，页面和请求都走旧实现。脚本地址上的 `xmViewportKernel=1` 这一类参数只用于缓存，不是开关；开关只读页面自己的查询串。

| 步骤 | 新文件 | 打开 | 关闭 | 存储键 | 默认 |
| --- | --- | --- | --- | --- | --- |
| 视口 | `static/js/xiaomei-viewport-kernel.js` | `?xmViewport=1` | `?xmViewport=0` | `xiaomei.viewportKernel` | `legacy` |
| 拖拽、连线、分组 | `static/js/xiaomei-node-kernel.js` | `?xmNodes=1` | `?xmNodes=0` | `xiaomei.nodeKernel` | `legacy` |
| 撤销、复制、快捷键 | `static/js/xiaomei-history-kernel.js` | `?xmHistory=1` | `?xmHistory=0` | `xiaomei.historyKernel` | `legacy` |
| 存读与旧画布 | `static/js/xiaomei-document-kernel.js` | `?xmDocument=1` | `?xmDocument=0` | `xiaomei.documentKernel` | `legacy` |
| 协议与任务轮询 | `dispatch_kernel.py`、`static/js/xiaomei-dispatch-kernel.js` | `?xmDispatch=1`，请求头 `X-Xiaomei-Dispatch: next` | `?xmDispatch=0` | `xiaomei.dispatchKernel` | `legacy` |
| 素材、设置记录与壳层决定 | `asset_kernel.py`、`static/js/xiaomei-shell-kernel.js` | `?xmAssets=1`，请求头 `X-Xiaomei-Assets: next` | `?xmAssets=0` | `xiaomei.assetKernel` | `legacy` |

`1` 与 `next` 等价，`0` 与 `legacy` 等价。服务端只在对应请求头等于 `next` 时进入新模块。旧函数仍留在 `main.py`、`canvas.js`、`smart-canvas.js` 和各设置、素材脚本里，开关关闭时由它们执行。

## 2. 已跑过的自动化测试

本环境执行了下面的命令，内核测试全部通过。

```text
python3 -m unittest tests.test_dispatch_kernel tests.test_asset_kernel
node --test tests/xiaomei-viewport-kernel.test.cjs tests/xiaomei-node-kernel.test.cjs tests/xiaomei-history-kernel.test.cjs tests/xiaomei-document-kernel.test.cjs tests/xiaomei-dispatch-kernel.test.cjs tests/xiaomei-shell-kernel.test.cjs
```

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `tests/xiaomei-viewport-kernel.test.cjs` | 8 通过 | 默认关闭；查询串写入和清除；滚轮锚点；拖拽与中心缩放；智能画布滚轮增益和滑杆吸附；适配与聚焦；小地图；仿射逆矩阵 |
| `tests/xiaomei-node-kernel.test.cjs` | 6 通过 | 默认关闭；分组和多选一起移动；组成员展开；连线端点与弯曲；禁止成环、允许生成器输出；按连线分列并去重 |
| `tests/xiaomei-history-kernel.test.cjs` | 4 通过 | 默认关闭；撤销上限与智能画布重做；粘贴后重排并改内部连线；经典撤销和智能画布重做的快捷键 |
| `tests/xiaomei-document-kernel.test.cjs` | 3 通过 | 默认关闭；旧智能画布补视口、连线和当前节点类型；经典保存去掉运行时字段并保留视口 |
| `tests/xiaomei-dispatch-kernel.test.cjs` 与 `tests/test_dispatch_kernel.py` | 2 + 2 通过 | 默认关闭；成功、空结果、失败和即梦排队；平台 ID、地址拼接、任务查询地址；排队记录从 `queued` 到 `succeeded` |
| `tests/xiaomei-shell-kernel.test.cjs` 与 `tests/test_asset_kernel.py` | 3 + 3 通过 | 默认关闭；多选、预览缩放、主题色迁移、历史删除体；平台记录不另造模型名；路径不越出根目录；资产库移动和默认工作流分组保护；分类标签与居中裁切框 |

旁边这些不启动完整界面、也不读用户目录的测试也通过了：`tests.test_canvas_persistence`、`tests.test_canvas_index_guard`、`tests.test_image_space`、`tests.test_local_asset_folder_order`、`tests.test_asset_library_category_cleanup`、`tests.test_upload_asset_scopes`、`tests.test_storage_file_management`、`tests.test_history_project_scope`。合计 24 个用例通过。

`tests.test_legacy_migration` 10 个用例里 9 个通过。`test_preservation_sibling_and_pointer_are_scanned` 在这台 Linux 上读取 UTF-16 安装指针时出现 `ValueError: embedded null byte`。该逻辑在 `runtime_paths.py`，不在六个新内核里，本次没有改它，也没有用真实用户目录重放。

浏览器用例（`tests/*.browser.cjs`）和需要桌面壳的用例这次没有跑。它们留在下面的手工矩阵里。

为了让抽出的旧函数在测试命名空间里仍走旧分支，`main.py` 里的开关判断改成先取 `globals()` 中的模块；模块不在该命名空间时视为关闭。`tests/test_storage_file_management.py` 补上了旧函数原本就使用的 `asyncio`。`dispatch_kernel.py` 的图片地址收集改了写法，避免和上游 `main.py` 出现 4 行连续相同；协议单测仍然通过。这些改动不改变默认路径。

## 3. 回归检查清单

每一项都要先看默认关闭，再单独打开对应开关。不要一次把六个开关全打开后当作单项验收。

| 内核 | 默认关闭时要看到的 | 打开后要看到的 | 自动化 |
| --- | --- | --- | --- |
| 视口 | `data-xm-viewport="legacy"`。平移、滚轮、节点位置与改动前一致 | 锚点缩放、适配全图、小地图与旧相机同一结果 | 视口套件 |
| 节点 | `data-xm-nodes="legacy"`。拖节点、拉线、分组与现在一致 | 组成员跟随、多选一起动、不能连成环 | 节点套件 |
| 历史 | `data-xm-history="legacy"`。撤销、复制、粘贴与现在一致 | 有上限的撤销和重做；粘贴得到新关系而不是旧 id | 历史套件 |
| 文档 | `data-xm-document="legacy"`。旧项目节点和视口不丢 | 缺省视口和连线被补上；保存不写出运行时字段 | 文档套件 |
| 调度 | 本地 `/api/` 请求不带 `X-Xiaomei-Dispatch` | 文生图或图生图能排队并回到节点；失败能看到原因 | 调度套件。真实平台密钥下的付费请求不在自动化里 |
| 素材与设置 | `data-xm-assets="legacy"`。分类、上传、移动和平台保存与现在一致 | 同一套分类和请求字段；模型列表仍是已经保存的名称 | 素材套件。真实素材目录不在自动化里 |

CainFlow 相机节点、商品分析、SKU、批量生成只做冒烟：入口还在，开关不要改到这些文件里。

## 4. 手工验收矩阵

在本机用已经存在的项目和平台配置做。每一格先记录 `document.documentElement.dataset` 里对应属性是 `legacy` 还是 `next`。

| 场景 | 不带参数 | 只打开对应开关 | 再关回 |
| --- | --- | --- | --- |
| 经典画布平移、滚轮、小地图 | 视口旧实现 | `?xmViewport=1` 后同一操作 | `?xmViewport=0` |
| 智能画布拖节点、拉线、分组 | 节点旧实现 | `?xmNodes=1` | `?xmNodes=0` |
| 撤销、重做、复制、粘贴、常用快捷键 | 历史旧实现 | `?xmHistory=1` | `?xmHistory=0` |
| 打开旧画布、保存、再打开 | 文档旧实现 | `?xmDocument=1`。旧节点类型还在 | `?xmDocument=0` |
| 文生图或图生图；有视频或对话节点时各一次 | 请求无新头部 | `?xmDispatch=1`。完成或失败都回到节点 | `?xmDispatch=0` 后请求不再带新头部 |
| 素材页分类、上传、移动、删除；设置页保存平台 | 素材旧实现 | `?xmAssets=1`。模型列表没有新的写死名单 | `?xmAssets=0` |
| 画布侧栏素材、在线生图大图滚轮、历史多选、深色主题 | 旧壳层决定 | `?xmAssets=1` 后这些决定走新模块，外观不变 | `?xmAssets=0` |
| 相机节点、商品分析或 SKU、批量生成入口 | 能打开 | 不要求换实现 | 仍能打开 |

验收时不要清理用户目录。测试如果新建了画布，只删除那个测试 id。

## 5. 新内核残留扫描

八个新文件对上游全树的连续 8 行窗口重合数都是 0。最长相同规范化行都是 3 行，落在短句上，不是一段可替换的实现。

| 新文件 | 规范化行 | 共有 8 行窗口 | 最长相同行 | 对照到的上游文件 |
| --- | ---: | ---: | ---: | --- |
| `static/js/xiaomei-viewport-kernel.js` | 561 | 0 | 3 | `static/js/canvas.js` |
| `static/js/xiaomei-node-kernel.js` | 301 | 0 | 3 | `static/js/touch-mouse.js` |
| `static/js/xiaomei-history-kernel.js` | 179 | 0 | 3 | `static/js/canvas.js` |
| `static/js/xiaomei-document-kernel.js` | 206 | 0 | 3 | `static/js/canvas.js` |
| `static/js/xiaomei-dispatch-kernel.js` | 128 | 0 | 3 | `static/js/smart-canvas.js` |
| `dispatch_kernel.py` | 193 | 0 | 3 | `main.py` |
| `static/js/xiaomei-shell-kernel.js` | 496 | 0 | 3 | `static/js/canvas.js` |
| `asset_kernel.py` | 510 | 0 | 3 | `main.py` |

结论：已识别的大熊受限实现没有整段留在这些新文件里。这不表示旧文件已经被换掉。旧文件仍是默认执行的旁路。

## 6. 仍属 A 类旁路的旧文件

下面的片段召回是这次用同一套 8 行窗口对同路径上游文件重算的。扫描对最长连续行设了 80 行上限，表里的 80 表示不少于 80 行，和第一阶段里更长的连续段一致。第一阶段标成字节级相同、而这次召回略低于 1 的，是因为第二阶段往旧文件插了开关分支，旧正文还在。

这些文件现在仍然默认启用。移除发行清单之前必须同时满足：

1. 对应新内核在「只打开该开关」的手工矩阵里通过。
2. 另一次决定把该开关的默认从 `legacy` 改成 `next`，并在不带参数时再跑一遍同一矩阵。
3. 发布输入和安装包清单不再把该文件当成必需内容；用户机器上的画布、素材、历史和 `data/` 不跟着删除或迁移。
4. 保留一个可回滚的旧构建。删除本身不属于本阶段。

在这四条完成前，旧文件继续随产品分发，并且是开关关闭时的实现。

### 6.1 默认仍在执行的业务旁路

| 路径 | 本次片段召回 | 最长连续行（扫描上限 80） | 默认 |
| --- | ---: | ---: | --- |
| `static/js/canvas.js` | 0.808 | 80 | 视口、节点、历史、文档、调度的旧实现 |
| `static/js/smart-canvas.js` | 0.477 | 80 | 同上，智能画布旧实现 |
| `main.py` | 0.560 | 80 | 调度和素材的旧实现；新模块只在请求头为 `next` 时进入 |
| `static/js/api-settings.js` | 0.613 | 80 | 设置页旧保存 |
| `static/css/api-settings.css` | 0.953 | 80 | 设置页旧样式，本阶段没有换皮 |
| `static/api-settings.html` | 0.317 | 61 | 设置页旧壳 |
| `static/js/asset-manager.js` | 0.649 | 80 | 素材页旧逻辑 |
| `static/css/asset-manager.css` | 0.416 | 58 | 素材页旧样式 |
| `static/js/theme.js` | 0.689 | 80 | 主题旧决定；`?xmAssets=1` 才改走新模块 |
| `static/css/theme.css` | 0.413 | 34 | 主题旧样式 |
| `static/js/image-preview.js` | 0.947 | 80 | 预览旧滚轮；开关打开才用新计算 |
| `static/js/history-bulk-manager.js` | 0.841 | 80 | 历史多选旧逻辑 |
| `static/js/canvas-list.js` | 0.687 | 80 | 画布列表旧实现 |
| `static/css/canvas-list.css` | 0.637 | 59 | 列表旧样式 |
| `static/canvas-list.html` | 0.345 | 30 | 列表旧壳 |
| `static/index.html` | 0.608 | 80 | 应用壳旧标记 |
| `static/canvas.html` | 0.782 | 80 | 经典画布宿主 |
| `static/smart-canvas.html` | 0.446 | 60 | 智能画布宿主 |
| `static/css/canvas.css` | 0.768 | 80 | 经典画布旧样式 |
| `static/css/smart-canvas.css` | 0.093 | 28 | 规则已打散，上游行仍在，仍按 A 旁路保留 |
| `static/js/i18n.js` 及 `static/js/i18n/**` | 0.108–0.882 | 最高不少于 80 | 词典旧句子还在 |
| `static/angle.html`、`enhance.html`、`klein.html`、`zimage.html`、`gpt-chat.html`、`online.html` | 0.534–0.857 | 80 | 卫星页旧壳 |

`static/js/canvas-editor-core.js` 与 `static/css/canvas-editor-common.css` 仍是从经典画布抽出的 A 类旁路，默认加载。

### 6.2 仍整段留在树里的工具和数据

这些文件的片段召回为 1，或只差开关以外的少量行。它们没有被第二阶段的内核替换，默认仍会随仓库和发行输入存在。移除前置条件与上一节相同；工作流 JSON 还要先确认没有用户目录里的同名文件被一起删掉。

- 画布附属：`static/js/touch-mouse.js`、`static/js/ltx-director-timeline.js`、`static/js/comfyui-settings.js`、`static/css/comfyui-settings.css`、`static/js/i18n-core.js`、`static/js/i18n/comfyui-settings.js`、`static/js/i18n/validate-i18n.js`
- 提示词底稿：`static/system-prompts/infinite-canvas-prompt-templates.md`
- 静态清单：`static/runninghub/api_providers.json`（片段召回 0.985）
- 浏览器采集：`tools/chrome-local-asset-importer/**`
- Photoshop 旧连接器：`tools/photoshop-asset-connector/**`。`packages/photoshop-bridge/` 不是这份连接器，不能拿来顶替删除
- 随仓库分发的工作流：`workflows/2511.json`、`Flux2-Klein.json`、`LTXDirectorv2-API.json` 及其 config、`Z-Image.json`、`Z-Image-Enhance.json`、`upscale.json`
- 启动和说明：`mac-启动服务.sh`、`mac-启动服务.command`、`mac-安装依赖.sh`、`mac-修复权限.command`、`MAC-使用说明.md`、`运行说明.txt`、`安装依赖.bat`、`新手运行与使用教程.md`，以及 `CLI/` 下与上游同路径、片段召回仍高的即梦、Gemini、Codex 安装脚本

## 7. 这次不移除、也不改声明的文件

| 类别 | 路径 | 处理 |
| --- | --- | --- |
| 许可证 | `LICENSE` | 与上游一致。保留，禁止修改。本阶段不进入改许可证声明的工作 |
| C | `static/js/smart-camera-node.js` | CainFlow。不改，不并进新内核 |
| D | `get-pip.py`、`static/vendor/js/three-0.160.0.module.js`、`lucide.js`、`tailwindcss-cdn.js`、`fonts.css` | 权利人不是大熊。保留原声明 |
| D | `ComfyUI/core`、`vendor/deepseek-harness` | 按各自许可证保留，不因这次扫描删除 |
| E | 商品分析、SKU、批量生成、设计大脑、桌面更新 | 第一阶段没有把它们标成大熊受限实现。继续保留，不在本阶段改成「已原创」 |

## 8. 风险与回滚

| 风险 | 表现 | 处理 |
| --- | --- | --- |
| 开关被记住 | 某次打开 `?xmViewport=1` 后，同一站点下次仍走新内核 | 用对应的 `?=0` 写回 `legacy`，或调用该内核的 `setActive(false)` 后刷新 |
| 六个开关互相掩盖 | 同时打开后无法判断是哪一个内核的问题 | 回归时一次只开一个。自动化测试也是分套件跑的 |
| 两个请求头叠在一起 | 调度和素材都打开时，`fetch` 会带两个头 | 这是预期。只开一个时只带一个头 |
| 旧文件被提前删掉 | 默认路径没有实现，回滚只剩空文件 | 本阶段不删。回滚只改开关，不恢复用户数据 |
| 把片段召回下降当成已经换完 | `theme.js`、`image-preview.js` 因为插了分支，召回低于第一阶段的字节级相同 | 旧正文还在，默认仍执行。移除条件见第 6 节 |
| 迁移测试的空字节错误被当成内核回退 | Linux 上一个旧安装指针用例失败 | 不在六个内核里。不要为此改用户数据目录 |
| 真实平台和真实素材没在这里跑 | 自动化使用临时目录和假响应 | 手工矩阵用本机已有配置补上。不要把密钥写进仓库 |

当时的回滚不需要还原 Git 历史，也不需要覆盖用户目录：把对应查询串设为 `0` 并刷新即可回到旧函数。这个开关已经去掉，现在这样做不会回到旧实现。若一次试验写了测试画布，只删除那个测试 id。

## 9. 停止

第三阶段到此停止。当时六个内核默认关闭，旧的 A 类文件仍是旁路。之后先把默认改成 next，再去掉旧路径开关。A 类旧文件仍在安装包里，但查询参数、存储键和请求头不能再选中它们，见 `docs/audits/kernel-defaults-next.md`。不要删除旧文件，不要改 `LICENSE` 或版权声明，也不要据此宣称完全独立。
