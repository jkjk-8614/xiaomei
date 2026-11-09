# 第二阶段第四步：保存、读取和数据转换

日期：2026-11-09

这一步只替换画布文档的读取、保存外形和旧格式转换。模型请求、任务轮询和素材库整包替换都没有做。CainFlow、商品分析、SKU、批量生成、电商工作台、`LICENSE` 和版权声明都没有改。内核只在内存里转换，不会自己扫描或覆盖用户数据目录。

默认仍走旧实现。

## 来源与做法

保存文件仍是现有 JSON：`title`、`icon`、`nodes`、`connections`、`viewport`、`logs`，智能画布另加 `settings`。缺字段时补上，未知字段保留。

转换规则：

- `connections` 缺省时当成空数组。去掉没有端点或两端相同的边，并按来源、目标、种类和输入槽去重。
- `viewport` 缺省时是 `{x:0, y:0, scale:1}`。缩放不是正数时回到 1。
- 智能画布里旧的 `smart-container` 收成图片节点，并把 `inputImage` 放进 `images`。
- 绘画节点或图片节点如果运行设置是视频，收成 `smart-video`。
- 没有类型的节点收成 `smart-image`。没有生成记录、也没有输入或提示词草稿的图片节点收成 `smart-upload`。已经生成过的图片节点保持原类型。
- 经典画布里旧的 `msgen` 收成 `generator`。保存时去掉运行中的临时字段。
- 日志预览用的临时节点 id 不写入保存体。

新文件是 `static/js/xiaomei-document-kernel.js`。对照上游画布脚本，没有连续 8 行相同代码，最长相同行是 2 行和 3 行。

`node --test tests/xiaomei-document-kernel.test.cjs` 覆盖开关、旧智能画布迁移、经典保存去临时字段，以及保存后再读回。

服务端 `load_canvas` 仍只读磁盘上的原文件。转换发生在浏览器打开和保存时。用户不保存，磁盘上的旧文件不会被改写。

## 开关与回滚

| 操作 | 结果 |
| --- | --- |
| 什么都不做 | `data-xm-document="legacy"` |
| `?xmDocument=1` 或 `next` | 写入 `localStorage['xiaomei.documentKernel']='next'` |
| `?xmDocument=0` 或 `legacy` | 回到旧的读写外形 |
| `XiaomeiDocumentKernel.setActive(false)` 后刷新 | 同上 |

前三步的 `?xmViewport=1`、`?xmNodes=1`、`?xmHistory=1` 仍然各自独立。

## 最小适配层

网络请求、冲突合并、协作增量的其余字段和保存队列留在原文件。开关打开时：

- `static/js/smart-canvas.js`：打开画布时先整理文档，完整保存和增量视口用内核生成的结构。
- `static/js/canvas.js`：打开经典画布、远端同步和保存请求体走内核。
- `static/canvas.html`、`static/smart-canvas.html`：加载内核并更新缓存参数。

商品保真、复刻、画板、AI 渲染等节点在整理之后仍交给各自现有的整理函数，避免这一步改掉那些功能。

## 手工验收

1. 不带参数打开一份旧项目。`document.documentElement.dataset.xmDocument` 为 `legacy`。节点、连线和视口与现在一致。
2. 加上 `?xmDocument=1` 再打开同一项目。旧容器节点应显示为图片，视频模式的旧绘画节点应显示为视频节点，缺省视口不应把内容弄丢。
3. 移动一个节点，等自动保存完成，刷新。位置、连线和标题还在。
4. 再打开另一份只含 `nodes` 和 `viewport` 的更旧画布，应能打开而不是空白覆盖。
5. `?xmDocument=0` 刷新后回到旧读写。确认用户目录里的其他素材和历史没有被搬动。

本环境完成了单测和语法检查，没有在桌面壳里打开真实项目文件。请在本机用一份旧画布走上面的步骤。

## 还没做的事

模型 API 调度和素材管理整包替换留到后面的步骤。验收通过之前不要删除旧的保存和读取代码。
