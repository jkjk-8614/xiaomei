# 六个内核只走 next

日期：2026-11-09

第二阶段把六个内核做成可选开关，后来默认改成 next，并保留 `?=0`、`localStorage` 和请求头回滚。这一次去掉这些开关。运行时只走新内核。

没有改根目录 `LICENSE`，没有改写 Git 历史，没有从 `electron-builder.yml` 拿掉 A 类旧文件，也没有宣称产品已经完全独立。CainFlow 保持原样。废弃的电商工作台没有恢复。查询参数、存储键、请求头和 `setActive(false)` 都不能再选中旧实现。

后来又删掉了六个内核已经完全盖住的旧分支：`isActive()` / `selected()` 恒为真时走不到的 `else`，以及提前 `return` 后面的旧函数体。调用处不再写成 `if (kernel && kernel.isActive())`。内核脚本没有加载时，这些调用会直接找不到内核，不再退回旧公式。哪些文件因此少了一段、哪些 A 类文件仍整份留着，见 `docs/audits/residual-fallback-removal.md`。

## 现在的行为

打开页面时，六个内核都是 next。下面这些操作不再改变路径：

| 以前的开关 | 现在 |
| --- | --- |
| 查询参数 `?xmViewport=0`、`?xmNodes=0`、`?xmHistory=0`、`?xmDocument=0`、`?xmDispatch=0`、`?xmAssets=0`，以及值 `legacy`、`1`、`next` | 不读取，不写入。页面属性仍是 next |
| `localStorage` 键 `xiaomei.viewportKernel`、`xiaomei.nodeKernel`、`xiaomei.historyKernel`、`xiaomei.documentKernel`、`xiaomei.dispatchKernel`、`xiaomei.assetKernel`，包括已经写成 `legacy` 或 `0` 的旧值 | 不读取，也不再写入。已有的键留在浏览器里，但不生效 |
| 控制台 `XiaomeiViewportKernel.setActive(false)`，以及 `XiaomeiNodeKernel`、`XiaomeiHistoryKernel`、`XiaomeiDocumentKernel`、`XiaomeiDispatchKernel`、`XiaomeiShellKernel` 的同名调用 | 仍可调用，返回 `true`，不改路径，不写存储 |
| 请求头 `X-Xiaomei-Dispatch`、`X-Xiaomei-Assets` | 客户端不再添加。服务端不再读取。缺头、`next`、`legacy` 都走新模块 |

页面属性固定为：

| 内核 | 页面属性 |
| --- | --- |
| 视口 | `data-xm-viewport="next"` |
| 拖拽、连线、分组 | `data-xm-nodes="next"` |
| 撤销、复制、快捷键 | `data-xm-history="next"` |
| 存读与旧画布 | `data-xm-document="next"` |
| 协议与任务轮询 | `data-xm-dispatch="next"` |
| 素材、设置记录与壳层 | `data-xm-assets="next"` |

脚本地址上的 `xmViewportKernel=1` 这一类参数仍只用于缓存，不是开关。

服务端 `dispatch_kernel.selected()` 和 `asset_kernel.selected()` 固定返回真。以前按请求头设置的 `DispatchSwitchMiddleware`、`AssetSwitchMiddleware` 已从 `main.py` 去掉。`main.py` 和 `image_space.py` 里靠这两个判断分叉的旧分支已经删掉，见 `docs/audits/residual-fallback-removal.md`。

`isActive()` 和 `selected()` 仍恒为真，但业务脚本不再用它们选择旧函数。页面在加载内核脚本之后直接调用内核。内核脚本缺失时没有旧函数可退。那不是开关。

## 旧文件仍在

A 类旧文件仍在源码树里，也仍由当前 `electron-builder.yml` 的 `files` 打进安装包。它们不再是可切换的回滚实现。从安装包移除这些文件，仍然要另外满足第三阶段和第五阶段写过的条件：不带参数的手工验收通过、发布清单不再把该路径当成必需内容、用户目录里的画布和素材不被迁移或删除、并且留有可安装的旧构建。去掉开关、再删走不到的旧分支，都不满足那些整文件删除条件。

## 自动化

```text
python3 -m unittest tests.test_dispatch_kernel tests.test_asset_kernel
node --test tests/xiaomei-viewport-kernel.test.cjs tests/xiaomei-node-kernel.test.cjs tests/xiaomei-history-kernel.test.cjs tests/xiaomei-document-kernel.test.cjs tests/xiaomei-dispatch-kernel.test.cjs tests/xiaomei-shell-kernel.test.cjs
```

这些测试现在锁定：空存储、查询 `0` / `legacy` / `1` / `next`、存储里已有的 `legacy` 或 `0`、以及 `setActive(false)` 都保持 next，并且不写那六个键。调度和素材请求不再带选择用的请求头。服务端没有按请求头切换的中间件，`selected()` 固定为真。

## 手工验收

在本机用已有项目和平台配置做。不要清理用户目录。以前写过的那六个键可以留着，它们不再起作用。

1. 不带参数打开经典画布和智能画布。`document.documentElement.dataset` 里 `xmViewport`、`xmNodes`、`xmHistory`、`xmDocument`、`xmDispatch` 都是 `next`。平移、滚轮、拖节点、拉线、分组、撤销、复制粘贴、打开旧项目再保存，应仍能完成。
2. 不带参数打开素材页和 API 设置。`xmAssets` 为 `next`。分类、上传、移动和平台保存仍用现有字段；模型列表仍是账号里已有的名称。
3. 做一次文生图或图生图。任务能回到节点；失败时仍能看到原因。请求不再带 `X-Xiaomei-Dispatch`。真实平台密钥下的付费请求不在自动化里。
4. 分别加上 `?xmViewport=0`、`?xmNodes=0`、`?xmHistory=0`、`?xmDocument=0`、`?xmDispatch=0`、`?xmAssets=0` 并刷新。对应属性仍是 `next`。调度和素材请求也不带以前的选择头。
5. 在控制台调用对应内核的 `setActive(false)`。返回值是 `true`，属性仍是 `next`，刷新后也是 `next`。
6. 相机节点、商品分析、SKU、批量入口仍能打开。CainFlow 文件没有改。

第二阶段各篇和第三、第五阶段记录的是当时的开关。那些表不是现在的操作方法。当前行为以本文件为准。
