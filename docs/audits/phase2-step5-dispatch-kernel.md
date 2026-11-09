# 第二阶段第五步：模型协议与任务调度

日期：2026-11-09

这一步只替换来自大熊的平台地址拼接、上游任务状态判断，以及画布侧的轮询结论。素材库、公共工具和界面整包替换没有做。CainFlow、商品分析、SKU、批量生成、电商工作台、`LICENSE` 和版权声明都没有改。用户目录不会被扫描或覆盖。

默认仍走旧实现。不带开关时，请求不会带新头部，服务端函数和以前一样。

## 来源与做法

现网协议保持这些约定：

- 平台 ID 是 2 到 40 位字母、数字、下划线或短横线。Base URL 必须以 `http://` 或 `https://` 开头。不认识的协议按 `openai`。
- 生成地址优先用平台上单独填写的端口；相对路径接到站点源上。Base URL 已经带 `/v1`、`/v2`、`/v1beta` 或 `/api/v3` 时，不再把同一段路径拼两次。
- 查任务时，视频代理模式走 `/v1/videos/{id}`，apimart 走 `/v1/tasks/{id}`，其余走 `/v1/images/tasks/{id}`。
- 上游状态写成 succeeded、failed 或仍在进行。成功但没有图片地址算失败。`jimeng_pending` 和可恢复的失败仍交给原来的即梦和恢复提示。
- 任务记录仍是先 `queued`，查到结果后变成 `succeeded` 或 `failed`。创建接口、字段名和本地任务文件路径都没有换。

新文件是 `dispatch_kernel.py` 和 `static/js/xiaomei-dispatch-kernel.js`。对照上游 `main.py`，Python 模块没有连续 8 行相同代码，最长相同行是 3 行。

`python3 -m unittest tests.test_dispatch_kernel` 和 `node --test tests/xiaomei-dispatch-kernel.test.cjs` 已通过。

## 开关与回滚

| 操作 | 结果 |
| --- | --- |
| 什么都不做 | `data-xm-dispatch="legacy"`，本地 `/api/` 请求不带新头部 |
| `?xmDispatch=1` 或 `next` | 写入 `localStorage['xiaomei.dispatchKernel']='next'`，之后本页的 `/api/` 请求带 `X-Xiaomei-Dispatch: next` |
| `?xmDispatch=0` 或 `legacy` | 回到旧协议函数 |
| `XiaomeiDispatchKernel.setActive(false)` 后刷新 | 同上 |

服务端只在这个请求头等于 `next` 时改用新模块。后台生图任务沿用创建那次请求的选择。其它步骤的 `xmViewport`、`xmNodes`、`xmHistory`、`xmDocument` 仍然各自独立。

## 最小适配层

真正提交给平台、写任务文件和画布上的成功失败提示仍在原来的函数里。开关打开时：

- `main.py` 的平台地址、任务查询地址、上游状态和失败原因改走 `dispatch_kernel`。平台记录的 ID、名称、地址和协议先由新模块检查。
- `static/js/canvas.js` 和 `static/js/smart-canvas.js` 的轮询结论改走新模块，即梦排队、取消和可恢复失败仍用原来的提示对象。
- `static/js/image-task-client.js` 在没有单独分类函数时也看新模块的结论。
- `static/canvas.html`、`static/smart-canvas.html`、`static/online.html` 在任务客户端之前加载内核。

## 手工验收

1. 不带参数打开画布。`document.documentElement.dataset.xmDispatch` 为 `legacy`。用现有平台做一次生图，结果应与现在一致。
2. 加上 `?xmDispatch=1` 刷新。再做一次文生图或图生图，任务应能排队、完成，并把图片放回节点。
3. 如有视频节点和对话节点，各跑一次。失败时应仍能看到失败原因，而不是一直转圈。
4. `?xmDispatch=0` 刷新后，请求不再带 `X-Xiaomei-Dispatch`，生成回到旧函数。
5. 确认没有改用户目录里的素材和历史。

本环境跑了协议单测和语法检查，没有用真实平台密钥发起付费请求。请在本机用已配置的平台走一遍。

## 还没做的事

素材管理、公共工具和界面整包替换留到后面的步骤。验收通过之前不要删除旧的平台和任务函数。
