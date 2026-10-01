---
name: amz-hot-keywords
description: 亚马逊多站点热搜词抓取与分析技能 - 支持美国、法国、墨西哥、英国、德国、意大利、西班牙、加拿大、日本共 9 个站点。支持按产品关键词搜索亚马逊热搜词（如搜索"艾草锤""dog bed"等任意产品词），从 AMZ123 抓取与该关键词相关的热搜词列表及排名数据（搜索词、本周排名、上周排名、涨跌幅度），通过 `?k=关键词` 路径搜索，每页最多 200 条结果。默认美国站，美国站找不到数据时自动遍历其他 8 个站点。默认 CSV 本地管理。适用场景：跨境电商选品调研、亚马逊关键词分析、竞品热搜词监控。
user-invocable: true
---

# 亚马逊热搜词抓取与关键词分析技能

从 AMZ123 抓取**亚马逊热搜词**数据，**支持 9 个站点**：美国、法国、墨西哥、英国、德国、意大利、西班牙、加拿大、日本。**核心能力：支持按任意产品关键词搜索**，返回与该关键词相关的热搜词列表及排名变化（最多 200 条）。

典型用法：
- "帮我抓取亚马逊热搜词，搜索'艾草锤'相关的热搜词数据"
- "查看 dog bed 相关的亚马逊热搜词排名"
- "帮我搜一下 yoga mat 在亚马逊的热搜关键词"
- "查一下亚马逊日本站 dog bed 的热搜词"
- "抓取亚马逊德国站的热搜数据，关键词是 hundebett"
- "帮我搜亚马逊法国站 lit pour chien 的热搜词，**写入AI表格**"

存储方式：
- **CSV 模式**（默认）：直接保存到本地 CSV 文件，无需任何外部服务


---

## 触发 / 不触发规则

### ✅ 应触发本技能

- 用户要求查询 / 抓取 / 搜索**亚马逊**热搜词、热搜关键词、搜索词排名
- 用户提供了一个产品关键词（中文或英文），希望了解该词在亚马逊的热搜表现
- 用户指定了亚马逊某个站点（美国/法国/墨西哥/英国/德国/意大利/西班牙/加拿大/日本）
- 用户未指定站点 → 默认美国站
- 用户明确提到 AMZ123 作为数据源
- 示例："帮我查一下 dog bed 的亚马逊热搜词" / "抓取艾草锤相关的热搜数据" / "yoga mat 在亚马逊搜索排名怎么样" / "查亚马逊日本站 dog bed 热搜" / "帮我抓亚马逊德国站热搜词写入AI表格"

### ❌ 不应触发本技能

- **非亚马逊平台**：淘宝、京东、拼多多、eBay、Shopee、速卖通等其他电商平台的热搜词 → 本技能仅支持亚马逊
- **不支持的站点**：亚马逊印度站、澳洲站、巴西站等不在 9 站列表中的站点 → 告知用户当前不支持
- **泛化爬虫需求**：用户要求爬取任意网页、抓取非 AMZ123 的数据 → 不属于本技能范围
- **非关键词分析场景**：商品详情抓取、价格监控、店铺分析、评论采集 → 本技能仅提供热搜关键词排名数据
- **通用搜索引擎**：Google Trends、百度指数等搜索趋势 → 不属于本技能范围
- **纯数据分析**：用户已有数据，仅需分析/可视化，不需要抓取 → 不需要本技能

---

## 支持站点映射表

| 站点 | 用户可能的说法 | AMZ123 URL 路径前缀 | 默认 |
|------|--------------|---------------------|------|
| 美国 | 美国站、US、usa、美亚、亚马逊（未指定站点时） | `usatopkeywords` | ✅ |
| 法国 | 法国站、FR、france | `frtopkeywords` | |
| 墨西哥 | 墨西哥站、MX、mexico | `mxtopkeywords` | |
| 英国 | 英国站、UK、GB、britain | `uktopkeywords` | |
| 德国 | 德国站、DE、germany | `detopkeywords` | |
| 意大利 | 意大利站、IT、italy | `ittopkeywords` | |
| 西班牙 | 西班牙站、ES、spain | `esptopkeywords` | |
| 加拿大 | 加拿大站、CA、canada | `catopkeywords` | |
| 日本 | 日本站、JP、japan、亚马逊日本 | `jptopkeywords` | |

> 助手根据用户消息中的站点关键词匹配上表，确定 URL 路径前缀。未指定站点时默认美国站（`usatopkeywords`）。

---
## 强约束与安全守卫

> **状态策略声明**：本技能为**无状态技能**。技能自身不持久化任何会话上下文、表格 ID 或中间结果。每次执行都是独立的完整流程——输入关键词，输出数据文件。

以下规则为硬约束，任何情况下不可违反：

### 关键词确认

- **必须有明确关键词才能执行**。如果用户未提供关键词，必须先询问，禁止使用默认值或自行猜测
- 如果用户消息中已包含关键词（如"搜索'艾草锤'相关的"），直接使用，无需重复确认
- **中文关键词翻译（按站点语言）**：如果用户提供的关键词是中文（如"连衣裙""艾草锤"），**必须根据所选站点将中文翻译为对应语言**后再用于搜索。AMZ123 各站点热搜词数据库使用对应本地语言，中文词直接搜索会返回空结果。翻译后向用户说明实际使用的搜索词。
  - 美国站 / 英国站 / 加拿大站 → 英文
  - 日本站 → 日文
  - 德国站 → 德文
  - 法国站 → 法文
  - 意大利站 → 意大利文
  - 西班牙站 / 墨西哥站 → 西班牙文
  - 示例：用户输入"连衣裙" + 美国站 → 翻译为"dress" → 告知用户"已使用英文词 'dress' 在美国站搜索"
  - 示例：用户输入"连衣裙" + 日本站 → 翻译为"ワンピース" → 告知用户"已使用日文词 'ワンピース' 在日本站搜索"


### 站点判断

- 用户指定了站点 → 使用对应站点（参见「支持站点映射表」）
- 用户未指定站点 → **默认美国站**（`usatopkeywords`）
- **Fallback 逻辑（数据为空）**：如果指定站点（含默认美国站）搜索结果为空，**自动遍历其他 8 个站点**，找到数据即返回，并告知用户数据实际来自哪个站点
- 用户指定了不支持的站点 → 告知用户当前仅支持 9 个站点，列出可选站点

### 多站点数据补足（条数不足时跨站采集）

> 当用户明确指定了**最低数据条数**要求时（如"至少50条""不少于100条""要50条以上"），触发此规则。

**触发条件**：用户消息中包含明确的最低条数要求（如"至少 N 条""不少于 N 条""要 N 条以上""必须 N 条""给我 N 条数据"等）。

**执行逻辑**：
1. 先从首选站点（用户指定或默认美国站）抓取数据
2. 如果该站点返回的数据条数 **≥ 用户要求的最低条数** → 正常结束，无需跨站
3. 如果该站点返回的数据条数 **< 用户要求的最低条数** → 继续按以下固定顺序遍历剩余站点：
   - 美国 → 英国 → 德国 → 法国 → 西班牙 → 意大利 → 加拿大 → 墨西哥 → 日本
   - 跳过已经抓取过的站点
4. 每抓完一个站点，将新数据**追加合并**到已有数据中（去重：以搜索词为唯一键，同一搜索词只保留首次出现的记录）
5. 合并后总条数 **≥ 用户要求的最低条数** → **立即停止**，不再继续遍历
6. 所有 9 个站点都遍历完仍不够 → 如实告知用户实际获取到的总条数，说明已遍历所有站点

**数据标注**：多站点合并的数据中，每条记录需标注来源站点（如"US""UK""DE"），方便用户区分。如果只有单站点数据则无需标注。

**向用户报告**：
- 最终数据总条数
- 数据来源站点列表（如"数据来自美国站(35条) + 英国站(20条)，共55条"）
- 如果遍历了多个站点才凑够，需明确说明

> ⚠️ 此规则与现有 Fallback 逻辑**互不冲突**：Fallback 处理的是"数据为空"的场景，本规则处理的是"数据有但不够"的场景。两者可叠加——如果首选站点为空触发 Fallback 找到了数据，但条数仍不够，继续触发本规则。

### 数据真实性

- **禁止模拟数据**。所有排名数据必须来自 AMZ123 真实页面抓取，禁止编造、估算或使用示例数据冒充真实结果
- 如果抓取失败或返回空数据，必须如实告知用户，不得用虚构数据填充


### 平台边界

- 支持亚马逊 9 个站点：美国、法国、墨西哥、英国、德国、意大利、西班牙、加拿大、日本（数据源 AMZ123）
- 不支持上述 9 站以外的亚马逊站点（如印度站、澳洲站、巴西站等）
- 不得将本技能用于非亚马逊平台
- 不得承诺本技能不具备的能力（如价格监控、评论采集等）


## 前置条件

- Python 3.9+
- **Playwright（首选引擎）**：`playwright>=1.40.0`（通过 `requirements.txt` 管理）+ Chromium 浏览器（`playwright install chromium`）
- **browser_use（降级引擎）**：当 Playwright 不可用时，自动降级到悟空内置 browser_use 工具，无需额外依赖

> 本技能支持双引擎模式：**优先使用 Playwright headless**（速度快、无 UI 弹窗），当 Playwright 不可用（未安装、浏览器启动失败等）时自动降级到 browser_use。数据处理脚本仅使用 Python 标准库（json、csv）。

---

## 输出契约

本技能的最终交付物因存储模式而异，以下为两种模式的结构化定义：

### CSV 模式交付物

| 交付项 | 格式 | 路径 | 说明 |
|--------|------|------|------|
| 热搜词 CSV 文件 | `.csv` | `scripts/data/{keyword}_keywords_{YYYYMMDD}.csv` | 主交付物，含搜索词、本周排名、上周排名、涨跌幅度（多站点合并时额外含来源站点列） |
| 格式化 JSON 备份 | `.json` | `scripts/data/{keyword}_data_{YYYYMMDD}.json` | 结构化备份，与 CSV 内容一致 |
| 执行摘要（文本） | 控制台 + 助手回复 | — | 数据条数、前 5 条预览、CSV 文件路径 |


> 📖 详细数据字段定义和格式说明见 `references/DATA_FORMAT.md`。

---
## 工作流程总览

```
Step 1: 确认用户的搜索关键词 + 判断站点 + 判断存储模式
    ↓
Step 2: 检测 Playwright 可用性（优先 Playwright，不可用则降级 browser_use）
    ↓
Step 3 [Playwright]:  直接执行脚本（脚本自行启动 headless 浏览器抓取）
Step 3 [browser_use]: 助手用 browser_use 打开 AMZ123 → JS 提取数据 → closeTab
    ↓
Step 4: 数据处理与保存（计算涨跌、保存 CSV 或 JSON）
    ↓
Step 5 [CSV 模式]: 脚本保存 CSV 文件 → 向用户报告结果 → 完成

```

---

## Step 1: 确认关键词、站点和存储模式

**助手必须在执行前确认用户的搜索关键词。** 如果用户消息中已包含关键词，直接使用。

> 如果用户未指定关键词，则询问：
> 请提供你要搜索的亚马逊产品关键词（如 "dog bed"、"艾草锤"）。

**站点判断规则（不询问用户）：**
- 用户指定了站点 → 使用对应站点的 URL 路径前缀（参见「支持站点映射表」）
- 用户未指定站点 → 默认美国站（`usatopkeywords`）
- **脚本内置 fallback**：如果指定站点无数据，脚本会自动遍历其他站点，无需助手额外处理


**最低条数要求识别（不询问用户）：**
- 用户消息中包含明确的条数要求（如"至少50条""不少于100条""要50条以上""给我80条数据"） → 记录为 `min_count`，后续步骤中如果单站点数据不足 `min_count` 则触发多站点数据补足（见「强约束 → 多站点数据补足」）
- 用户未指定条数要求 → 不触发多站点补足，按正常单站点 + Fallback 逻辑执行

---

## Step 2: 检测 Playwright 可用性，选择抓取引擎

助手**优先使用 Playwright 引擎**。通过 `execute_shell` 执行以下检测命令，**必须设置 `timeout=10`**（10 秒超时）：

```bash
python3 -c "from playwright.sync_api import sync_playwright; pw=sync_playwright().start(); b=pw.chromium.launch(headless=True); b.close(); pw.stop(); print('PLAYWRIGHT_OK')" 2>&1
```

> ⚠️ **超时控制方式**：不要在 shell 命令中使用 `timeout` 命令（macOS 不自带），而是通过 `execute_shell` 的 `timeout=10` 参数控制。命令 10 秒内未完成会被自动终止。

| 检测结果 | 引擎 | 说明 |
|----------|------|------|
| **10 秒内**输出含 `PLAYWRIGHT_OK` | **Playwright** | Playwright 已安装且浏览器可正常启动，使用 Playwright headless 引擎 |
| 超时（execute_shell 返回超时错误）或任何报错 | **browser_use** | 自动降级到悟空内置 browser_use 工具 |

> ⚠️ **不再根据沙箱/非沙箱环境判断引擎**。即使在沙箱环境中，只要 Playwright 可用就优先使用。检测超过 10 秒视为不可用，直接降级。

---

## Step 3 [Playwright 引擎]: 直接执行脚本抓取

> Playwright 检测通过时使用此流程。脚本自行启动 Playwright headless 浏览器完成抓取。

### 命令

```bash
cd <skill_directory>/scripts

# CSV 模式（默认，美国站）
python3 amz123_enhanced_scraper_v2.py --keyword "<用户关键词>" --storage csv

# 指定站点（如日本站）
python3 amz123_enhanced_scraper_v2.py --keyword "<用户关键词>" --site jp

# 显式指定引擎和 headless 模式
python3 amz123_enhanced_scraper_v2.py --keyword "<用户关键词>" --engine playwright --headless true
```

> `--site` 参数值为站点代码：`us`（默认）、`jp`、`de`、`fr`、`mx`、`uk`、`it`、`es`、`ca`。指定站点无数据时脚本自动遍历其他站点。

脚本会自动启动 Playwright Chromium（默认 headless），访问 AMZ123 对应站点搜索页，提取数据并保存。无需助手额外操作浏览器。

### 多站点数据补足（Playwright）

当用户指定了最低条数要求且首站数据不足时，助手需**重复执行脚本**，每次传入不同的 `--site` 参数：

```bash
# 首站（如美国站）返回了 35 条，用户要求至少 50 条
# 继续抓取英国站
python3 amz123_enhanced_scraper_v2.py --keyword "<用户关键词>" --site uk --storage csv
# 合并后 35+20=55 条 ≥ 50 → 停止
```

助手负责在每站抓取后**累计条数判断**是否达标，达标即停。最终将多站点数据合并输出（去重后）。

---

## Step 3 [browser_use 引擎]: 用 browser_use 打开 AMZ123 并提取数据

> Playwright 不可用时降级到此流程。

此步骤由助手直接执行，使用悟空内置的 browser_use 工具操作浏览器。

### 3.1 打开搜索页

根据用户指定的站点（默认美国站），构造对应 URL：

```
browser_use(action="openTab", url="https://www.amz123.com/{site_prefix}?k={encoded_keyword}")
```

- `{site_prefix}` 从「支持站点映射表」查找，如美国站 → `usatopkeywords`，日本站 → `jptopkeywords`
- `{encoded_keyword}` 需要 URL 编码（中文关键词如 "艾草锤" → `%E8%89%BE%E8%8D%89%E9%94%A4`）
- `?k=` 是搜索参数

### 3.2 等待页面加载

```
browser_use(action="waitFor", targetId=<当前页面>, timeMs=5000)
```

等待 5 秒确保 SPA 页面渲染完成。

### 3.3 执行 JS 提取热搜词数据

```
browser_use(action="evaluate", targetId=<当前页面>, fn=`() => {
  const items = Array.from(document.querySelectorAll('.table-body-item'));
  return items.slice(0, 200).map(item => {
    const wordElem = item.querySelector('.table-body-item-words-word');
    const word = wordElem ? wordElem.textContent.trim() : '';
    const rankContainer = item.querySelector('.table-body-item-rank');
    let currentRank = 0;
    let lastRank = 0;
    if (rankContainer) {
      const spans = rankContainer.querySelectorAll('span');
      if (spans.length >= 2) {
        const currentText = spans[0].textContent.trim();
        const lastText = spans[1].textContent.trim();
        currentRank = /^\d+$/.test(currentText) ? parseInt(currentText) : 0;
        lastRank = /^\d+$/.test(lastText) ? parseInt(lastText) : 0;
      }
    }
    return { word, currentRank, lastRank };
  });
}`)
```

**返回值**：JSON 数组，每项包含 `{ word, currentRank, lastRank }`。

### 3.4 数据为空时的重试

如果 evaluate 返回空数组，可能是页面尚未完全渲染：

```
browser_use(action="scroll", targetId=<当前页面>, x=0, y=2000)
browser_use(action="waitFor", targetId=<当前页面>, timeMs=3000)
```

然后重新执行 3.3 的 evaluate。仍然为空则告知用户抓取失败。

### 3.5 多站点数据补足（browser_use）

当用户指定了最低条数要求且当前站点数据不足时：

1. **先关闭当前标签页**（`closeTab`）
2. 记录当前站点已获取的数据条数
3. 按固定站点顺序（美国→英国→德国→法国→西班牙→意大利→加拿大→墨西哥→日本），打开下一个未访问过的站点
4. 重复 3.1 ~ 3.3 的流程，提取数据后追加合并
5. 合并后总条数 ≥ 用户要求 → 停止；否则继续下一站点
6. 每个站点操作完成后都必须 `closeTab`

### 3.6 关闭浏览器标签页

数据提取完成后（无论成功或失败），**必须关闭浏览器标签页**，释放资源：

```
browser_use(action="closeTab", targetId=<当前页面>)
```

> ⚠️ 这是强制步骤。即使数据提取失败或为空，也必须执行关闭操作，避免浏览器标签页残留。

---
## Step 4: 数据处理与保存

### browser_use 引擎

助手将 Step 3 提取的原始 JSON 数据保存为临时文件，然后调用数据处理脚本计算涨跌幅度并保存最终结果。

```bash
# 1. 先将 browser_use 提取的原始数据保存为 JSON 文件
#    助手用 create_file 将 evaluate 返回的 JSON 数组写入：
#    <skill_directory>/scripts/data/raw_<keyword>_<timestamp>.json

# 2. 调用数据处理脚本
cd <skill_directory>/scripts

# CSV 模式
python3 amz123_enhanced_scraper_v2.py --keyword "<用户关键词>" --input data/raw_<keyword>_<timestamp>.json --storage csv

### Playwright 引擎

Playwright 模式下脚本已在 Step 3 中完成了抓取 + 数据处理 + 保存的全流程，无需额外步骤。

### 参数说明

| 参数 | 说明 | 必填 | 示例 |
|------|------|------|------|
| `--keyword` | 搜索关键词 | ✅ 是 | `--keyword "dog bed"` |
| `--input` | 原始数据 JSON 文件路径（browser_use 模式） | browser_use 模式必填 | `--input data/raw_dog_bed.json` |
| `--site` | 站点代码（us/fr/mx/uk/de/it/es/ca/jp） | ❌ 否（默认 us） | `--site jp` |
| `--engine` | 强制指定引擎（browser_use / playwright） | ❌ 否（自动判断） | `--engine playwright` |
| `--storage` | 存储模式 | ❌ 否（默认 csv） | 
| `--headless` | Playwright 无头模式 | ❌ 否（默认 true） | `--headless false` |
| `--csv-dir` | CSV 保存目录 | ❌ 否 | `--csv-dir /path/to/dir` |

---

## Step 5: CSV 模式 — 完成

CSV 模式下脚本直接完成数据保存，无需额外操作。向用户报告保存的 CSV 文件路径、数据条数和前几条数据预览。

---

## 参考文件清单

以下文件包含详细的操作指南、数据格式和故障排查信息。**助手在正常执行流程中无需主动读取这些文件**，仅在遇到对应场景时按需查阅：

| 文件 | 内容 | 何时读取 |
|------|------|---------|
| `references/DATA_FORMAT.md` | 数据格式规范：原始数据结构、格式化字段说明、涨跌幅度计算规则、CSV 输出格式、AI 表格字段映射 | 需要确认数据格式或排查数据异常时 |
| `references/TROUBLESHOOTING.md` | 故障排查：抓取为空、宿主表格工具 写入失败、涨跌幅度错误、搜索结果不足、URL 参数历史问题 | 执行过程中遇到错误时 |
| `references/ENHANCED_SCRAPER_README.md` | 增强版爬虫技术细节：Selenium 提取逻辑、性能优化、批量写入实现 | 需要了解爬虫内部实现时 |
| `references/QUICK_START.md` | 快速开始指南（含旧版外部工具配置方式，仅供参考） | 一般不需要，本地 CSV/JSON 模式已取代旧流程 |
