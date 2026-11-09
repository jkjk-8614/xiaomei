# 画布界面改写

日期：2026-11-09

这一轮改写 PR #13 明确留下的画布界面，不是再删一条走不到的 `else`。六个内核（视口、节点、历史、文档、调度、素材壳）仍是唯一算法路径。新代码只调用它们，不复制屏幕公式，也不把旧函数换个名字留在原文件里。

没有改 `LICENSE`，没有改写 Git 历史，没有宣称商用许可或闭源清理已经完成。CainFlow（`static/js/smart-camera-node.js`）没有改。已废弃的电商工作台没有恢复。运行时仍是 Electron、FastAPI 和原生 JavaScript。

## 1. 已经换掉的表面

| 表面 | 现在由谁执行 |
| --- | --- |
| 经典画布快捷键里 `XiaomeiHistoryKernel.chord()` 返回 `null` 之后的部分 | `static/js/xiaomei-canvas-keys.js` 的 `classicRemainder`。Delete / Backspace 删除选区，Escape 按编辑器、提示词库、灯箱的顺序关闭，灯箱左右键翻页，R 和 Shift 仍分别进入旋转和刀模式，Ctrl/Cmd+Shift+G 成组 |
| 智能画布按键前奏和字母 A | 同一个文件的 `smartPrelude`、`smartRemainder`。编辑器打开时不再进入 chord。素材库只在没有命令键时用 A 打开 |
| 复制、粘贴、撤销、重做、成组、缩放预览 | 仍只由 `XiaomeiHistoryKernel.chord()` 决定。原先跟在 chord 后面的第二套 Ctrl/Cmd 判断已删 |
| 经典创建菜单、连线菜单、图片菜单、输出菜单 | `static/js/xiaomei-canvas-surface.js`。`canvas.html` 里的创建菜单节点是空的，加载时再填 |
| 经典节点外框、状态点、端口、缩放手柄 | `mountClassicFrame`、`attachClassicPorts`。原点仍写 `XiaomeiViewportKernel.writeRawOrigin` |
| 经典图片生成和视频生成表单 | `mountImageGeneration`、`mountVideoGeneration`。平台和模型选项仍来自页面上的已保存列表 |
| 智能画布卡片 class、外框、端口 | `static/js/xiaomei-smart-surface.js`。正文 HTML 仍由 `smart-canvas.js` 传入 |
| 编辑器坐标 | `canvas-editor-core.js` 的 `screenToWorld` 和 `boardCenterWorld` 调用 `pointerToWorld`、`visibleWorldRect`。缩放小于等于 0 时按 1 处理，和原先 `\|\| 1` 一致 |
| 画布列表相机 | `canvas-list.js` 的平移、滚轮和世界层变换走 `dragCamera`、`zoomAboutClient`、`paintWorldLayer`。滚轮倍率仍是 1.1 |
| 编辑器公共样式 | `static/css/canvas-editor-common.css` 整文件重写。裁切和扩图手柄的位置没有改 |
| 画布、智能画布、列表的底色 | `canvas.css`、`smart-canvas.css`、`canvas-list.css` 的纸色 `#f4efe4` 和松绿 `#1f6a4a`。深色是 `#141714` / `#8dcea8` |

`canvas-list.html` 在编辑器公共脚本之前加载视口内核。`canvas.html` 和 `smart-canvas.html` 在画布脚本之前加载新的按键和表面脚本。改过的静态资源使用 `?v=2026.11.09.11`。

## 2. 仍留下的表面，以及原因

| 路径 | 原因 |
| --- | --- |
| `canvas.js` 里图片、提示词、循环、LLM、Comfy、RunningHub、LTX 的节点正文 | 这些函数继续按现有 class 绑事件。生成表单的外壳已经换掉，字段内部仍在原文件 |
| `smart-canvas.js` 的 `nodeBodyHtml`、工具条和各类型设置 | 卡片外壳已经换掉。正文里有批量、复刻、SKU、代理和图层，浏览器用例直接点这些控件 |
| `canvas.css`、`smart-canvas.css` 后半段功能规则 | 纸色和节点卡片已换。批量、代理、时间轴等规则决定点击区域，没有浏览器矩阵就整文件重写会改布局 |
| `theme.css`、`api-settings.css`、`asset-manager.css` | 它们服务设置页、素材页和全站主题，不是这一轮的画布程序表面。`api-settings.css` 仍接近上游整表，需要单独的设置页视觉系统 |
| `static/index.html` | 项目壳和内嵌样式是同一份四千行文档，改它会碰到每一个路由。画布页本身不靠这份壳计算坐标 |
| `static/angle.html`、`enhance.html`、`klein.html`、`zimage.html`、`gpt-chat.html`、`online.html` | 卫星页没有加载 `canvas.js` 或新的画布表面。它们的正文仍是延期项 |
| `static/js/smart-camera-node.js` | CainFlow。不改 |
| `static/commerce.html`、`static/js/commerce.js` | 电商工作台仍废弃，这一轮不恢复 |
| `LICENSE`、Git 历史 | 不改许可证正文，不把这次改写写成商用许可已经完成 |

`electron-builder.yml` 的 `files` 没有改。上述文件仍会进安装包。B 类仍为空。

## 3. 验证

本环境执行：

```text
node --check static/js/canvas.js
node --check static/js/smart-canvas.js
node --check static/js/canvas-editor-core.js
node --check static/js/canvas-list.js
node --check static/js/xiaomei-canvas-keys.js
node --check static/js/xiaomei-canvas-surface.js
node --check static/js/xiaomei-smart-surface.js
node --test tests/xiaomei-canvas-surface.test.cjs tests/xiaomei-viewport-kernel.test.cjs tests/xiaomei-history-kernel.test.cjs tests/xiaomei-node-kernel.test.cjs tests/xiaomei-document-kernel.test.cjs tests/xiaomei-dispatch-kernel.test.cjs tests/xiaomei-shell-kernel.test.cjs
```

`tests/xiaomei-canvas-surface.test.cjs` 锁定：列表和编辑器坐标与视口内核一致、文字命中框、经典 Delete/Escape/灯箱/Shift+G、智能画布编辑器前奏和素材键、卡片 class 与端口、页面确实加载新脚本。六个内核套件仍通过。

没有启动完整浏览器矩阵，也没有对真实平台发付费请求。装有现成项目的环境还应手查：经典画布平移和滚轮、右键创建节点、图片生成表单改比例、Delete 删除选区、智能画布拖节点和按 A 打开素材库、画布列表滚轮以光标为中心。
