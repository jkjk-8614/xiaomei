# SKU 与尺码表

SKU 工具从 Workflow 内部读取商品目录、模板和来源引用。模型不读取 CSV/XLSX，不传 `templateId/catId/sourceRef/skuRef/sizeChartRef/matchRef`。

## SKU 准备

先服从 Workflow 的 `nextAction`。淘宝和天猫模板均可能是无 SKU：工具会直接把 SKU 阶段标记 ready，只使用商品级价格和库存；此时不会出现 `prepare_sku`，不得主动调用 SKU 工具、寻找 SKU 文件或要求用户补 SKU。

通常只调用：

```json
{"workflowRef":"..."}
```

- 首次只传 `workflowRef`。工具会忽略自身生成的 `淘宝/天猫SKU填写模板_<catId> (n).xlsx`，并在恰好剩一个原始 SKU 文件时自动选择它。
- `export_template(scope=sku)` 导出的 `<淘宝/天猫>_<catId>_SKU信息.xlsx` 填写后可直接放进普通商品素材目录；模板启用尺码表时，同一 Workbook 带独立可见的 `尺码表` Sheet。它是有效 SKU 来源，目录内只有这一个 SKU 文件时自动选择。
- 只有明确返回 `SKU_SOURCE_SELECTION_REQUIRED` 时，才能等待用户从 `prepare_start` 扫描候选中选择并补一个 `path`；禁止模型按名称或顺序猜路径。显式选择工具生成且已由用户填写的模板仍受支持。
- `needs_mapping` 时，根据紧凑 profile 生成最小 `mappingIntent`，再用同一 `workflowRef` 调用。
- 价格和库存只映射源 `column`，禁止填写 `scope`。工具会按实际单元格确定性判断逐行值、全局单值、真实合并范围或维度共享；无法唯一判断时要求用户补全源表，不让模型猜。
- `mappingIntent` 只描述业务语义。图片只用 `specImage` 和 `skuSearchImage`。AI 必须结合列名、样例值、稀疏/合并特征和模板 Schema 判断用途；“SKU搜索主图”“搜索主图”是 `skuSearchImage` 的高置信提示，“SKU图”“图片”“销售规格图”“<维度名>图”（如“颜色分类图”）是 `specImage` 的高置信提示，但不是固定列名白名单。其他列名也可按语义映射。同一列禁止兼任两种用途。搜索图支持逐行或 XLSX 真实纵向合并，合并范围内所有 SKU 共用一张图，普通空白绝不继承；规格图按目标维度值稀疏共享，同一值解析到不同真实文件时冲突。若多个非空列都可能是规格图，先让用户选择一个，其他列必须明确忽略。若来源明确包含规格图但 Schema 为 `target-dimension-unknown`，必须换用包含规格图证据的参考模板，不能删掉该映射继续。
- 推荐模板中的规格图和`SKU搜索主图`都只填写文件名，例如`1.jpg`、`搜索主图_1.jpg`；工具优先从商品素材根目录下按既有`SKU图/SKU图片/规格图/SKU`目录映射查找。
- Profile 中带 `localImageReferenceCount` 的明显本地图片候选列必须映射到一个图片用途；若列名语义不明确，先询问用户并结束回合，只有用户明确说忽略该列后才能把它写入 `ignoredImageColumns`。`http://`、`https://` 和 `//` 远程地址统一自动当空值，不下载、不按 SKU 上下文找本地图，也不写入 `ignoredImageColumns`。
- 即使用户已经明确要求忽略，首次提交含 `ignoredImageColumns` 的 Intent 仍会返回 Workflow 决策与 `mustEndTurn=true`。原样展示 `userPrompt` 并结束回合；下一回合只传 `workflowRef + decisionId + confirmed` 给 `prepare_sku_source`，不得重传或改写 Mapping Intent。
- `needs_mapping_correction` 只修正 code 指出的意图；不得重复相同输入，不读取完整行。`SKU_SALES_ATTRIBUTE_IMAGE_TEMPLATE_REQUIRED` 不属于可改列语义的 mapping correction：Workflow 会失效当前模板并转到 `select_template`，同一规格图列在模板重选后仍必须映射为 `specImage`。
- 工具返回 ready 后，SKU 和可选尺码表引用已在 Workflow 内登记；禁止复制返回引用或重建 SKU 矩阵。

## SKU 图片确认

返回 `mustEndTurn=true` 时按每组的 `purposeLabel + targetKey` 展示两个图片用途的候选和 `userPrompt`，立即结束回合。两个用途只进行这一轮统一确认。用户明确确认后调用：

```json
{
  "workflowRef":"...",
  "decisionId":"逐字复制 prepare_sku_source 返回的当前决策 ID",
  "confirmed":true,
  "matches":[{"referenceId":"工具候选 ID","candidateId":"工具候选 ID"}]
}
```

只能使用候选 ID 和当前 `decisionId`；禁止省略 `decisionId`，禁止按目录顺序、文件名猜测或传内部匹配 ref。若调用方丢失当前决策数据，用同一 `workflowRef` 再调用一次 `prepare_sku_source` 取回原待确认项，不重建 Workflow、不重复编译。

## 独立尺码表

资料包和独立 `SKU信息.xlsx` 都统一使用同一 Workbook 内的可见 `尺码表` Sheet。导出时直接带当前模板的真实尺码和测量值，不生成示例行；商家可保留或修改。第一列是 `尺码`，每个尺码只能一行；同尺码重复时无论数值相同还是冲突都拒绝。单值列形如 `身高（cm）`，区间列形如 `体重下限（kg）/体重上限（kg）`。整列全空表示不启用；启用后每个最终 SKU 尺码都必须填写。

SKU 文件已确定性编译出尺码表时不重复调用。只有 Workflow 明确返回 `nextAction=prepare_size_chart`，且用户明确提供小型测量行时，才调用 `compile_size_chart_rows({workflowRef,rows})`。不推算缺失值，不生成原始 `sizeMapping`。Workbook 中可见的模板实值属于用户本次输入；用户全部清空后必须阻断，不允许从隐藏内容恢复。
