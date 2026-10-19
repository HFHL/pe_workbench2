# 参考代码评估：文档解析 / 查询系统能否用在当前 Workbench

> 评估对象：[pe-workbench-document-system-2026-10-19.zip](/Users/Admin/project/PE-Workbench/pe-workbench-document-system-2026-10-19.zip)
> 当前系统：`pe_workbench2`（[server.mjs](../server.mjs)、[store.mjs](../store.mjs)、SQLite + Pi Agent）
> 结论日期：2026-10-19
> 后续：A 方案已落地，实现与验收见 [workbook-query.md](workbook-query.md)。

## 结论

**能用，但只能复用「思路和解析器」，不能直接合并代码。**

参考实现的主干是对的：

1. **一次解析，多次查询**：上传时把 Excel 变成结构化数据，而不是每次让模型读整份文件。
2. **返回子图，不返回整表**：按问题只给相关单元格、公式、上下游，控制上下文。
3. **Excel 按公式图理解**：公式、依赖、行列标签、复杂度，比"抽文本"更接近投研模型的真实结构。

但这套代码是**半成品**，直接搬到当前系统会踩四个硬坑：

- 在真实模型上第一次解析就崩溃（datetime 不能 JSON 序列化）。
- 依赖图丢一半：范围引用只连两个端点，被引用的输入单元格不进图。
- 中文查询基本失效：「收入」「毛利」被 `length > 2` 过滤掉，还会静默返回无关单元格。
- 缓存只在内存 Map 里：服务一重启，列表和详情全空；60 MB 的 JSON 也不适合常驻。

所以建议：**保留解析器和"子图检索"的产品思路，按当前系统的 blob / SQLite / Pi 架构重写接入层。**

---

## 1. 参考代码做了什么

数据流：

```
POST /api/documents/upload
  → 存临时文件
  → DocumentStoreManager.loadOrCreate(path)
  → fileId = sha256(path + mtime).slice(0, 16)
  → 命中 ~/.pi/document-cache/<fileId>.json 就直接读
  → 否则 spawn python3 services/document-parser/parse_*.py
  → JSON 写入缓存 + 放进内存 Map

POST /api/documents/[fileId]/query { query }
  → queryExcel / queryPdf / queryText
  → 关键词打分 → BFS 扩展上下游 → 返回子图 / 片段
```

| 文件 | 职责 | 评价 |
|---|---|---|
| `app/api/documents/**` | Next.js 路由：列表、上传、详情、查询 | 逻辑可借鉴，框架不可直接搬 |
| `lib/document-store.ts` | 文件类型分派、Python 调用、缓存 | 结构清楚，但有 ESM / 类型 / 冷启动问题 |
| `lib/document-query.ts` | Excel / PDF / Text 三种检索 | 思路对，检索质量是原型级 |
| `services/document-parser/parse_excel.py` | 公式图、依赖边、行列标签、复杂度 | 最有价值的部分，但有关键缺陷 |
| `services/document-parser/parse_pdf.py` | pdfplumber 文本 + 表格，PyPDF2 兜底 | 可复用，补 OCR / 分块即可 |
| `services/document-parser/parse_text.py` | 编码检测、分块、键值对、URL/邮箱 | 当前系统 Agent 已有 `read`，优先级低 |

值得保留的三个设计：

1. **解析结果按内容缓存**，查询不重复解析。
2. **Excel 的查询单位是单元格 + 依赖边**，不是段落。
3. **返回结果有上限**（`maxCells` / `maxSnippets` / `maxChunks`），避免把整份文档塞进上下文。

---

## 2. 在真实模型上的实测

测试文件就是当前工作区里的两份上传件：

- `agent-workspace/uploads/1792381355072-…_Horizon-Robotics_9660.HK_2025_Aug_06.xlsx`：227 KB，8 个 sheet，5,148 个公式。
- `agent-workspace/uploads/1792381279372-…_HERMES-INTERNATIONAL_HRMS.PA_2025_Jun_30-copy.xlsm`：4.9 MB，36 个 sheet，62,862 个公式。

### 2.1 原版解析器

| 指标 | Horizon | Hermes |
|---|---|---|
| 首次运行 | **崩溃**：`Object of type datetime is not JSON serializable` | **崩溃**：`Object of type ArrayFormula is not JSON serializable` |
| 打补丁后耗时 | 0.41 s | 5.49 s |
| 输出 JSON | 4.7 MB | **60 MB** |
| 峰值内存 | ~90 MB | **~690 MB** |
| 公式数 | 5,148 | 62,862 |
| 依赖引用总数 | 10,089 | 122,142 |
| 真正成为边的 | 5,030（**49.9%**） | 80,201（**65.7%**） |
| 指向非公式单元格、被丢弃的引用 | **5,059** | **41,941** |
| 含范围引用的公式 | 700 | 756 |
| `colHeader` 实际是公式（以 `=` 开头） | 2,231 / 5,148（**43%**） | 12,070 / 62,862（19%） |

崩溃点在 `parse_excel.py:284`：`json.dumps(result, ...)` 没有 `default=`。Horizon 的日期单元格和 Hermes 的 `ArrayFormula` 都会让整个解析失败。这不是边角情况——投研模型里日期列和数组公式都很常见。

### 2.2 图完整性：为什么"丢一半"

`parse_excel.py` 有两个结构性缺陷：

**范围引用只连端点**（`parse_excel.py:36-42`）：

```python
# =SUM(B4:B10)
if ':' in cell:
    start, end = cell.split(':')
    refs.add(f"{sheet}!{start}")
    refs.add(f"{sheet}!{end}")
```

结果 `SUM(B4:B10)` 只依赖 `B4` 和 `B10`，中间的 `B5…B9` 全部丢失。DCF、FCF、利润表汇总大量使用范围求和，**图在聚合方向上正好是断的**。

**输入节点不进图**（`parse_excel.py:191-201`）：

```python
for dep in info['dependencies']:
    if dep in formula_graph:      # 只有"公式单元格"才连边
        formula_graph[dep]['dependents'].append(cell_id)
```

被公式引用的原始输入（假设、价格、销量）本身没有公式，于是不会成为节点，也不会产生边。Horizon 有一半引用属于这种情况。对 PE 场景来说，这恰好丢掉了最有价值的问题：**"这个数是从哪来的？"**

**表头取到公式**（`parse_excel.py:52-56`）：

```python
for row_offset in range(1, min(6, cell.row)):
    header_cell = sheet.cell(row_offset, col_idx)
    if header_cell.value and isinstance(header_cell.value, str):
        context['colHeader'] = str(header_cell.value).strip()
        break
```

它只看"上方第一个字符串"，不判断是不是表头。Horizon 里 `IS!B28` 的 `colHeader` 是 `=B3+B2`，`DCF!E5` 是 `=D1+1`。年份列一旦标错，"2026 收入"这类查询就不可能准。

### 2.3 查询质量

`document-query.ts:83`：

```ts
const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2)
```

中文没有空格，两个字的中文词全部被过滤：「收入」「毛利」「净利」「估值」「负债」→ `keywords = []`。

更糟的是 `document-query.ts:142-163`：即使没有任何文本命中，也会因为"终端节点 +5、复杂公式 +2"得到正的 `score`，于是 `matches.length === 0` 的兜底分支根本不触发，直接返回一批无关的终端单元格。

实际跑出来的结果：

| 查询 | 原版返回 | 应该返回 |
|---|---|---|
| `收入` | `Total D&A`（总分部的折旧摊销） | `Revenue` / `Total revenue` 行 |
| `毛利率` | `Total D&A` | `Gross margin` 行 |
| `DCF WACC` | `IS!K42 Diff`（因为 `colHeader` 是 `=Operation!L28`，命中了 `dcf`） | `DCF!D58 WACC` |
| `2026 收入` | 丢掉「收入」，只剩 `2026`，返回随机行 | 2026 年收入单元格 |

### 2.4 缓存与冷启动

- `lib/document-store.ts:184`：唯一数据源是 `private contexts = new Map()`。
- `list()` / `get()` 只读这个 Map（`:235-242`）。
- 磁盘上的 `~/.pi/document-cache/*.json` 只在 `loadOrCreate` 时读，**服务重启后不会恢复**。
- README 自己也把这条列为已知问题 #1：重启后详情和查询接口 404，需要重新上传。
- fileId 用 `sha256(path + mtime)`，而上传每次都写到新的临时文件名，**同一份内容重复上传不会命中缓存**。
- 60 MB 的 `JSON.stringify(context, null, 2)` 直接落盘，读回时又是一次大对象分配。

另外 `lib/document-store.ts:325` 用了 `__dirname`（ESM 下不存在），`delete()` 里用了 `require('fs')`，与当前仓库的 ESM / lint 规则冲突。

### 2.5 上传接口

- `app/api/documents/upload/route.ts:23` 允许 `.xls`，但 openpyxl 读不了旧版 `.xls`，会在解析阶段失败。
- 上传请求里同步解析：Hermes 要等 5.5 秒才返回，当前系统的上传是毫秒级，直接套会明显变慢。

---

## 3. 为什么这些缺陷对 PE 场景是致命的

投研模型不是"文档"，是**一张有方向的依赖图**：

1. **聚合链**：`EBITDA → 经营现金流 → FCF → DCF → 估值`。范围引用只连端点，等于把链锯断。
2. **输入追溯**：每个预测数字背后都有假设（销量、ASP、毛利率、税率、WACC）。输入节点不进图，就无法回答"这个数从哪来、改哪个假设会影响它"。
3. **时间维度**：PE 模型几乎每个问题都带年份（"2026 收入"、"2029 FCF"）。表头取到公式，年份维度直接失效。
4. **中文提问**：用户不会用英文说 "gross margin"，两个字的中文词必须能查。
5. **规模**：4.9 MB 的模型就 60 MB JSON / 690 MB 内存，再大一点（10 MB+、100+ sheet）会拖垮单进程服务。

---

## 4. 映射到当前系统

当前系统已经有比参考实现更好的底座：

- [store.mjs](../store.mjs) 用 blobs（sha256 内容寻址）+ `material_versions` 管版本。
- [docs/storage-decision.md](storage-decision.md) 已经定了"元数据进 SQLite、字节进文件系统"。
- [docs/foundation.md](foundation.md) 有上传、版本、恢复、计划、SSE。
- [docs/pi-harness-integration.md](pi-harness-integration.md) 已经写明 `customTools: ToolDefinition[]` 可以给 Agent 加工具。

所以落点不是 Next.js 路由，而是三件事：

### 4.1 存储：用 blob sha 做解析缓存 key

```
data/
├── workbench.db                 # 新增 document_parses 元数据
└── doc-cache/
    ├── <sha256>.json.gz         # 解析结果（Hermes 2.0 MB gzip）
    └── <sha256>.error.json      # 失败原因，避免反复重试
```

```sql
create table if not exists document_parses (
  blob_sha256 text primary key,
  file_name text not null,
  file_type text not null,          -- excel | pdf | text
  parser_version integer not null,
  status text not null,             -- ready | running | failed
  stats_json text,
  error text,
  parsed_at text not null
);
```

为什么用 blob sha，而不是参考实现的 `path + mtime`：

- 同一个文件多个版本、多个资料路径 → 只解析一次。
- 内容不变 → 缓存永远有效；内容变了 → sha 变了，自然失效。
- 配合 `material_versions.blob_sha256`，查询时从 material id 直接定位到解析结果。
- 服务重启后，`document_parses` 还在，列表和查询不会 404。

第一版不必把 62k 个单元格拆成 SQLite 表：gzip JSON 2 MB，加载 + 查询 0.2 秒，足够单用户使用。
等到需要跨文档搜索、FTS、或多人并发时，再升级成 `doc_cells` / `doc_edges` 表。

### 4.2 接入：Pi 自定义工具，而不是让模型读二进制

当前 [server.mjs](../server.mjs) 创建会话时只开了内置工具：

```js
tools: ["read", "write", "edit", "grep", "find", "ls"]
```

xlsx / pdf 对 `read` 是二进制，Agent 只能写 `bash + python` 临时代码，既慢又不稳定。加一个自定义工具：

```js
{
  name: "workbook_query",
  description: "查询工作区里的 Excel 模型：按中文/英文关键词或 Sheet!A1 返回相关单元格、公式、值和上下游依赖。",
  parameters: Type.Object({
    path: Type.String(),
    query: Type.String(),
    maxCells: Type.Optional(Type.Number())
  }),
  execute: async ({ path, query, maxCells }) => {
    // 1. 校验 path 在工作空间内
    // 2. 从 materials/material_versions 找到最新 blob sha
    // 3. loadOrParseGraph(sha) → queryGraph(...)
    // 4. 返回 Markdown 表格 + 单元格引用 + 缓存值提示
  }
}
```

工具返回样例（Horizon，`DCF!D5`）：

```
DCF!D5  Total revenue / 2025e  =IS!F2  3683.96
上游：IS!F2 Revenue / 2025
下游：DCF!D41 Implied EV / S 2025 (x)
```

这样 Agent 的回答可以带单元格引用，用户能直接回表核对。这比"读完整份 Excel 再总结"可靠得多。

### 4.3 查询 API 与 UI（P1）

- `POST /api/materials/:id/query`：给前端和工具共用。
- 资料详情弹窗目前对 xlsx 显示"无预览"（[store.mjs](../store.mjs) 的 `previewFor` 只处理文本和图片）。可以加一个"模型结构"页签：
  - sheet 列表、公式数、关键输出；
  - 搜索框 → 结果表（单元格、标签、公式、值）；
  - 点击复制 `Sheet!A1`。
- 或者更轻：详情里一个"问这份模型"按钮，预填聊天输入和路径。

---

## 5. 建议方案

### P0：最小闭环（1–2 天）

只做只读查询，不改现有数据模型：

1. 把 [experiments/model-graph/parse_workbook.py](../experiments/model-graph/parse_workbook.py) 移到 `services/workbook/`，补：
   - Python / openpyxl 缺失时的友好报错；
   - `.xls` 明确拒绝（或后续接 `xlrd`）；
   - 子进程 120 s 超时、输出大小上限；
   - 解析结果 gzip 写入 `data/doc-cache/`。
2. 新增 `lib/workbook-store.mjs`：
   - `getGraph(sha)`：内存 LRU（1–2 份）→ gzip 缓存 → 解析；
   - `document_parses` 元数据；
   - 同一 sha 的并发解析合并成一个 in-flight Promise。
3. [server.mjs](../server.mjs)：
   - `createAgentSession({ customTools: [workbookQueryTool] })`；
   - `POST /api/materials/:id/query`；
   - 上传 xlsx 后后台解析（不阻塞上传响应），完成后 SSE `material.parsed`。
4. 测试 `scripts/test-workbook.mjs`：
   - 两份真实模型做 fixture；
   - 断言 `DCF!D58`、`2026 收入`、`毛利率` 的前 3 个结果包含预期行；
   - 断言服务重启后仍能查询。

验收：

- Hermes（4.9 MB / 62k 公式）后台解析 < 10 s，gzip 缓存 < 3 MB；
- 预热查询 < 300 ms，返回 < 8 KB；
- 20 条 golden set，Top-3 命中率 ≥ 80%；
- 重启后列表和查询不 404；
- 损坏 / 加密 / `.xls` 文件返回明确错误，服务不崩。

### P1：PDF + UI + 反查（2–3 天）

- 移植 `parse_pdf.py`：页级文本 + 表格 + 页码引用；扫描版 PDF 明确提示"需要 OCR"。
- 详情弹窗"模型结构"页签 / "问这份模型"入口。
- 依赖反查：`哪些单元格依赖 DCF!D58`（`query.mjs` 已有 downstream 邻接表，加一个 mode 即可）。
- 命名区域、结构化表引用（`Table1[Revenue]`）、`INDIRECT` 的显式"未解析"标记。
- 上传消息里附一段"模型地图"（sheet、公式数、关键输出），Agent 第一轮就知道文件里有什么。

### P2：规模化（约 1 周）

- `doc_cells` / `doc_edges` 表 + FTS5；跨文档搜索。
- 解析版本号 + 缓存 GC（按 LRU / 时间）。
- 评测集与回归：固定 20–50 个问题，记录 Top-3、引用正确率、延迟。
- 解析进度 / 失败重试 / 并发限制（单写者）。

---

## 6. 已做的原型验证

为了确认"不是纸上可行"，我在 [experiments/model-graph/](../experiments/model-graph/) 里做了一版独立验证，**没有接入 server.mjs**（验证完成后，生产版已提升到 [services/workbook/parse_workbook.py](../services/workbook/parse_workbook.py) 等文件，见 [workbook-query.md](workbook-query.md)）：

- [parse_workbook.py](../experiments/model-graph/parse_workbook.py)：修复了 JSON-safe、范围展开、输入节点、标签识别、紧凑输出。
- [query.mjs](../experiments/model-graph/query.mjs)：中文 bigram + 中英同义词、文本命中才计分、上下游扩展、字符预算。
- [README.md](../experiments/model-graph/README.md)：跑法和限制。

### 6.1 解析对比

| 指标 | 原版 Horizon | 改造版 Horizon | 原版 Hermes | 改造版 Hermes |
|---|---|---|---|---|
| 首次运行 | 崩溃 | 正常 | 崩溃 | 正常 |
| 耗时 | 0.41 s（补丁后） | 0.23 s | 5.49 s（补丁后） | ~4.4 s |
| JSON | 4.7 MB | 0.85 MB | 60 MB | 11 MB |
| gzip | — | 165 KB | 5.2 MB | **2.0 MB** |
| 边 | 5,030 | **9,594** | 80,201 | **121,063** |
| 输入节点 | 0 | 1,351 | 0 | 8,935 |
| 表头是公式 | 2,231 | 0 | 12,070 | 0 |

标签也从"公式文本"变成了可用的行列：

```
改造前：IS!B28  colHeader = "=B3+B2"      rowHeader = "EBITDA"
改造后：IS!B28  label = "EBITDA / 2021"

改造前：DCF!E5  colHeader = "=D1+1"
改造后：DCF!E5  label = "Total revenue / 2026e"
```

### 6.2 查询对比

| 查询 | 原版 | 改造版 |
|---|---|---|
| `收入` | Total D&A | `Total revenue / 2026e` 等（Horizon）；`Group Sales`（Hermes） |
| `2026 收入` | 只剩 2026，随机行 | `Group Sales / 2026E = 17,304.9`（Hermes） |
| `毛利率` | Total D&A | `Gross margin / 2021…`（Horizon） |
| `DCF WACC` | `IS!K42 Diff` | `DCF!D58 WACC = 5.81%` |
| `DCF!D5` | 不支持 | 直接命中 + 上游 `IS!F2` + 下游 `DCF!D41` |

单次查询：Horizon 0.08 s / 20 cells / 7 KB；Hermes 0.22 s / 20 cells / 11 KB。

### 6.3 原型不解决的事

- 旧版 `.xls`、加密文件、外部链接、`INDIRECT`、3D 引用、结构化表引用。
- 扫描版 PDF（没有 OCR）。
- 排名仍是关键词打分，不是语义检索；同义词表需要维护，且必须用 golden set 回归。
- 表头识别是启发式，合并单元格跨度过大时会跳过。
- 计算值来自工作簿缓存；不是 Excel 保存的文件可能为 `None`，不能当 0。

---

## 7. 风险与边界

| 风险 | 影响 | 处理 |
|---|---|---|
| Python / openpyxl 不在目标机器 | 功能不可用 | 启动自检；缺失时工具返回明确提示，不影响主服务；后续可换 Node 解析器 |
| 工作簿缓存值过期 / 为空 | 回答用了旧数 | 返回值标注"工作簿缓存值"，并给单元格引用；提示用户在 Excel 里重算保存 |
| 外部链接 / `INDIRECT` / 命名区域 | 图不完整 | 显式标记 `unresolved`，不要静默当 0 |
| 大模型内存 | 476 MB 解析 + 286 MB 查询 | 子进程、并发 1、LRU 1、超时；必要时上 SQLite 边表 |
| 中文同义词 | 召回不准 | golden set + 可编辑词表；先覆盖 PE 常用词 |
| 上传阻塞 | 5–10 s 卡顿 | 后台上传解析 + SSE 状态，不阻塞上传响应 |
| 安全 | 路径穿越 / 宏 / 超大文件 | 工作空间路径校验、不执行宏、大小与超时上限、仅绑定 127.0.0.1 |
| 许可 | 依赖合规 | openpyxl MIT、pdfplumber MIT、PyPDF2 BSD，均可商用 |

---

## 8. 不要照搬的部分

- `app/api/**` 的 Next.js 路由和 `@/lib` 别名 → 当前是 `node:http`。
- `DocumentStoreManager` 的内存 Map 单例 → 重启即丢。
- `~/.pi/document-cache` 全局目录、`path + mtime` 的 fileId → 用 blob sha + `data/`。
- `require('fs')`、`__dirname`、多处 `any` → ESM 下不成立。
- `JSON.stringify(context, null, 2)` → 60 MB 美化 JSON。
- `w.length > 2` 的中文过滤、无命中时的启发式兜底 → 会静默给错答案。
- `colHeader` 取"上方第一个字符串" → 会把公式当表头。
- 上传路由里同步解析 → 阻塞请求。

---

## 9. 建议的下一步

建议先做 **P0：只读的 `workbook_query` 工具 + 解析缓存**，不动现有 UI 和数据库结构。它能在不改变用户习惯的前提下，让 Agent 第一次真正"看懂"上传的 Excel 模型，并且每一步都可回退。

三个可选范围：

- **A（推荐）**：P0，只做 Agent 工具 + 查询 API。1–2 天，风险最低。
- **B**：A + 资料详情"模型结构"页签。多 1–2 天，用户可自己搜。
- **C**：B + PDF + 依赖反查 + SQLite 边表。约 1 周，适合把"模型审阅"做成核心能力。

A 方案已按此路径落地：解析器在 [services/workbook/parse_workbook.py](../services/workbook/parse_workbook.py)，缓存在 [lib/workbook-store.mjs](../lib/workbook-store.mjs)，工具在 [lib/workbook-tool.mjs](../lib/workbook-tool.mjs)，并已接入 [server.mjs](../server.mjs) 的 `customTools`。B/C 范围确认后再继续。
