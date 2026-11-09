# 六个内核改为默认走 next

日期：2026-11-09

第二阶段把六个内核做成可选开关，当时不带参数就走旧实现。这一次只改默认：没有查询参数、也没有把对应 `localStorage` 写成 `legacy` 或 `0` 时，六个内核都走 next。旧实现没有删除，仍是显式回滚路径，也仍留在安装包白名单里。

没有改根目录 `LICENSE`，没有改写 Git 历史，没有从 `electron-builder.yml` 拿掉 A 类旧文件，也没有宣称产品已经完全独立。CainFlow 保持原样。废弃的电商工作台没有恢复。

## 默认

清空对应键，或不带查询参数打开一个新配置时：

| 内核 | 页面属性 | 存储键 | 默认 |
| --- | --- | --- | --- |
| 视口 | `data-xm-viewport="next"` | `xiaomei.viewportKernel` | `next` |
| 拖拽、连线、分组 | `data-xm-nodes="next"` | `xiaomei.nodeKernel` | `next` |
| 撤销、复制、快捷键 | `data-xm-history="next"` | `xiaomei.historyKernel` | `next` |
| 存读与旧画布 | `data-xm-document="next"` | `xiaomei.documentKernel` | `next` |
| 协议与任务轮询 | `data-xm-dispatch="next"` | `xiaomei.dispatchKernel` | `next`，本地 `/api/` 请求带 `X-Xiaomei-Dispatch: next` |
| 素材、设置记录与壳层 | `data-xm-assets="next"` | `xiaomei.assetKernel` | `next`，素材、本地素材和平台相关请求带 `X-Xiaomei-Assets: next` |

默认打开时不会把 `next` 写进 `localStorage`。键是空的，下一次打开仍然是 next。脚本地址上的 `xmViewportKernel=1` 只用于缓存，不是开关。

服务端仍只在请求头等于 `next` 时进入 `dispatch_kernel` 或 `asset_kernel`。默认客户端会带上这个值，所以不带查询参数的页面会让服务端走 next。请求头缺失，或值为 `legacy`，服务端继续用 `main.py` 里的旧函数。这样，回滚后的页面不再带头，后台那一次请求也回到旧实现。

## 回滚

回滚写进当前站点的 `localStorage`，刷新后仍然有效，直到改回 `next` 或清掉该键。六个开关仍然各自独立。

| 操作 | 结果 |
| --- | --- |
| `?xmViewport=0`（`xmNodes`、`xmHistory`、`xmDocument`、`xmDispatch`、`xmAssets` 同样） | 写入对应键 `legacy`，这一项回到旧实现 |
| 查询值 `legacy` | 与 `0` 相同 |
| 控制台 `XiaomeiViewportKernel.setActive(false)`（其余为 `XiaomeiNodeKernel`、`XiaomeiHistoryKernel`、`XiaomeiDocumentKernel`、`XiaomeiDispatchKernel`、`XiaomeiShellKernel`） | 立刻关掉，并写入 `legacy`；刷新后仍是旧实现 |
| `localStorage.setItem('xiaomei.viewportKernel', 'legacy')` 或 `'0'`，然后刷新 | 与查询参数 `0` 相同。另外五个键是 `xiaomei.nodeKernel`、`xiaomei.historyKernel`、`xiaomei.documentKernel`、`xiaomei.dispatchKernel`、`xiaomei.assetKernel` |
| `?xmViewport=1` 或 `next`，或 `setActive(true)` | 写回 `next` |
| 删掉对应键再刷新 | 回到默认 next |

调度回滚后，本地 `/api/` 请求不再带 `X-Xiaomei-Dispatch`。素材回滚后，素材和平台相关请求不再带 `X-Xiaomei-Assets`。服务端看到缺头就用旧函数。

主壳用 iframe 打开画布时，查询参数要加在画布页地址上。`localStorage` 是同一站点共用的，设一次即可。

## 旧文件仍在

A 类旧文件仍在源码树里，也仍由当前 `electron-builder.yml` 的 `files` 打进安装包。它们是回滚时实际执行的实现，不是已经删掉的副本。`canvas.js`、`smart-canvas.js`、`main.py` 以及设置页、素材页、主题、预览、历史多选里的旧分支都还在。

从安装包移除这些文件，仍然要另外满足第三阶段和第五阶段写过的条件：不带参数的手工验收通过、发布清单不再把该路径当成必需内容、用户目录里的画布和素材不被迁移或删除、并且留有可安装的旧构建。这一次只改默认，不满足那些删除条件。

## 自动化

```text
python3 -m unittest tests.test_dispatch_kernel tests.test_asset_kernel
node --test tests/xiaomei-viewport-kernel.test.cjs tests/xiaomei-node-kernel.test.cjs tests/xiaomei-history-kernel.test.cjs tests/xiaomei-document-kernel.test.cjs tests/xiaomei-dispatch-kernel.test.cjs tests/xiaomei-shell-kernel.test.cjs
```

这些测试现在锁定：空存储默认 next、查询 `1`/`next` 仍写入 next、查询 `0`/`legacy` 写入并保持 legacy、`setActive(false)` 同样保持 legacy、调度和素材在默认路径发送 `next` 请求头，回滚后不再发送。服务端对 `next` 进入新模块，对缺头和 `legacy` 留在旧函数。

## 手工验收

在本机用已有项目和平台配置做。不要清理用户目录。若这个配置以前用 `?=0` 或 `setActive(false)` 写过 `legacy`，先删掉那六个键，否则会一直停在回滚路径。

1. 不带参数打开经典画布和智能画布。`document.documentElement.dataset` 里 `xmViewport`、`xmNodes`、`xmHistory`、`xmDocument`、`xmDispatch` 都是 `next`。平移、滚轮、拖节点、拉线、分组、撤销、复制粘贴、打开旧项目再保存，应仍能完成。
2. 不带参数打开素材页和 API 设置。`xmAssets` 为 `next`。分类、上传、移动和平台保存仍用现有字段；模型列表仍是账号里已有的名称。
3. 做一次文生图或图生图。请求应带 `X-Xiaomei-Dispatch: next`，任务能回到节点；失败时仍能看到原因。真实平台密钥下的付费请求不在自动化里。
4. 分别加上 `?xmViewport=0`、`?xmNodes=0`、`?xmHistory=0`、`?xmDocument=0`、`?xmDispatch=0`、`?xmAssets=0` 并刷新。对应属性回到 `legacy`，刷新后仍然是 `legacy`。调度和素材请求不再带新头部。
5. 把对应查询改回 `1`，或在控制台调用该内核的 `setActive(true)` 后刷新，属性回到 `next`。
6. 相机节点、商品分析、SKU、批量入口仍能打开。CainFlow 文件没有改。

第二阶段各篇和第三、第五阶段记录的是当时「默认关闭」的状态。当前默认以本文件为准。
