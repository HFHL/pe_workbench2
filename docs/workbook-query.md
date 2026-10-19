# 模型查询（workbook_query）实现与验收

> 状态：A 方案已实现。只做只读查询，不改资料/版本/计划模型，不改前端。
> 计划与任务清单：[workbook-query-plan.md](workbook-query-plan.md)

## 1. 做了什么

给 Agent 加了一个 `workbook_query` 工具，并加了两条 HTTP 接口：

- Agent 问「2026 收入」「毛利率」「DCF WACC」「DCF!D5」时，直接查解析好的公式图，
  返回相关单元格、公式、缓存值和上下游依赖；
- 解析结果按 **blob sha256** 缓存到 `data/doc-cache/<sha>.json.gz`，
  元数据写 `document_parses`；
- 上传 `.xlsx/.xlsm` 后后台解析，不阻塞上传响应；
- 服务重启后缓存仍可用；
- `WORKBOOK_QUERY=0` 可整体关闭。

### 数据流

```
POST /api/upload
  → store.indexFile()：material + version + blob(sha256)
  → workbooks.warm(id)（fire-and-forget）
        → 解析队列（并发 1）
        → blob 复制为临时 .xlsx
        → python3 services/workbook/parse_workbook.py --out tmp.json
        → gzip 写 data/doc-cache/<sha>.json.gz
        → document_parses.status = ready
        → SSE material.parsed

Agent / POST /api/materials/:id/query
  → material → latest version → sha
  → WorkbookStore.getGraph(sha)
        → 内存 LRU（2 份）→ gzip 缓存 → 解析
  → queryGraph() → 文本 / JSON
```

## 2. 怎么用

### Agent 工具

工具名：`workbook_query`

```json
{
  "path": "uploads/foo.xlsx",
  "query": "2026 收入",
  "maxCells": 40
}
```

- `path`：工作区相对路径，`uploads/…` 或 `agent-workspace/uploads/…` 都行；越界拒绝。
- `query`：中文/英文关键词、年份，或 `Sheet!A1`。
- `maxCells`：1–120，默认 40。

返回的是纯文本（不是表格），带 `Sheet!A1` 引用和「缓存值」提示。例：

```
查询：DCF WACC
候选 2 个单元格，返回相关子图 21 个。数值为工作簿缓存值，可能不是最新；以单元格引用为准。
- [命中] DCF!K39 · WACC · =D58 · 0.058
- [命中] DCF!D58 · WACC · =D52*D47+D56*(1-D47) · 0.058
- [上游] DCF!D47 · Equity / (Equity +Debt) Ratio · =BS!F46/(BS!F46+BS!F35+BS!F30) · 0.585
...
```

### HTTP

```bash
# 模型结构 + 状态 + 关键输出（首次调用可能触发解析）
curl -s localhost:8080/api/materials/<id>/workbook | jq '{status,stats,sheets:[.sheets[].name]}'

# 查询
curl -s -X POST localhost:8080/api/materials/<id>/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"2026 收入","maxCells":20}' | jq '{matchedCells,returned,text}'
```

错误：

| 状态 | 场景 |
|---|---|
| 400 | `query` 为空 / 过长 |
| 404 | material 不存在；`WORKBOOK_QUERY=0` |
| 422 | `.xls`、加密/损坏、解析失败 |
| 503 | Python / openpyxl 缺失 |
| 504 | 解析超时（120 s） |

## 3. 存储与状态

```sql
create table document_parses (
  blob_sha256 text primary key,
  file_name text not null,
  file_type text not null,
  parser_version integer not null,
  status text not null,          -- running | ready | failed
  stats_json text,               -- formulaCount / edgeCount / cacheBytes / elapsedMs...
  error text,
  parsed_at text,
  updated_at text not null
);
```

- 缓存 key 是内容 sha，同一文件多版本、恢复旧版、重复上传只解析一次。
- 解析队列并发 1；同一 sha 的并发查询合并成一个 Promise。
- 失败记录会保留；`parser_version` 不变时不再反复解析坏文件。
- 升级解析器时把 `PARSER_VERSION` +1，旧缓存自动失效。

## 4. 代码清单

| 文件 | 作用 |
|---|---|
| [services/workbook/parse_workbook.py](../services/workbook/parse_workbook.py) | 生产解析器：JSON-safe、范围展开、输入节点、行列标签 |
| [lib/workbook-store.mjs](../lib/workbook-store.mjs) | sha 缓存、gzip、SQLite 元数据、LRU、解析队列、错误映射 |
| [lib/workbook-query.mjs](../lib/workbook-query.mjs) | 中文/英文检索、子图扩展、格式化、summary |
| [lib/workbook-tool.mjs](../lib/workbook-tool.mjs) | Pi 自定义工具 `workbook_query` |
| [server.mjs](../server.mjs) | 初始化、上传 warm、两条 API、注册工具 |
| [store.mjs](../store.mjs) | `document_parses` 表、`latestVersion()` |
| [scripts/test-workbook.mjs](../scripts/test-workbook.mjs) | fixture + 真实模型 + 失败模式测试 |
| [scripts/fixtures/make-workbook-fixture.py](../scripts/fixtures/make-workbook-fixture.py) | 生成测试 xlsx |

## 5. 验收结果

### 自动测试

```bash
npm run test:workbook        # fixture，20 项
npm run test:workbook:real   # 加两份真实上传模型
```

最近一次（2026-10-19）：

```
20 passed, 0 failed

real models
  HERMES-INTERNATIONAL_HRMS.PA…xlsm: 4943ms, formulas=62862, cache=1998559B, hits=4520
  Horizon-Robotics_9660.HK…xlsx:     402ms, formulas=5148,  cache=165109B,  hits=449
```

覆盖：

- 标签识别（合并表头、公式表头、中文标签）；
- `SUM(B2:B5)` 展开到每个中间单元格；
- 跨 sheet 输入成为图节点；
- 「毛利率」「2025 收入」命中预期行；
- 未知关键词返回空，不返回无关单元格；
- `Sheet!A1` 直接命中；
- 缓存跨 WorkbookStore 实例 / 进程重启；
- 5 个并发查询只解析 1 次；
- 空 query、伪 xlsx、`.xls`、Python 缺失、解析超时；
- 工具路径越界；
- 中文两字词分词；
- `formatResult` 有界且不是表格。

### 真机（8099 临时实例）

| 用例 | 结果 |
|---|---|
| `GET /api/materials/<Hermes>/workbook` | 4.91 s 首次解析；`formulaCount=62,862`、`edgeCount=121,063`、`sheets=36` |
| `POST .../query {"query":"2026 收入"}` | `Consolidated!AU6 · Group Sales / 2026E · 17,304.904` |
| 同一进程再次查「毛利率」 | 0.03–0.19 s（HTTP + JSON）；命中 `Gross margin` 行 |
| 重启 8099 后再查 | 直接读 gzip 缓存，不重新解析 |
| `WORKBOOK_QUERY=0` | `/api/materials` 正常；`/query` 返回 404 `disabled` |
| Agent 实跑（deepseek-flash） | 模型调用 `workbook_query`，返回 `Consolidated!AU6 = 17,304.904`，并带缓存值提醒 |

> 8080 上正在运行的是改动前的进程；重启 `npm start` 后新工具和接口才会生效。

## 6. 运维

```bash
# 关闭（不注册工具、接口 404）
WORKBOOK_QUERY=0 npm start

# 指定 Python（默认 python3）
PYTHON_BIN=/opt/homebrew/bin/python3 npm start

# 清空解析缓存（可随时删，下次查询重建）
rm -rf data/doc-cache
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/workbench.db').exec('delete from document_parses')"
```

日志：解析失败会打印 `[workbook] parse failed for <path>: <message>`，并广播 `material.parse_failed`。

## 7. 限制

- 只支持 `.xlsx/.xlsm/.xltx/.xltm`；`.xls` 需另存为 `.xlsx`。
- 数值是工作簿缓存值；不是 Excel 保存的文件可能为空，不能当 0。
- 不解析外部链接、`INDIRECT`、结构化表引用（`Table1[Col]`）、3D 引用；这些引用不会进图。
- `SUM(A:A)` 这类超大范围只保留轮廓，不展开全部单元格。
- 单 sheet 超过 10,000 行或 512 列的部分会被截断（P0 保护内存）。
- 检索是关键词 + 同义词 + 依赖扩展，不是语义检索；排序仍需 golden set 调。
- 解析内存峰值约 476 MB（4.9 MB / 62k 公式模型）；并发 1、LRU 2。
- 扫描版 PDF 不支持（P1 再评估 OCR）。

## 8. 后续（P1/P2）

- P1：PDF 页级/表格查询；资料详情「模型结构」页签；依赖反查（哪些单元格依赖 `DCF!D58`）；命名区域。
- P2：`doc_cells`/`doc_edges` + FTS5；跨文档搜索；golden set 回归；缓存 GC。
