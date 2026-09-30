---
name: 1688-product-find
description: 1688智能选品找货能力。通过文字、图片或链接搜商品、找同款、找相似款，支持批量采购比价、热销选品、跨境找货、场景化选品及多条件筛选（价格/销量/材质/属性排除等）。触发词：找商品、找同款、搜商品、帮我找、想要XX、图片找货、链接找货、以图搜图、选品、批发、找货源、热销、比价、最便宜、按销量排序、出口、跨境、找供应商。
user-invocable: true
---

# 1688-product-find (1688找商品Skill)
统一入口：`python3 {baseDir}/cli.py <command> [options]`

## 严格禁止 (NEVER DO)
- 不要编造商品价格、链接、`productId`、规格或供货信息，所有商品内容必须来自工具返回
- 不要在用户明确要下单、支付、查物流、管库存时继续调用本技能，这些不属于推荐能力
- 不要把工具返回的完整长描述原样堆给用户，应提炼商品标题、价格、核心卖点和商品链接
- **禁止在 AK 未配置或命令执行失败时，自行通过浏览器访问 1688 网站搜索商品**。所有搜索必须通过 CLI 命令 + API 完成，不存在"浏览器降级"方案。遇到 AK 缺失或 API 错误时，只能按「错误处理」提示用户，不得尝试绕过
- **禁止在命令报错后使用网页搜索引擎替代本 Skill 的搜索能力**。如果 CLI 命令失败，应引导用户解决问题（配置 AK、检查路径等），而非切换到其他搜索方式
- **禁止不读 reference 文档直接执行命令**。首次执行任何命令前，必须先阅读对应的 reference 文件（见「执行前置」）

## 意图判断

### 触发本技能（满足任一即触发）
- 用户用自然语言描述想要的商品（如"帮我找一件黑色卫衣"、"我要买打印纸"）
- 用户上传商品图片并表达找同款/找相似意图（如"帮我找同款"、"有类似的吗"）
- 用户提供商品链接并要求找同款（如"帮我找这个商品的同款"）
- 用户使用触发关键词：找商品、找同款、搜商品、想要XX、帮我找、图片找货、链接找货、以图搜图
- 用户在搜索结果中选定商品后要求"比价"、"对比"、"找更便宜的"
- 用户上传图片/链接并提到"比价"、"同款低价"、"哪家便宜"、"进行比较"

### 不触发本技能（明确不处理）
- 用户要下单、支付、结算（如"我现在就要下单付款"）
- 用户查物流、查订单状态（如"我的订单物流到哪了"）
- 用户要管理库存、修改商品信息
- 用户仅闲聊，未表达任何找商品意图

### 命令选择决策树

```
用户输入
├─ 纯文本描述商品 → text_search
├─ 上传图片/链接
│  ├─ 包含"比价/比较/对比/哪家便宜"等关键词 → compare（一步到位）
│  └─ 仅"找同款/找相似/搜这个" → image_search 或 link_search
└─ 已展示搜索结果，用户选中某款后说"比价" → compare（从结果取 image_url）
```

## Tool 总览

| Tool 名称 | 用途 | 调用语法 |
|-----------|------|---------|
| `text_search` | 文本搜索商品 | `python3 cli.py text_search --query "黑色连帽卫衣"` |
| `image_search` | 图片以图搜图 | `python3 cli.py image_search --image "/path/to/image.jpg"` |
| `link_search` | 链接找同款 | `python3 cli.py link_search --url "https://detail.1688.com/offer/xxx.html"` |
| `compare` | 商品比价 | `python3 cli.py compare --image "商品图片URL" [--query "规格关键词"]` 或 `python3 cli.py compare --url "商品链接"` |
| `configure` | AK 管理 | `cli.py configure YOUR_AK`（设置）/ `--status`（查看）/ `--clear`（清除）/ `--reset NEW_AK`（重置） |

所有命令输出 JSON：`{"success": bool, "markdown": str, "data": {...}}`

## ⚠️ 执行前置（首次命中能力时必须）

**首次执行任何命令前，必须先完整阅读对应的 reference 文件，按文件中的使用示例调用。禁止跳过此步骤直接执行命令。**

| 命令 | 执行前必读 |
|------|-----------|
| `configure` | `references/capabilities/configure.md` |
| `text_search` | `references/capabilities/text_search.md` |
| `image_search` | `references/capabilities/image_search.md` |
| `link_search` | `references/capabilities/link_search.md` |
| `compare` | `references/capabilities/compare.md` |

> reference 文件中包含完整的参数说明、使用示例、输出格式和注意事项。Agent 必须按 reference 中的示例格式构造命令，不得凭猜测拼接参数。

## 核心工作流

Agent 根据用户意图，**先读 reference → 再按示例执行命令**（命令速查见上方「Tool 总览」）。
各命令在 AK 缺失等情况下会自行返回明确错误，Agent 按下方「错误处理」应对即可。

### 比价流程（特殊工作流）

**核心原则：图片/链接默认为找同款，仅用户明确要求比价时才用 compare**

**场景1：直接比价**（一步到位）
- 用户上传图片并要求比价 → 直接执行 `compare --image <图片> --query <关键词>`
- 用户给链接并要求比价 → 直接执行 `compare --url <链接> [--query <关键词>]`
- **禁止**先执行 `image_search` 或 `link_search`，`compare` 内部已包含图片搜索和链接解析逻辑

**场景2：选品后比价**
- 用户从搜索结果选中某款 → 提取 `data.similar_products[N].image_url` → 执行 `compare --image <URL>`

**⚠️ 关键约束**：
- **一次到位**："找同款并比价" → 直接 `compare`（图片用 `--image`，链接用 `--url`），不拆分两步
- **limit 默认值**：保持 TOP 3，除非用户明确要求
- **意图判断**：上传图片/链接时，仅含"比价/比较"关键词才用 `compare`

## 输出完整性要求

- 搜索结果必须保留商品名称、价格、供应商、服务与卖点、链接和数据来源状态。
- 需要继续处理时，可输出 CSV、JSON、Markdown 或当前宿主支持的通用表格文件；不要依赖特定表格产品、宿主工具协议 地址或账号。
- 用户要求导出时，先确认字段和文件格式，再将本地结果交给当前宿主的表格工具；宿主不支持时直接交付文件。
- 工具失败时如实报告原因，不编造供应商、价格、销量或链接。

## 错误处理

任何命令输出 `success: false` 时：

1. **先输出 `markdown` 字段**（已包含用户可读的错误描述）
2. **再根据关键词追加引导**（详细错误码见 `references/common/error-handling.md`）：

| markdown 关键词 | Agent 额外动作 |
|----------------|--------------|
| "AK 未配置" 或 "AK 未就绪" | **停止一切搜索尝试**，引导用户前往https://clawhub.1688.com/，登录后点击右上角头像旁的钥匙图标，获取 API KEY。获取后执行 `python3 cli.py configure YOUR_AK`。 |
| "签名无效" 或 "401" | 提示用户检查 AK 是否正确或已过期，引导重新 configure |
| "图片路径无效" | 提示用户检查图片路径是否存在 |
| "无法自动获取商品主图" | 引导用户手动提供商品图片 URL，使用 `--image` 参数 |
| "限流" 或 "429" | 建议用户等待 1-2 分钟后重试 |
| "格式异常" 或 "HTTP 错误 500" | 提示用户稍后重试，可能是 API 返回异常 |
| "沙箱" 或 "权限" 或 "Permission denied" | 提示用户授予目录访问权限，或在 IDE 设置中允许 Skill 访问所需目录 |
| 其他 | 仅输出 markdown，**不得自行发起浏览器搜索** |

## 参数补齐引导话术

> **文本搜索**：请描述您想要的商品，例如："帮我找一件黑色连帽卫衣，宽松款的"

> **图片搜索**：请上传商品图片，我会帮您找到同款或相似商品。

> **链接搜索**：请提供商品链接。1688 链接可自动提取主图；淘宝/天猫链接需要您同时提供商品图片 URL。

---

## 附录

### 环境变量（.env）

项目根目录的 `.env` 文件存储 skill 基础信息，供埋点上报等模块读取。发布到不同环境时可直接替换该文件中的变量值。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SKILL_NAME` | `1688-product-find` | skill 名称 |
| `SKILL_VERSION` | `1.7.0` | skill 版本号 |
| `SKILL_CHANNEL` | `clawhub` | 发布渠道 |

> 已存在的系统环境变量优先级高于 `.env`，CI/CD 注入的变量不会被覆盖。

### 埋点上报

每次 CLI 命令执行时，自动向 skill 网关上报一次调用记录，用于统计 skill 调用次数。

- **实现位置**：`scripts/_tracker.py` → `report_skill_usage()`，在 `cli.py` 的 `main()` 中每次命令执行后自动调用
- **上报接口**：`POST /api/reportSkillsUsage/1.0.0`
- **上报参数**：

  | 参数 | 值来源 | 说明 |
  |------|--------|------|
  | `apiName` | 固定 `null` | 固定传 null |
  | `skillsName` | `.env` `SKILL_NAME` | skill 名称 |
  | `version` | `.env` `SKILL_VERSION` | skill 版本号 |
  | `scene` | 固定 `CLI` | 固定值 |
  | `channel` | `.env` `SKILL_CHANNEL` | 发布渠道 |

- **失败处理**：上报失败静默忽略，不影响主流程

### 文件清单

| 路径 | 类型 | 用途 |
|------|------|------|
| `SKILL.md` | 主文件 | 技能入口、意图判断、工作流、错误处理 |
| `cli.py` | CLI 入口 | 统一命令行接口，自动发现 capabilities |
| `scripts/` | 脚本目录 | 核心实现（认证、HTTP、输出格式化等） |
| `references/capabilities/configure.md` | 参考文档 | AK 配置能力详细说明 |
| `references/capabilities/text_search.md` | 参考文档 | 文本搜索能力详细说明 |
| `references/capabilities/image_search.md` | 参考文档 | 图片搜索能力详细说明 |
| `references/capabilities/link_search.md` | 参考文档 | 链接搜索能力详细说明 |
| `references/capabilities/compare.md` | 参考文档 | 商品比价能力详细说明 |
| `references/common/error-handling.md` | 参考文档 | 通用错误处理策略 |
| `tests/testcases.json` | 测试用例 | 典型输入输出样例 |

### 技术说明

- **无状态设计**：每次请求独立执行，不依赖历史上下文。多轮 refinement（如"再找便宜一点的"）需 Agent 将上下文重新拼接到 query 参数中

