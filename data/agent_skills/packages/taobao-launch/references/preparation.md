# 上架准备

本文件只描述单商品 `PreparationWorkflow`。完整草稿和内部领域引用永远不进入模型上下文。

## 创建 Workflow

普通目录模式从用户原话提取后一次调用：

```json
{
  "productPath": "绝对目录",
  "categoryQuery": "用户给出的类目路径或名称",
  "businessInput": { "title": "标题", "price": "十进制价格" },
  "explicitProperties": [{ "label": "风格", "texts": ["中古风"] }]
}
```

可选业务字段只有 `quantity/shoppingTitle/subTitle`。禁止添加 `item_msg`、图片、平台属性、SKU 或任意内部 ref。没有显式属性时传 `[]`；标题、路径、文件名、图片和 OCR 不是属性证据。

`prepare_start` 会核对登录店铺和平台、绑定商品目录 `realpath`、扫描素材并返回唯一 `workflowRef`。后续始终逐字复制这个句柄，不再复制店铺、平台、类目 ID 或业务输入。

商品上架资料包模式只调用：

```json
{"productPath":"商品上架资料包绝对目录","platform":"用户明确指定时才传 taobao 或 tmall"}
```

Desktop 的 `[folder attached: <绝对路径>]` 表示用户已通过“添加文件夹”显式提供该目录。必须把 marker 内的绝对路径直接作为 `productPath`，不得要求用户重新输入或粘贴路径；一个 marker 计为一个商品目录，多个 marker 按批量商品处理。`[media attached: ...]` 不是目录路径。

工具按名称读取根目录 `商品信息.xlsx` 的 `基本信息`、`SKU` 和可选 `尺码表`，不依赖 Sheet 顺序；不接受独立 `SKU信息.xlsx` 代替资料包内的 `SKU`。类目路径和类目 ID 都可留空，此时按标题走现有类目识别；两者都填写时必须匹配。大白官方 Workbook 只接受当前版本，旧版或结构变化要求重新导出；无大白元数据的自定义结构仍支持受控别名和映射。返回 `needs_package_mapping` 时，只依据 `profile.columns/profile.rows` 生成一次受限映射并调用：

```json
{"packageRef":"逐字复制","mapping":{"fieldColumnId":"候选 ID","valueColumnId":"候选 ID","platformRowId":"候选 ID","titleRowId":"候选 ID","priceRowId":"候选 ID"}}
```

可选类目、类目 ID、属性分段也只能使用当前候选 ID。禁止通过通用 read/exec 打开 XLSX，禁止传列号、行号、自由代码或猜测值。映射或 Workflow 建立后商品上架资料包发生任何变化，必须重新准备。

## 图片选择与主图补白

从 `inspection.entries` 选择最终主图和详情图：

```json
{"workflowRef":"...","paths":["主图绝对路径"],"descPaths":["详情图绝对路径"]}
```

路径必须来自当前 Workflow 扫描结果，不能重复或交叉。主图 1～5 张。

“透明素材图”是平台素材坑位名称，不是本地格式约束。标准命名或用户明确映射的 JPG、JPEG、PNG 等本地图片都可作为候选；本地流程不要求 PNG，也不以 Alpha 透明像素作为 Preview 硬门，最终内容合法性由淘宝 / 天猫官方接口校验。工具仅报告 `pic_dict.whiteBgImage` 缺失时，表示 Workflow 尚未映射该坑位，不能据此推断用户缺图、格式错误或必须重新制图。

非 1:1 主图由 `check_main_images` 自动补白到 1:1 并归档原图；不需要用户确认，也不存在单独的主图处理工具。禁止用通用命令或其他图片工具处理主图。

## 固定 nextAction

只执行工具返回的唯一 `nextAction`：

- `select_template` → `template_list({workflowRef})`
- `select_category` → 用户选择后 `select_category({workflowRef,decisionId,candidateId})`
- `select_assets` → 用户确认用途后 `select_assets({workflowRef,decisionId,mappings})`
- `fetch_category_props` → `fetch_category_props({workflowRef})`
- `resolve_properties` → `resolve_properties({workflowRef})`
- `prepare_sku` → `prepare_sku_source({workflowRef})`
- `prepare_size_chart` → 只把用户明确提供的尺码测量行传给 `compile_size_chart_rows({workflowRef,rows})`
- `preview` → `preview({workflowRef})`

模板选择、类目解析、属性快照、`templateRef/propsRef` 都由工具内部登记。工具只接受公开 Schema 中的 Workflow 参数，不要夹带内部引用、类目、平台或模板字段。

类目和素材只能从当前 Workflow 签发的候选中选择。素材 mappings 可只提交本次需调整的候选，未选择的候选省略并进入 `unusedMaterials` warning；只有用户明确要求“忽略/排除/不要再提示”时，才能通过候选的 `purpose=ignore` 写回。“未使用但保留警告”必须省略映射，绝不能传 ignore。禁止传任意类目 ID、素材路径或 JSON Patch。存在待决策时不调用其他写工具。

属性严格匹配返回 unresolved 时，可以用 `get_property_details({workflowRef,properties})` 查询官方候选，再用 `{workflowRef,matches}` 完整覆盖全部 unresolved。禁止传 `propertyIntentRef/propertyPatchRef`。

`WORKFLOW_*` 错误必须按结构化 action 处理：过期后重新准备；decision pending 只处理当前决策；stage already ready 直接执行 `nextAction`，不重做原工具。明确指定平台时若身份不一致，先结束回合并请用户切换目标店铺；禁止删掉 `platform` 重试、自动降级到当前平台或创建另一平台 Workflow。模板是否存在也只能在身份一致的 Workflow 中判断。

## 业务修正

用户修正标题、价格、库存、导购标题或副标题时，只调用：

```json
{"workflowRef":"...","content":{"price":"9.74"}}
```

禁止借此修改身份、类目、模板、属性、SKU、图片或传 JSON Patch。Preview 后更新会撤销旧授权，必须重新 Preview。
