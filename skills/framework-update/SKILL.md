---
name: framework-update
description: 跟踪运行专用。读取 analysis-state.json 与投资框架报告，用新数据逐条复核观点和失效条件，只更新受影响对象并回写状态与报告，最后输出含观点状态与触发失效条件的结构化结果 JSON。
---

# 投资框架跟踪更新

这不是重写报告，而是执行一次**可审计的复核**：新证据进来 → 逐条检查失效条件 → 决定哪些观点要改 → 只动受影响的部分 → 留下变化记录。

宿主会在跟踪运行时把目标文件、基线版本和结果 JSON 路径传给你。先读 [运行契约](references/run-contract.md) 和 [更新规则](references/update-rules.md)。

## 输入

- 目标报告：`exports/.../投资框架报告.md`（唯一允许原位更新的文件）。
- 状态文件：同目录的 `analysis-state.json`（事实源）。
- 新数据：财务、行情、行业、公告；每条记录来源和日期。
- 基线：`revision`、`tracking.data_cutoff`、上次 `thesis_status`。

先读状态和报告，再看新数据。**不要**先看价格涨跌，再回头找理由。

## 监测模式

如果宿主 prompt 里有“本次监测项”，本次是**后台监测检查**，按下面执行：

- 只检查列出的 MON 对应的 F，不顺手复核其他观点或改其他小节；
- 更新 `falsifiers` 的 `last_observed` / `last_checked_at` / `status`（armed / warning / triggered / unknown）/ `next_check_at`；
- **没有判断变化时不要改报告，也不要追加 `## 跟踪记录`**；观察值只写状态文件；
- 结果 JSON 必须包含 `monitorChecks`，覆盖本次每个 MON；触发/预警同时写 `invalidations`；
- 只有触发导致观点/估值变化时，才按下面的“执行顺序”改 T/A/S/V 与报告受影响小节。

## 执行顺序

### 1. 建立基线

- 读 `analysis-state.json`，确认 `framework_id`、`revision`、`data_cutoff`、观点与失效条件清单。
- 读报告，确认七节结构与上次跟踪记录。
- 记录本次数据截止日（`as_of`），必须晚于或等于基线；不能用更早的数据做“更新”。
- 状态文件缺失或无法解析：不要凭空重建。是投资框架就按报告现有结构做最小复核、标 `needs_review` 并建议补建状态；不是投资框架就按通用刷新处理。

### 2. 采集新证据

按失效条件里写的 `source` 和 `frequency` 去取数，而不是把能拿到的数据都抓一遍。

- 每条新证据记录：来源、发布日期、期间、口径、定位。
- 到期但拿不到的数据标 `unknown`，写清缺什么，不要用旧值冒充本期观察。
- 新证据只评价“现在是否仍成立”，不能倒灌成原模型当时已知。

### 3. 逐条核对失效条件（先于观点）

对每个 `armed` 的 `F`：

1. 取本期观察值 `observed`；
2. 按 `operator` / `threshold` 判断：`triggered` / 未触发 / `unknown`；
3. 更新 `status`、`last_observed`、`last_checked_at`；
4. 触发的写入 `tracking.triggered_falsifier_ids`，并执行 `action` 描述的核验。

不要跳过 F 直接改观点；也不要因为价格波动触发经营类 F。

### 4. 决定观点状态（再于报告）

对每个观点：

| 证据情况 | 状态 |
|---|---|
| 支持证据增强，失效条件未触发 | `active`（可在 note 写“已确认”，不要轻易升 `confirmed`） |
| 出现持续偏离，但机制未被推翻 | `weakened` |
| 核心机制被推翻，或关键失效条件触发且不可逆 | `invalidated` |
| 原判断被后续事实完全证实 | `confirmed`（慎用，需多个期间） |
| 不再研究 | `retired`，ID 不复用 |

状态变化必须能指到具体证据 ID 和失效条件 ID。只写“感觉变差了”不算。

### 5. 只改受影响的对象

按依赖方向决定更新范围：

```
新证据 → A 假设 → S 敏感性 → V 估值 → T 观点 → F 失效条件 → 报告小节
```

- 修改假设时保留原 `assumption_id`，在 `changes` 里写 before/after。
- 敏感性只在输入变化时重算；重算要说明基准、扰动、固定条件。
- 估值只在假设或方法变化时改；价格变动本身不改估值模型，只更新 `market`。
- 观点措辞变化不算实质变化，不改状态、不写 changes。
- 新增观点用新 ID；删除用 `retired`，不物理删。

### 6. 回写状态

按以下顺序组织 `analysis-state.json`，用**一次 write** 写完整 JSON（不要分多次增量编辑；有 bash 时可先写临时文件再替换）：

1. `evidence` 追加新证据；
2. `falsifiers` 更新观察与状态；
3. `theses` 更新状态与理由；
4. `assumptions` / `sensitivities` / `valuations` 按受影响范围更新；
5. `market` 更新价格与日期；
6. `changes` 追加本次变化（`revision + 1` 时）；
7. `tracking` 更新游标：
   ```json
   { "last_run_id": "<宿主传入>", "last_run_at": "YYYY-MM-DD",
     "data_cutoff": "YYYY-MM-DD", "thesis_status": { "T1": "active" },
     "triggered_falsifier_ids": ["F2"] }
   ```
8. `revision`：只有上述 1–6 有实质变化时才 +1；无变化保持原值。

写完若有 bash，跑一次结构校验：

```bash
node <investment-framework skill 目录>/scripts/validate_state.mjs analysis-state.json
```

没有 bash 时按状态契约自查 ID、引用和状态配对，并在结果 `writeback.note` 里写“未执行脚本校验”。

### 7. 回写报告（最小补丁）

只改受影响的小节，保留未受影响的判断、ID 和写作结构：

- 第 2 节：结论/目标价区间变了才改；
- 第 4 节：观点状态、证据、置信度变了才改；
- 第 5 节：估值或敏感性重算后才改；
- 第 6 节：失效条件的观察值、状态、触发情况；
- 第 7 节：证据、缺口、版本变化。

末尾 `## 跟踪记录` **只追加**一行：

```
- 2026-10-20 ｜数据截止 2026-10-18｜T1 维持、T2 降为 weakened｜触发 F2｜目标价 92 → 88
```

没有实质变化也要追加，写“本期无变化”。

### 8. 输出结果 JSON

写到宿主指定的 `.tracking/<tracking_id>/<run_id>.json`。除了 `status / conclusion / summary / deltas / reasons / judgment / sources / notUsed / writeback`，**必须**包含：

```json
"theses": [
  { "id": "T1", "statement": "……", "status": "active",
    "change": "维持", "note": "ASP 环比仍为正，F1 未触发" }
],
"invalidations": [
  { "id": "F2", "thesis_id": "T1", "condition": "库存 > 12 周",
    "observed": "12.6 周", "triggered": true,
    "action": "下调 2027 ASP 假设，重算 V1" }
]
```

- `theses` 覆盖所有 `active / weakened / invalidated` 的观点，不只是变化的。
- `invalidations` 列出本期核对过的关键 F；触发的放前面。
- 字段缺失会导致界面只显示通用结论，不显示观点台账。

完整 schema 见 [运行契约](references/run-contract.md)。

## 判断规则

- **单期偏差**：记录，不自动改长期假设。
- **持续偏离**：连续 2–3 期且缺口扩大，才下调假设。
- **机制失效**：直接改观点状态，重写机制，不做数字微调。
- 不因股价涨跌改经营判断；价格只进 `market` 和回报路径。
- 不把新实际倒灌成原模型输入；原预测保留，另记 `actual`。
- 证据冲突时保留双方，写清取舍理由，不静默选一个。
- 没有新数据时输出 `no_change`；普通跟踪要追加跟踪记录，监测模式**不要**追加。

## 边界

- 只改目标报告和状态文件；不动源 Excel、`inputs/`、`uploads/`。
- 不创建 `*-v2.md` 之类的副本；同路径更新由宿主生成版本。
- 不自动交易、不自动改跟踪频率；需要用户确认的标 `needs_review`。
