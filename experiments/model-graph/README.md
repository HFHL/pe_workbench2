# model-graph 可行性验证

> **状态：验证已完成，生产实现已提升为 [services/workbook/parse_workbook.py](../../services/workbook/parse_workbook.py) + [lib/workbook-store.mjs](../../lib/workbook-store.mjs) + [lib/workbook-query.mjs](../../lib/workbook-query.mjs)。**
> 这里保留最初的独立验证脚本，方便对照；实际接入与验收见 [docs/workbook-query.md](../../docs/workbook-query.md)。

这是一次**独立验证**，没有接入 `server.mjs`、没有改数据库、没有动前端。

目的：验证 `pe-workbench-document-system-2026-10-19.zip` 里的核心思路
（把 Excel 解析成公式依赖图，查询时只返回相关子图）在真实的投研模型上是否成立，
以及需要改哪些地方才能在 pe_workbench2 里落地。

## 文件

| 文件 | 作用 |
|---|---|
| `parse_workbook.py` | 把 xlsx/xlsm 解析成紧凑的公式图 JSON（公式、缓存值、行列标签、依赖边、输入节点） |
| `query.mjs` | 中文/英文关键词 → 命中单元格 → 沿依赖边扩展 → 返回受字符数限制的子图 |

## 跑法

```bash
# 1) 解析（输出 JSON，可 gzip 后缓存）
python3 experiments/model-graph/parse_workbook.py \
  agent-workspace/uploads/<model>.xlsx \
  --out /tmp/model-graph/model.json

# 2) 查询
node experiments/model-graph/query.mjs /tmp/model-graph/model.json "2026 收入" --format md
node experiments/model-graph/query.mjs /tmp/model-graph/model.json "DCF!D5" --max-cells 8
```

依赖：Python 3 + `openpyxl`；Node 18+。机器上已有。

## 实测（本机，两份上传模型）

| | Horizon Robotics `9660.HK` | Hermes `HRMS.PA` |
|---|---|---|
| 文件 | 227 KB xlsx，8 sheets | 4.9 MB xlsm，36 sheets |
| 公式数 | 5,148 | 62,862 |
| 解析耗时 | 0.23 s | ~4.4 s |
| JSON 大小 | 0.85 MB | 11 MB |
| gzip 后 | 165 KB | 2.0 MB |
| 峰值内存 | ~88 MB | ~476 MB |
| 查询耗时 | 0.08 s | 0.22 s |
| 单次结果 | ~7 KB JSON / 20 cells | ~11 KB JSON / 20 cells |

参考实现（原版）在同样文件上的数据见 `docs/document-graph-integration.md`。

## 与参考实现的关键差异

1. 所有值 JSON-safe（日期、时间、Decimal），不会再因为一个 datetime 崩掉。
2. `SUM(B4:B10)` 展开成 B4…B10，而不是只连两个端点。
3. 被引用但没有公式的单元格成为**输入节点**，输入 → 产出的边不会丢。
4. 行/列标签从真实的标签列、表头行推导，公式不会被当成表头；表头本身是公式时用缓存值。
5. 中文按 bigram 切词 + 中英同义词（收入/revenue/sales、毛利率/gross margin…），
   不会因为 `length > 2` 把「收入」丢掉。
6. 没有文本命中就返回空结果，不再用「终端节点 + 复杂度」凑出无关单元格。
7. 输出是紧凑数组 + gzip，Hermes 从 60 MB 降到 2 MB（gzip）。

## 已知限制

- 只用 openpyxl，读不了旧版 `.xls`；加密文件、外部链接、`INDIRECT`、结构化表引用（`Table1[Col]`）、
  3D 引用（`Sheet1:Sheet3!A1`）没有处理。
- `SUM(A:A)` 这类超大范围只保留轮廓（四周），不展开全部单元格。
- 计算值来自工作簿缓存；如果文件不是 Excel 保存的，可能为 `None`，不能当成 0。
- 表头识别是启发式，合并单元格跨度过大时会跳过。
- 扫描版 PDF 不涉及（这里只做 Excel）。
- 查询排序是关键词打分，不是语义检索；需要一份 golden set 来调权重。

这些都在报告的「风险与边界」里展开。
