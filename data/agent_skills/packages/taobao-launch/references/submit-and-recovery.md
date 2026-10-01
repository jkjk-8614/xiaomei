# Preview、提交与恢复

## Preview

单商品唯一合法调用：

```json
{"workflowRef":"..."}
```

禁止传 `draft/baseDraftRef/patch/LaunchPayload/item_msg`。工具内部锁定 Workflow 快照、核对 readiness/身份/TTL/待确认状态、构造草稿、物化属性与 SKU、执行模板干跑并封存。

成功结果中的 `previewText` 已由同一次确定性 Preview 快照整合标题、类目、显式属性应用结果、主图/详情图数量、规格图、SKU 搜索主图、SKU 行数和维度、可售/全量价格、库存、warnings、未使用素材、提交校验与下一步。必须原样、完整展示 `previewText`，不得删项、改数字或从前序消息补算。是否允许提交仍只看结构化 `canSubmit/nextAction`，禁止解析展示文案猜状态。Preview 成功不等于真实上架成功。

只有 `canSubmit=true` 且 `nextAction=submit` 才能使用返回的 `confirmToken`。同一 revision 禁止重复 Preview；业务输入更新后旧 token 已撤销，必须重新 Preview。

## 单商品提交

- 快速模式：Preview ready 后调用 `submit_start({confirmToken})`。
- 严格模式：展示 Preview，等用户明确确认后调用。
- `submit_start` 后直接 `submit_status({runId})`；收到 `running=true` 就继续调用，直到 `running=false`。工具内部每次读取前异步等待 3 秒，使实际轮询保持 3～5 秒；禁止另用 runtime/sleep。
- token 和 runId 不展示给用户，不用于其他工具。

## 安全停止

- 失败结果以 `phase/stage/code/action/scope` 为完整契约：`phase` 定位大步，`stage` 定位小步，`action` 是唯一允许的下一步；`message` 只用于说明，不能作为恢复依据。
- `action=stop` 时立即结束。禁止重复当前工具、重新 Preview、跳过失败步骤，或修改无关业务输入来刷新 revision/token。
- 任一契约字段缺失时按内部协议异常停止，不自行推断。
- `canSubmit=false`、block/confirm warning 未解决：禁止提交。
- 登录失效、验证码、店铺/平台不一致：停止，不自动切店或重试。
- `unknown/check_submit_result`：平台可能收到请求，必须人工核验，禁止重新 Preview 或提交。
- 只有终态明确成功且返回商品 ID/链接，才能报告上架成功。
- `startedAt/finishedAt` 是内部 UTC 时间，只用于状态记录、日志和排障。除非工具将来提供专门的用户展示时间字段，否则最终回复禁止展示“上架时间”，禁止展示、换算、截取或重述这两个字段；成功结果只报告平台、商品 ID 和商品链接。

图片上传失败时，只逐字报告 `tasks[].asset.fileName` 点名的文件；不得根据目录、顺序或上下文猜是哪张图。

## 批量与恢复

批量、Resume/Retry/Resolve unknown 由 LaunchJob 工具处理，但不得把 Workflow 的内部引用或草稿暴露给模型。

- 批量先为每个商品分别完成准备，所有 Workflow 都必须停在 `nextAction=preview`；不得调用单商品 `preview`，不得由模型构造 `LaunchPlan/item_msg`。
- 真实批量一次调用 `batch_start({workflowRefs:[...]})`，至少 2 个且顺序与用户商品顺序一致。Job 持久化成功后这些 Workflow 才被消费；创建失败时保留，可按结构化错误恢复。
- 只检查一次调用 `batch_inspect_start({workflowRefs:[...]})`，允许 1 个及以上且不消费 Workflow。预检结果不能代替真实批量中的逐商品 Preview。
- Start 后只保存 `jobId` 并调用 Job status；公开状态只包含进度、错误和业务结果，不包含封存草稿、模板/属性引用或店铺内部身份。
- 同一 `platform + shopKey` 同时只运行一个 execute LaunchJob；不同目标可并行，inspect 不占位。
- Resume 只继续原 Job 中安全可继续的商品，不修改原输入；当前 Job 有未 Resolve `unknown` 时禁止 Resume。
- Retry 只传 `parentJobId` 与 `items[].itemKey/workflowRef?`。不带 `workflowRef` 时程序完整复制父 Job 封存输入；需要修改时先把同类目商品重新准备到 `nextAction=preview`，再传新的 `workflowRef`。修正流程必须与父商品店铺、平台、类目一致，可使用同类目重新采集的模板；模型不得生成 `item_msg`，`unknown` 商品本身禁止 Retry。
- `unknown` 只隔离当前商品，禁止自动 Retry；同一 Job 后续商品和同目标其他 execute Job 继续执行。Resolve 必须使用人工核验的真实结果。
- Cancel 只阻止尚未开始的新商品，不能撤回已经发出的平台请求。
