# Workbench 模型查询（A 方案）：开发与验收计划

> 范围：只做 P0 的「只读 `workbook_query` 工具 + 查询 API + 解析缓存」。
> 不包含：资料详情 UI、PDF 解析、SQLite 单元格表、OCR、多用户权限。
> 目标文件：当前 `pe_workbench2`，Node 24 + `node:sqlite` + Pi Agent。
> 状态：**已实现（A 方案）**。实现与验收记录见 [workbook-query.md](workbook-query.md)。

## 1. 目标与非目标

### 目标

1. Agent 能直接查询上传的 `.xlsx` / `.xlsm`：问指标、年份、公式、上下游，不再写临时 `bash + python`。
2. 查询只返回**相关子图**（单元格、公式、缓存值、上下游），有单元格数/字符数上限。
3. 解析结果按 **blob sha256** 缓存，同一内容只解析一次；服务重启后仍可用。
4. 保持上传毫秒级响应：解析在后台队列执行，不阻塞 `/api/upload`。
5. 解析失败、`.xls`、加密文件、Python 缺失都有明确错误，不拖垮主服务。

### 非目标

- 不把 62k 单元格拆成 SQLite 表（P2 再做）。
- 不做 PDF / 文本解析（P1）。
- 不做全文语义检索/向量库；先用可解释的关键词 + 同义词 + 依赖扩展。
- 不改现有资料/版本/计划的数据模型和前端交互。

## 2. 架构

```
POST /api/upload
  → store.indexFile() 生成 material + version + blob(sha256)
  → workbooks.warm(materialId)  （fire-and-forget，不阻塞响应）
        → 解析队列（并发 1）
        → 把 blob 复制成临时 .xlsx
        → python3 services/workbook/parse_workbook.py --out tmp.json
        → gzip 写入 data/doc-cache/<sha>.json.gz
        → document_parses.status = ready
        → SSE material.parsed

Agent tool / POST /api/materials/:id/query
  → material → latest version → blob sha
  → WorkbookStore.getGraph(sha)
        → 内存 LRU（2 份）
        → gzip 缓存
        → 解析（同一 sha 合并 in-flight）
  → queryGraph(index, query, maxCells)
  → 文本/JSON 返回（默认 < 8 KB）
```

关键原则：

- **内容寻址**：缓存 key 是 `sha256`，不是路径/时间；恢复旧版本、同名文件、重复上传都能复用。
- **单写者**：解析队列串行，避免两个 4.9 MB 模型同时吃 1 GB 内存。
- **失败可恢复**：失败记录带 `parser_version`；升级解析器后自动重试。
- **可关闭**：`WORKBOOK_QUERY=0` 时工具和 API 都不注册，主服务行为不变。

## 3. 数据模型

新增一张元数据表（不存大字段）：

```sql
create table if not exists document_parses (
  blob_sha256 text primary key,
  file_name text not null,
  file_type text not null,          -- excel | pdf | text
  parser_version integer not null,
  status text not null,             -- running | ready | failed
  stats_json text,
  error text,
  parsed_at text,
  updated_at text not null
);
```

缓存文件：

```
data/doc-cache/<sha256>.json.gz     # 解析结果，Hermes 约 2 MB
```

`stats_json` 只存摘要（公式数、边数、sheet 数、耗时），用于列表/诊断，不存整图。

## 4. 文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `services/workbook/parse_workbook.py` | 生产版解析器：JSON-safe、范围展开、输入节点、行列标签、紧凑输出 |
| `lib/workbook-store.mjs` | sha 缓存、gzip、SQLite 元数据、LRU、解析队列、错误映射 |
| `lib/workbook-query.mjs` | 检索与子图扩展、Markdown/JSON 格式化、summary |
| `services/workbook/parse_pdf.py` | P1 占位，不在本期 |
| `scripts/fixtures/make-workbook-fixture.py` | 生成测试用 mini xlsx |
| `scripts/test-workbook.mjs` | 端到端测试（fixture + 真实模型可选 + Agent 工具注册） |

### 修改

| 文件 | 改动 |
|---|---|
| `store.mjs` | 新增 `document_parses` 表；新增 `latestVersion(id)` |
| `server.mjs` | 初始化 `WorkbookStore`；上传后 warm；新增两个 API；注册 `workbook_query` 工具 |
| `package.json` | 增加 `typebox` 依赖；增加 `test:workbook` 脚本 |
| `docs/foundation.md` | 追加「模型查询」一节（API/缓存/工具） |

## 5. 开发任务

### P0.1 解析器生产化（0.5 天）

- [x] 从 `experiments/model-graph/parse_workbook.py` 提升到 `services/workbook/`。
- [x] 增加扩展名检查：仅 `xlsx/xlsm/xltx/xltm`；`.xls` 明确报错。
- [x] `openpyxl` 缺失、文件加密/损坏、超时、输出过大都有可读错误。
- [x] `--version` 输出 `PARSER_VERSION`，与 JS 常量对齐。
- [x] 紧凑 JSON（无 indent）、gzip 由 Node 侧完成。

### P0.2 缓存与存储（0.5 天）

- [x] `WorkbookStore`：`getGraph(sha)`、`getRecord(sha)`、`invalidate(sha)`。
- [x] 内存 LRU 2 份；命中时不重新 gzip 解压。
- [x] 解析队列并发 1；同一 sha 的并发请求合并。
- [x] 原子写缓存：`.tmp-<pid>` → rename。
- [x] `document_parses` 状态机：running → ready / failed。
- [x] 失败记录在 `parser_version` 不变时直接抛错，避免反复解析坏文件。

### P0.3 查询（0.5 天）

- [x] 中文 bigram + 中英同义词；两字中文词不再被过滤。
- [x] 必须有行/列/Sheet 文本命中，禁止启发式凑分。
- [x] 年份/期间加权；比例行/多倍数行降权；汇总行加权。
- [x] 上下游 BFS，最多 2 层；过滤无标签辅助单元格。
- [x] 结果上限：默认 40 cells / 8 KB。
- [x] `Sheet!A1` 直接命中；`DCF` 这种显式 sheet 查询返回该 sheet 输出节点。

### P0.4 Agent 工具（0.5 天）

- [x] `customTools: [workbookQueryTool]`，工具名 `workbook_query`。
- [x] 参数：`path`、`query`、`maxCells?`。
- [x] 路径规范化：`agent-workspace/...`、绝对路径、相对路径都能处理；越界拒绝。
- [x] 未索引路径先 `store.indexFile()` 再查询。
- [x] 返回纯文本（单元格 / 标签 / 公式 / 值 / 上下游），不超过 8 KB。
- [x] 错误用 `isError: true` 返回，不抛出到 Agent loop。

### P0.5 API（0.5 天）

- [x] `GET /api/materials/:id/workbook`：状态、stats、sheets、key outputs。
- [x] `POST /api/materials/:id/query`：`{ query, maxCells? }`。
- [x] 400（空 query）、404（material 不存在）、422（不支持的类型）、500（解析失败，带 message）。
- [x] 上传后后台 warm；SSE `material.parsed`（前端可不处理）。

### P0.6 测试（0.5 天）

- [x] `scripts/fixtures/make-workbook-fixture.py`：生成含公式、SUM 范围、跨 sheet 引用、中文标签的 xlsx。
- [x] `scripts/test-workbook.mjs`：
  - 解析 fixture，断言 stats / 边 / 标签；
  - `SUM(B2:B5)` 的 4 个中间单元格都在边上；
  - 跨 sheet 输入节点存在；
  - 「毛利率」「2026 收入」命中预期单元格；
  - 缓存：清内存后仍从 gzip 加载，不重新解析；
  - 重启：新 WorkbookStore 复用同一 DB/缓存；
  - 失败：伪 xlsx、`.xls` 返回明确错误；
  - Agent 工具注册：`getAllTools()` 含 `workbook_query`（已用 deepseek-flash 实跑验证）。
- [x] `--real` 模式：跑两份上传模型，记录耗时/命中。

### P0.7 文档与验收（0.5 天）

- [x] `docs/workbook-query.md`：用法、API、缓存、限制、验收结果。
- [x] 更新 `docs/foundation.md`。
- [x] 记录实测数据；未通过项明确标注。

## 6. 验收标准

### 功能

| 编号 | 用例 | 期望 |
|---|---|---|
| F1 | 上传 4.9 MB xlsm，等待 10 s，问「2026 收入」 | 返回 `Group Sales / 2026E`，值 17,304.9，含单元格引用 |
| F2 | 问「毛利率」 | 返回 `Gross margin` 行，含年份列 |
| F3 | 问「DCF WACC」 | 返回 `DCF!D58` 等 WACC 单元格，不再返回 `IS!K42 Diff` |
| F4 | 问 `DCF!D5` | 直接命中，并给出上游 `IS!F2`、下游 `DCF!D41` |
| F5 | 问「收入」 | 返回 Revenue/Group Sales 行，中文同义词生效 |
| F6 | 不存在的关键词 | 返回空 + 提示，不返回无关单元格 |
| F7 | 服务重启后再查同一文件 | 直接命中缓存，不重新解析 |

### 性能

| 指标 | 目标 | 实测（fixture / Horizon / Hermes） |
|---|---|---|
| 首次解析（4.9 MB / 62k 公式） | < 10 s | 待填 |
| 缓存大小（gzip） | < 3 MB | 待填 |
| 预热查询（Hermes） | < 300 ms | 待填 |
| 单次结果 | < 8 KB / 40 cells | 待填 |
| 上传响应 | 不因解析变慢 | 待填 |

### 健壮性

| 编号 | 用例 | 期望 |
|---|---|---|
| R1 | `.xls` | 422 + 「另存为 .xlsx」 |
| R2 | 改名为 `.xlsx` 的文本 | 解析失败，错误写入 `document_parses`，服务不崩 |
| R3 | 加密工作簿 | 明确错误，可重试 |
| R4 | Python / openpyxl 缺失 | 工具返回安装提示，主服务正常 |
| R5 | 路径 `../` 越界 | 工具/接口拒绝 |
| R6 | 空 query | 400 |
| R7 | 同一文件并发 5 次查询 | 只解析 1 次（in-flight 合并） |
| R8 | 解析超时 | 120 s 后取消，记录 failed |

### 回归

- `npm start` 正常启动；现有 `/api/materials`、`/api/plans`、上传、版本恢复、计划运行不变。
- `WORKBOOK_QUERY=0` 时，工具不注册、API 返回 404/未启用，其他功能不受影响。
- 现有会话可继续打开；新会话才带 `workbook_query`。

## 7. 测试矩阵

| 层级 | 内容 | 运行方式 |
|---|---|---|
| 单元 | tokenize / 打分 / 格式化 | `node scripts/test-workbook.mjs`（默认包含） |
| 集成 | fixture 解析 + 缓存 + 重启 + 失败 | `node scripts/test-workbook.mjs` |
| 真机 | 两份上传模型 + 20 条问题 | `node scripts/test-workbook.mjs --real` |
| Agent | 工具注册、参数校验、错误返回 | `node scripts/test-workbook.mjs --agent` |
| 手工 | Web 对话问模型、看 tool 卡 | 启动 `npm start` 后操作 |

## 8. 上线与回滚

- 默认开启；`WORKBOOK_QUERY=0` 关闭工具与 API。
- 解析失败不影响上传、资料列表、Agent 其他工具。
- 回滚：删除 `document_parses` 表和 `data/doc-cache/` 即回到原状；代码不回滚也能用 `WORKBOOK_QUERY=0` 停用。
- 缓存可随时删除，下次查询自动重建。

## 9. 风险

| 风险 | 处理 |
|---|---|
| Python 不在目标机器 | 启动不报错；调用时返回安装提示；`PYTHON_BIN` 可指定 |
| 大模型内存 | 并发 1 + LRU 2；解析子进程；120 s 超时 |
| 缓存值与 Excel 不一致 | 返回时标注「工作簿缓存值」；让用户重算保存 |
| 关键词排序不准 | 先覆盖 PE 高频词；P1 用 golden set 调权重 |
| `.xls` / 加密 / 外部链接 | 明确报错或标记 unresolved，不静默 |
| 解析器升级 | `PARSER_VERSION` +1，自动失效旧缓存 |

## 10. 验收记录（2026-10-19）

| 项 | 结果 |
|---|---|
| `npm run test:workbook` | 20 passed / 0 failed |
| `npm run test:workbook:real` | 20 passed / 0 failed；Hermes 4.9 s / 62,862 公式 / 1.9 MB 缓存；Horizon 0.4 s / 5,148 公式 / 161 KB 缓存 |
| Hermes 查询 `2026 收入` | `Consolidated!AU6 = 17,304.904` |
| 热查询（Hermes `毛利率`） | 0.03–0.19 s |
| 重启后查询 | 命中 gzip 缓存，不重新解析 |
| `WORKBOOK_QUERY=0` | 接口 404；其他接口正常 |
| Agent 实跑 | 模型调用 `workbook_query` 并返回带单元格引用的答案 |

> 8080 上运行的是改动前进程，`npm start` 重启后新接口/工具生效。

## 11. 交付物

1. 可用的 `workbook_query` 工具 + 查询 API。
2. `data/doc-cache` 缓存与 `document_parses` 元数据。
3. 测试脚本与真实模型结果。
4. `docs/workbook-query.md`（用法 + 验收记录）。
