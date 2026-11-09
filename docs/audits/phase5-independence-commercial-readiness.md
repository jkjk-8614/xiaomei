# 第五阶段：独立性与商用准备

日期：2026-11-09

这一阶段只写来源记录和检查清单。没有把根目录 `LICENSE` 改成 MIT，没有宣称整仓拥有完全独立版权，没有删除或改写历史版权信息、Git 历史和现有许可证文件，没有覆盖用户数据，没有删除旧版安装包，也没有发布新版本。当时六个新内核默认关闭。A 类旧文件没有从发行清单里物理删除。

六个内核的默认后来改为 next，再去掉旧路径开关，见 `docs/audits/kernel-defaults-next.md`。这些改动不删除 A 类文件，也不改变本节的许可证结论。A 类文件仍在安装包白名单里。`?=0`、存储键和请求头不再是回滚路径。

商用义务完成之前，不得修改 `LICENSE`，也不得对外宣称产品已经完全独立。

## 1. 代码来源分类

分类沿用第一阶段审计，第三阶段扫描没有把任何一类改判。

| 类 | 含义 | 本阶段结论 |
| --- | --- | --- |
| A | 与 `hero8152/Infinite-Canvas` `67f49e4` 有实质文本继承，受根目录 `LICENSE` 里对来源作者的约束 | 仍在安装包白名单里。六个内核默认改为 next 之后，这些旧文件仍是显式回滚路径，未替换的页面也仍直接执行它们。新内核不是替换完成 |
| B | 对大熊无实质文本继承，且有可核验的独立作者记录 | 空。没有模块可以写成已原创 |
| C | 其他权利人的保留实现。本轮只有 CainFlow 相机节点 | 保留，不改，不并进新内核 |
| D | 独立第三方依赖，按该依赖自己的许可证分发 | 保留声明。权利人不是大熊，也不是小美 |
| E | 对这份公开大熊树没有文本命中，作者未证实 | 可以继续留在产品里。不能称为原创，也不能因为不像大熊就删 |

新内核文件（`xiaomei-*-kernel.js`、`dispatch_kernel.py`、`asset_kernel.py`）在第三阶段对照上游全树时，连续 8 行窗口重合数为 0。它们在对应开关为 `next` 时执行，而 `next` 现在是默认。这不能把仍留在包里的 A 类文件变成 B 类。

## 2. 第三方许可证与来源

根目录 `LICENSE` 是项目当前许可证：允许自己使用和公司内部使用，禁止把软件修改或封装成商业产品，商用须取得授权；基于该代码的二次开发必须保持开源并注明来源作者。`README.md` 写明项目基于 Infinite-Canvas 二次开发。这两处本次都没有改。

### 2.1 A 类来源

上游仓库：`https://github.com/hero8152/Infinite-Canvas`，审计提交 `67f49e4b9a0ac090bad1f5bd62ae385f8fb5394e`。

仍会被当前安装包白名单打进去、并在回滚或未替换页面上执行的主要文件：

- `main.py`，以及仍含上游片段的画布脚本 `static/js/canvas.js`、`static/js/smart-canvas.js`
- 设置、素材、主题、预览、历史多选、画布列表和对应 CSS、HTML
- `static/js/touch-mouse.js`、`static/js/ltx-director-timeline.js`、`static/js/comfyui-settings.js` 与其 CSS
- `static/js/i18n.js`、`static/js/i18n/**`、`static/js/i18n-core.js`
- `tools/chrome-local-asset-importer/**`、`tools/photoshop-asset-connector/**`
- `workflows/` 里与上游相同的那批 JSON
- 启动脚本和 `新手运行与使用教程.md`、`安装依赖.bat`、`运行说明.txt`、`MAC-使用说明.md`
- `static/system-prompts/infinite-canvas-prompt-templates.md`、`static/runninghub/api_providers.json`

完整路径和片段召回见 `docs/audits/phase3-regression-and-residue-scan.md` 第 6 节。这些文件继续受根目录 `LICENSE` 约束。

从发行包移除任何一个 A 类文件之前，都要同时满足：

1. 对应新内核在只打开该开关时通过手工矩阵。
2. 另一次决定把该开关默认改成 `next`，并在不带参数时再验收。
3. `electron-builder.yml` 的 `files` 不再把该路径打进安装包，同时不迁移、不删除用户目录里的画布、素材、历史和 `data/`。
4. 保留一个还能安装的旧构建，以便回滚。

本阶段不执行这四步。

### 2.2 C 类：CainFlow

| 项 | 记录 |
| --- | --- |
| 文件 | `static/js/smart-camera-node.js` |
| 上游 | `https://github.com/RingoCaviar/CainFlow` |
| 许可证 | GPL-3.0-or-later。文件头有 SPDX，根目录 `NOTICE` 有说明 |
| 范围 | 只编译相机提示词，不在该文件里生图 |
| 安装包 | `static/**` 会把它打进去 |
| 未完成 | 根目录 `LICENSE` 不是 GPL。分发含该文件的安装包时，还要随包提供 GPL-3.0 全文，并保证接收方能取得对应源码。本次没有补那份全文，也没有改相机文件 |

### 2.3 D 类：ComfyUI

| 项 | 记录 |
| --- | --- |
| 本体 | `ComfyUI/core/LICENSE` 为 GPL-3.0 |
| 随仓自定义节点 | Easy-Use、KJNodes、QwenVL、RMBG 的 `LICENSE` 为 GPL-3.0。Easy-Use 内还有一份 Pixart 的 AGPL-3.0。LayerStyle 为 MIT（Copyright (c) 2024 chflame163）。SeedVR2 为 MIT（Copyright (c) 2025 NumZ, AInVFX and Contributors）。rgthree-comfy 为 MIT（Copyright (c) 2023 Regis Gaughan, III）。mixlab 节点目录带 `.disabled`，其 `LICENSE` 为 MIT |
| 当前安装包白名单 | `electron-builder.yml` 只列入 `ComfyUI/integration/**`、`ComfyUI/web/**`、`ComfyUI/tools/comfy-app-bridge/**`。`ComfyUI/core` 和 `custom_nodes` 不在这份白名单里 |
| 未完成 | `ComfyUI/web` 属于 GPL 项目的前端，白名单却没有把 `ComfyUI/core/LICENSE` 列入。发布前要打开实际安装包，确认 Web 资源是否仍需附带 GPL-3.0 全文和源码提供方式。GPU、CUDA、cuDNN 继续只走按需安装脚本，不写回基础依赖 |

`static/js/comfyui-settings.js` 是大熊那份设置脚本，属 A，不是 ComfyUI 本体。

### 2.4 D 类：DeepSeek Harness

| 项 | 记录 |
| --- | --- |
| 源码树 | `vendor/deepseek-harness/LICENSE`：MIT，Copyright (c) 2026 DeepSeek |
| 安装包 | 白名单打入的是 `bundled/deepseek-harness/**`，不是整份 `vendor/` 源码树。发布流程会检查桌面宿主和 web 包是否存在 |
| 小美接线 | `deepseek_harness.py` 和对话页里的 MCP 入口对大熊无文本命中，标 E。配置仍只有用户目录里的 `data/mcp_servers.json` |
| 义务 | 保留 DeepSeek 的版权声明和 MIT 许可声明。不要把 Harness 写成小美原创。其 `vendor/` 下还有各自的 `LICENSE`，构建进 `bundled/` 时要随包保留 |

### 2.5 D 类：前端依赖和字体

登记位置是 `static/vendor/MANIFEST.md`、根目录 `NOTICE`，以及 `static/vendor` 里已有的许可证文本。

| 组件 | 许可证与版权 | 仓库里的许可证文本 |
| --- | --- | --- |
| Fluent UI Web Components、tokens、FAST Element | MIT，Copyright (c) Microsoft Corporation | `static/vendor/fluent/*LICENSE.txt` |
| tslib | MIT 风格许可，Copyright (c) Microsoft Corporation | `static/vendor/fluent/tslib-LICENSE.txt` |
| perfect-freehand 1.2.3 | MIT，Copyright (c) 2021 Stephen Ruiz Ltd | 根目录 `NOTICE` |
| qrcode-generator 2.0.4 | MIT，Copyright (c) 2009 Kazuhiko Arase | 根目录 `NOTICE` |
| ag-psd | MIT，Copyright (c) 2016 Agamnentzar | `static/vendor/js/ag-psd-LICENSE.txt` |
| pako | MIT，Copyright (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn | `static/vendor/js/pako-LICENSE.txt` |
| three r160 | MIT。上游说明见 `MANIFEST` | 镜像旁没有单独的许可证全文 |
| lucide | 上游为 ISC | 镜像旁没有单独的许可证全文 |
| Tailwind 浏览器构建 | 上游为 MIT | 镜像旁没有单独的许可证全文 |
| Inter、JetBrains Mono、Space Grotesk | 这三套字体的常见发行许可证是 SIL Open Font License | `static/vendor/fonts/` 只有 ttf，没有随包许可证全文 |

PhotoCraft 页面在 `static/photocraft/`，随 `static/**` 进入安装包。它是 MIT 或 Apache-2.0 双许可，Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors。`LICENSE-MIT`、`LICENSE-APACHE` 和 `NOTICE` 都在该目录，发布流程会检查前两份文件是否打进 macOS 包。PhotoCraft 自己的 `NOTICE` 还指向词表、人脸检测权重和表情字体，那些材料不改用小美名义。

Electron 31.7.7 与 electron-builder 26.15.3 是桌面打包工具。Electron 为 MIT。它们由构建工具打入运行时，不在 `files` 的源码白名单里。发布前应在安装包中看到 Electron 的许可证副本。

### 2.6 Python 依赖

`requirements.txt` 的直接依赖包括 FastAPI、Uvicorn、requests、Pydantic、python-multipart、httpx、tomli、websockets、mcp、Pillow、pypdf、vtracer、numpy、opencv-contrib-python、CPU 版 ONNX Runtime。它们各自有上游许可证，常见组合是 MIT、BSD、Apache-2.0 和 HPND。本清单不代替发布前用包元数据再导出一次的结果。

约束不变：基础包只用 CPU 版 ONNX Runtime。`onnxruntime-gpu`、CUDA、cuDNN 不进基础包。`get-pip.py` 是上游 pip 引导脚本，标 D，不是大熊业务代码。

Real-ESRGAN NCNN Vulkan 不在源码包里，首次使用才下载。许可证是 BSD-3-Clause，Copyright (c) 2021 Xintao Wang；便携程序还基于 Tencent ncnn。说明在根目录 `NOTICE`。

### 2.7 E 类

设计大脑、商品分析、SKU、批量生成、桌面更新、画布代理和 MCP 接线对这份公开大熊树没有文本命中。电商工作台 `static/js/commerce.js` 同样没有命中；产品上它已废弃，但是否下线要单独决定，不能借商用清单删掉。这些模块都不是 B 类，对外不能叫原创。

## 3. 最终分发包检查清单

安装包由 `electron-builder.yml` 的 `files` 决定，再经 `.github/workflows/desktop-release.yml` 上传 Windows x64 与 macOS arm64 安装包和 `update.json`。本次没有构建、没有上传、没有删除已有 Release。

发布前打开实际解包目录，逐项填写。源码树里有、但白名单没写的路径，不应假设它一定不在包里，要以那次构建的文件列表为准。

| 检查 | 当前记录 | 通过标准 |
| --- | --- | --- |
| 是否仍含大熊受限代码 | 是。`main.py`、`static/**`、`tools/**`、`workflows/**` 都在白名单里，A 类旧文件会进包 | 要么取得授权，要么 A 类文件已按第 2.1 节的四条从前置条件中移除，并且解包后搜不到这些路径 |
| 旁路旧实现 | `canvas.js`、`smart-canvas.js`、`main.py`、设置页、素材页、主题、预览、历史多选、i18n、采集插件、Photoshop 旧连接器、同源工作流和启动文档仍在包里。六个内核的查询参数、存储键和请求头不再选中它们 | 清单里写明它们仍在包里。它们不是已删除的文件，也不是还能用 `?=0` 打开的回滚路径 |
| 六个内核路径 | 只走 next。`?=0`、`legacy`、那六个 `localStorage` 键、`setActive(false)`、`X-Xiaomei-Dispatch` 和 `X-Xiaomei-Assets` 都不选择旧实现 | 见 `docs/audits/kernel-defaults-next.md`。缓存参数 `xmViewportKernel=1` 不是开关 |
| 新内核 | 随根目录 `*.py` 和 `static/**` 进包，并且现在默认执行 | 可以存在。不能据此宣称包内已经没有大熊代码 |
| CainFlow | `static/js/smart-camera-node.js` 会进包 | GPL 全文和源码提供方式能在发布物里找到 |
| ComfyUI | 白名单含 web、integration、comfy-app-bridge；不含 core 与 custom_nodes | 核对 web 资源是否仍要附 GPL 文本 |
| DeepSeek | `bundled/deepseek-harness/**` | MIT 版权声明还在 |
| PhotoCraft | `static/photocraft/**` | `LICENSE-MIT` 与 `LICENSE-APACHE` 还在 |
| 字体与部分前端镜像 | ttf 与 js 镜像会进包 | 缺的许可证全文已经补上，或该资源改用不缺声明的来源 |
| 用户数据 | 白名单排除 `data/`、`assets/`、`API/.env`、历史、日志和输出目录 | 解包后没有真实密钥、用户图片、历史和私人配置 |
| 运行时 | 基础包只有 CPU 版 ONNX Runtime | 没有把 GPU、CUDA、cuDNN 打进基础包 |
| 旧安装包 | 不在本阶段删除 | 发布清单仍按现有发布规则，只有新版验证通过后才处理旧 Release |

## 4. 商用前必须满足的义务

下面任何一项未完成，都不得修改 `LICENSE`，不得宣称整仓或产品已经完全独立。

| 状态 | 义务 |
| --- | --- |
| 未完成 | 取得根目录 `LICENSE` 所要求的商业授权，或在律师确认下先移除全部 A 类代码并且不再受该许可证对衍生商业产品的限制。仓库里没有授权记录 |
| 未完成 | A 类旧文件仍在安装包白名单内。六个新内核只走 next，这不表示 A 类文件已移除，也不能再靠 `?=0` 切回旧实现 |
| 未完成 | B 类仍为空。不能把 E 类或新内核写成「整仓已原创」 |
| 未完成 | 含 CainFlow 文件的安装包尚未核对 GPL-3.0 全文和源码提供方式 |
| 未完成 | `ComfyUI/web` 进包，但 `ComfyUI/core/LICENSE` 不在白名单。发布前要核对 |
| 未完成 | three、lucide、Tailwind 镜像和三套字体没有随包许可证全文 |
| 未完成 | Python 依赖许可证没有用本次构建环境的包元数据再导出 |
| 已有、必须保持 | 根目录 `NOTICE` 中的 CainFlow、qrcode-generator、perfect-freehand、Real-ESRGAN 说明 |
| 已有、必须保持 | DeepSeek MIT 版权声明、Fluent / ag-psd / pako 的许可证文本、PhotoCraft 的两份许可证 |
| 禁止现在做 | 把 `LICENSE` 改成 MIT，或在 README、安装包、网站上写「完全独立版权」 |
| 禁止现在做 | 删除旧文件、改 Git 历史、删除旧安装包、自动发布新版本、把默认改为 next 说成已经完全独立 |

公司内部使用和对外销售、重新封装、上架应用商店不是同一件事。当前许可证文本把后者列为需要授权的商业产品。本文件不构成该授权。

## 5. 停止

第五阶段到此停止。等待用户下一步指示。在那之前不要改许可证、不要删旧文件、不要发布。
