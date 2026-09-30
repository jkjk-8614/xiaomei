---
name: taobao-launch
description: 当用户要在淘宝或天猫发布、上架、上传、铺货商品（单个或批量），或要求采集淘宝或天猫商品模板时使用。通过 taobao_launch_* 工具创建可信准备流程、预览校验并提交。默认快速模式；用户明确要求严格模式时，在发布渠道和单商品 Preview 两个节点确认。
---

# 淘宝 / 天猫商品上架

本 Skill 只做自然语言提取、受限候选选择和用户沟通。身份、图片、模板、属性、SKU、草稿、Preview、授权和提交状态全部以工具为准。

## 上架安全底线

以下规则优先于后续流程细节，任何阶段都不得违反：

- 只按工具返回的 `nextAction/action` 前进；禁止自行跳步、重排流程，或在相同错误和状态下重复调用。
- 唯一允许长期保存的内部句柄是 `workflowRef`；禁止自行生成或传递完整草稿、SKU 矩阵和内部引用。
- 只有 `canSubmit=true` 且 `nextAction=submit` 才能提交。商品资料或业务输入变化后，旧授权立即失效，必须重新 Preview。
- 工具返回 `mustEndTurn=true` 时，按要求回复后立即结束当前回合，等待用户确认。
- 提交后只调用状态工具直到 `running=false`，禁止另用 runtime/sleep。结果为 `unknown` 时必须人工核验，禁止自动重试或重新提交。
- 只有终态明确成功并返回商品 ID/链接时，才能报告上架成功。最终回复只报告平台、商品 ID 和商品链接，禁止展示“上架时间”或 `startedAt/finishedAt`。
- 禁止用通用读写或执行工具读取、生成、修改商品资料、草稿、SKU 或中间文件。

## 意图分流

- 只选择 Skill、未给任务：请用户提供商品资料和素材目录，不调用工具。
- 询问用法或模式：只解释快速/严格模式，不启动上架。
- 意图名称归一化：用户说“导出模板”“上架模板”“上架素材包”或“上架资料包”，都表示导出完整的“商品上架资料包”，不得追问导出范围；对外统一使用“商品上架资料包”。只有明确说“只导出 SKU”或“导出 SKU 模板”时才按 SKU 范围处理。“采集商品模板”仍是独立的模板采集意图，不得因含“模板”二字改走导出。
- 导出 SKU 或商品上架资料包：调用 `taobao_launch_export_template`。用户未明确“只导出 SKU”时省略 `scope`，由工具默认导出完整资料包；只有明确只要 SKU 时才传 `scope=sku`。用户未明确平台时禁止询问，省略 `platform`，由工具使用当前登录平台。用户未指定类目且本次任务链近期刚成功采集模板时，只传本次采集返回的 `templateId`，由工具确定类目，不重新列历史模板。显式模板损坏时直接报告并停止；没有显式模板时由工具按采集时间惰性选择，不要求用户校验所有历史模板。商品上架资料包会在缺少可复用类目规则时自动联网获取。`scope=sku` 返回 `status=not_applicable` 表示当前模板没有 SKU，无需生成文件。成功后只告诉用户怎么使用以及最终绝对路径，不介绍工具名、参数或内部实现，不继续上架。
- 采集商品模板：读取 [`references/template-capture.md`](references/template-capture.md)，走独立采集流程。
- 单商品上架：只走下面的 Workflow。
- 只检查：不得调用 `submit_start` 或任何真实执行工具。
- 2 个及以上商品：为每个商品分别创建并推进 Workflow 到 `nextAction=preview`，不得调用单商品 Preview；按用户顺序收集工具返回的 `workflowRef`，必须只调用一次 `taobao_launch_batch_start({ workflowRefs })`。不得生成 `plan/item_msg` 或任何内部引用。
- Desktop 把用户通过“添加文件夹”选择的目录表示为 `[folder attached: <绝对路径>]`。该 marker 表示用户已显式提供目录路径，必须提取其中的绝对路径并按直接输入的路径参与意图分流、商品数量判断和 `productPath` 构造；不得要求用户重新输入或粘贴路径。一个 folder marker 计为一个商品目录，多个 marker 按多个商品处理。`[media attached: ...]` 不是目录路径，不得据此构造 `productPath`。

## 近期上下文复用

- 当前任务链中最近一次相关工具成功结果可以直接复用，不按固定消息条数失效；用户明确切换商品、类目、平台、资料目录，或出现多个无法区分的成功结果时才停止复用。
- 当前用户明确指定的信息优先于近期结果。不得复用失败结果、模型推测或其他会话的信息。
- 用户未再指定类目并要求导出时，优先复用近期成功采集返回的 `templateId`；不再询问类目、平台或导出范围。
- 用户未再指定目录并要求上架时，优先复用近期成功导出的 `scope=package` 结果中的 `outputPath` 作为 `productPath`；单独 SKU 导出的文件不能当作商品上架资料包。
- 没有可复用结果或近期上下文确有冲突时，只询问缺失的类目或商品目录，不询问能由登录态确定的平台，也不询问默认导出范围。

具体任务开始时读取 [`references/interaction.md`](references/interaction.md)。references 不提供平台草稿生成规则；完整草稿只能由工具内部构造。

按阶段渐进读取，不要预先读取全部参考文件：

- 创建单商品 Workflow 前读取 [`references/preparation.md`](references/preparation.md)。
- 进入 SKU 或尺码表步骤前读取 [`references/sku-and-size-chart.md`](references/sku-and-size-chart.md)。
- 进入 Preview、提交或恢复前读取 [`references/submit-and-recovery.md`](references/submit-and-recovery.md)。

## 唯一句柄

每个商品准备开始后，模型唯一允许长期保存的内部句柄是 `workflowRef`；批量任务只保存按用户顺序排列的 `workflowRef` 列表。工具返回待决策事项时，只能在该事项的下一次调用中逐字回传当前 `decisionId/candidateId`；消费后立即丢弃，不能改写、复用或当作通用修改入口。

禁止在工具参数中生成、复制、改写或占位以下内容：

- 完整 `draft`、`LaunchPayload`、`item_msg` 或任意草稿 JSON。
- `templateRef`、`propsRef`、`propertyPatchRef`、`propertyIntentRef`。
- `sourceRef`、`skuRef`、`sizeChartRef`、`matchRef`、`preflightRef`、`assetRef`。
- 平台属性对象、SKU 矩阵、平台 ID 或占位 ref。

工具结果即使包含业务摘要，也不能据此反向拼草稿。`taobao_launch_preview` 只能调用：

```json
{"workflowRef":"逐字复制 prepare_start 返回值"}
```

## 单商品固定流程

1. 单商品上架时，用户只提供一个目录路径（包括一个 `[folder attached: <绝对路径>]`）、未明确提供 `categoryQuery`、标题和价格，必须先按商品上架资料包候选处理，直接调用 `taobao_launch_prepare_start({productPath, platform?})`；folder marker 场景的 `productPath` 就是 marker 内的绝对路径。禁止提前追问标题或价格，禁止要求用户重新提供路径，禁止传空的 `categoryQuery` 或 `businessInput`。工具确认目录不是有效商品上架资料包后，才能说明原因并询问普通目录模式缺少的业务输入，不得自动降级。商品上架资料包只提取根目录 `productPath` 和用户明确给出的可选 `platform`；不得用通用工具读取 XLSX。普通目录模式才从用户原话提取 `productPath`、`categoryQuery`、标题、价格、可选库存/导购标题/副标题，以及用户明确表达的 `explicitProperties:[{label,texts}]`。用户使用单独导出的 `SKU信息.xlsx` 时走普通目录模式：`productPath` 传该文件所在的商品素材目录，文件由后续 `prepare_sku_source` 自动识别。
2. 快速模式直接调用 `taobao_launch_prepare_start`。严格模式先用 `taobao_launch_check_login` 得到唯一发布渠道并等待用户确认，再调用 `prepare_start`。商品上架资料包调用只传 `{productPath, platform?}`；若返回 `needs_package_mapping`，只能根据返回的受限列/行候选生成映射，再调用 `taobao_launch_resolve_package({packageRef,mapping})`。准备入口绑定店铺/平台和商品真实路径、保存业务输入，并返回素材扫描与 `workflowRef`。
3. 商品上架资料包的主图和详情图已保存在 Workflow，直接调用 `taobao_launch_check_main_images({workflowRef})`；只有普通目录模式才根据扫描结果选择最终 1～5 张主图和详情图，并显式传 `{workflowRef,paths,descPaths}`。
4. 严格按每个结果的唯一 `nextAction` 调用下一工具：
   - `select_template` → `taobao_launch_template_list({workflowRef})`
   - `select_category` → 等用户从工具候选中选择，再调用 `taobao_launch_select_category({workflowRef,decisionId,candidateId})`
   - `select_assets` → 等用户确认候选用途，再调用 `taobao_launch_select_assets({workflowRef,decisionId,mappings})`
   - `fetch_category_props` → `taobao_launch_fetch_category_props({workflowRef})`
   - `resolve_properties` → `taobao_launch_resolve_properties({workflowRef})`
   - `prepare_sku` → `taobao_launch_prepare_sku_source({workflowRef})`
   - `preview` → `taobao_launch_preview({workflowRef})`
   无 SKU 商品由模板决定并直接跳过 `prepare_sku`；不得因为流程没有出现该 action 而补调 SKU 工具。
5. `resolve_properties` 只有返回 unresolved 时，才调用 `get_property_details({workflowRef,properties})`，再把完整 `matches` 与同一 `workflowRef` 传回；禁止传属性 intent ref。
6. `prepare_sku_source` 首次只传 `workflowRef`；工具会忽略自己生成的推荐模板并确定性选择唯一原始 SKU 文件。只有工具明确返回 `SKU_SOURCE_SELECTION_REQUIRED` 时，才等待用户从扫描候选中选择并补 `path`，禁止模型猜路径。只有返回 `needs_mapping` 时，才根据紧凑 profile 传最小 `mappingIntent`；图片字段只用 `specImage/skuSearchImage`。AI 必须结合列名、样例值、稀疏/合并特征和模板 Schema 判定用途；“SKU搜索主图”“搜索主图”是 `skuSearchImage` 的高置信提示，“SKU图”“图片”“销售规格图”“<维度名>图”（如“颜色分类图”）是 `specImage` 的高置信提示，但这些名称都不是白名单，其他列名也可按语义映射。搜索图和规格图可同时存在，但同一列禁止兼任两种用途，规格图只能作用于模板证明的一个维度。若多个非空列都可能是规格图，先让用户选择一个，其余列只有用户明确要求忽略后才能填 `ignoredImageColumns`。远程 URL 由工具直接当空值，不填写 ignore、不下载、不找本地图。仍只传同一 `workflowRef`，禁止传 SKU source ref。
7. Preview 成功返回 `previewText` 后，必须原样、完整展示该字段，不删项、不改数字、不从前序消息补算；它已整合标题、类目、属性、主图、规格图、SKU 搜索主图、SKU 数量/维度、价格、库存、warning、未使用素材、提交校验与下一步。SKU 图片缺失是可选状态，不单独 warning；未使用素材只 warning，不阻断；用户明确 ignore 的文件不再 warning。仍以结构化 `canSubmit/nextAction` 判断能否提交，禁止从 `previewText` 文案反推状态。
8. 快速模式立即调用 `taobao_launch_submit_start({confirmToken})`；严格模式等用户明确确认。随后直接调用 `submit_status({runId})`，收到 `running=true` 就继续调用，直到 `running=false`；工具先立即读取，仅在任务仍运行时内置等待 3 秒并再次读取，禁止另用 runtime/sleep。

## 硬门与确认

- `prepare_start` 登录失败时按 `action=login` 暂停。明确指定平台时若返回 `WORKFLOW_IDENTITY_MISMATCH`，立即停止并请用户切换到目标店铺；禁止删掉 `platform` 重试、禁止自动改用当前平台、禁止为另一平台创建 Workflow。只有工具重新确认目标店铺和平台一致后才能重新准备。
- 商品上架资料包中的类目和类目 ID 均可留空；两者都为空时由工具按标题进入现有类目识别和确认流程。两者都填写时必须匹配。商品信息、SKU、图片或目录在准备后变化时，旧 Workflow 失效并必须重新准备。
- `nextAction` 是唯一合法恢复方向（成功结果）；失败结果只按 `action` 恢复。禁止自行重排、跳步，禁止在相同错误码、相同状态、相同关键输入下重复调用。
- `SKU_SALES_ATTRIBUTE_IMAGE_TEMPLATE_REQUIRED` 表示 AI 已确认来源包含规格图、但当前参考模板无法确定目标维度。此时当前模板会被 Workflow 立即失效，只能按 `action/nextAction=select_template` 选择具备规格图证据的模板；禁止把同一列改成 `skuSearchImage`、删除映射或忽略后继续。
- 模板可用性只能在平台和店铺身份一致的 Workflow 中判断；身份冲突后不得查询另一平台并据此声称目标平台缺模板或要求重新采集。
- 类目或素材用途有歧义时，只展示当前工具签发的受限候选；用户选择后原样回传 `decisionId/candidateId`。禁止传任意 `catId`、平台 ID、路径或 JSON Patch。
- 素材 `mappings` 可以只提交用户已明确选择的候选；未选择的候选必须省略并进入 `unusedMaterials` warning。只有用户明确说“忽略/排除/不要再提示”时才能传 `purpose=ignore`；“未使用但保留警告”绝不等于 ignore，也不得在结果里把已 ignore 的文件声称为仍有 warning。
- 主图检查不会签发跨回合确认；非 1:1 主图由 `check_main_images` 自动补白到 1:1，并把原图归档到同目录 `原图(忽略)`。失败时只按返回的 `action` 恢复。
- SKU 图片返回 `mustEndTurn=true` 时同样立即结束回合。用户确认后只传 `workflowRef`、`decisionId`、`confirmed:true` 和工具候选的 `referenceId/candidateId`；禁止传匹配 ref 或按目录顺序猜图。
- 图片候选列忽略返回 `status=needs_image_column_ignore_confirmation/mustEndTurn=true` 时，把 `userPrompt` 原样作为回复最后一行并结束回合。用户后续明确同意或拒绝后，只调用 `prepare_sku_source({workflowRef,decisionId,confirmed})`；禁止重传或修改原 `mappingIntent`。
- 属性只来自用户原话中的显式表达；`properties` 只填用户明确表达的 `[{ label, texts }]`，由准备入口保存为 `explicitProperties`。标题、类目、路径、文件名、图片、OCR 和模型推断都不能触发属性覆盖；没有显式属性传 `[]`。
- `WORKFLOW_NOT_READY`、`WORKFLOW_CONFIRMATION_PENDING`、`WORKFLOW_STAGE_ALREADY_READY` 后按返回的 `nextAction/action` 前进，不重做原工具。
- Preview 后禁止修改 Workflow 再消费旧授权。若用户修正标题、价格等，只调用 `update_business_input({workflowRef,content})`；旧确认授权会失效，必须重新 Preview。
- `canSubmit=false`、未解决 warning、登录失效、验证码、店铺不一致、结果 `unknown` 时禁止提交或自动重试。
- `confirmToken` 和 `runId` 只用于对应工具，不展示给用户。Preview 成功不等于真实上架成功。
- “透明素材图”是平台素材坑位的业务标签，不代表本地文件必须是 PNG 或含 Alpha 透明像素。JPG 等工具已识别或用户明确映射的本地图片可以进入该坑位，图片内容是否合法由淘宝 / 天猫官方接口校验。
- 遇到 `CATEGORY_REQUIRED_MATERIAL_MISSING` 或 `pic_dict.whiteBgImage` 缺失时，只能说明当前 Workflow 没有把素材映射进必填坑位；除非工具结构化结果明确给出格式错误，否则禁止声称资料包缺少 PNG、要求透明底、要求重新制图，或把“透明素材图”解释为“白色背景商品图”。

## 文件与工具边界

- 禁止用通用 `read/exec` 读取商品目录、CSV/XLSX、类目属性快照或属性 JSON。
- 禁止用通用 `write/edit/exec` 创建草稿、中间 JSON、SKU 矩阵或修改商品素材。
- 商品目录只由 `prepare_start` 的内置扫描读取；SKU 只用 `prepare_sku_source`；主图补白只由 `check_main_images` 内部执行。
- 工具失败必须读取 `phase/stage/code/action/scope`：`phase` 是大步，`stage` 是具体小步，`action` 是唯一下一步，`message` 只用于向用户解释。禁止解析文案猜恢复。
- `action=stop` 时立即报告失败位置并结束；禁止重复当前工具、退回前一步、跳到后一步，或通过修改无关业务输入来刷新 revision/token 绕过错误。
- 失败缺少上述任一定位或分流字段时，按工具协议异常停止，禁止自行补猜。

## 结果边界

- `rejected`：Preview 阶段未真实提交。
- `failed`：已尝试且明确失败。
- `skipped/not_attempted`：未执行。
- `unknown`：平台可能已收到请求，必须人工核验，禁止自动重试。
- 只有提交终态明确成功且返回商品 ID/链接时，才能说“上架成功”。
- `startedAt/finishedAt` 是内部 UTC 时间，只用于状态记录、日志和排障。最终回复禁止展示“上架时间”，禁止展示、换算、截取或重述这两个字段；成功结果只报告平台、商品 ID 和商品链接。
