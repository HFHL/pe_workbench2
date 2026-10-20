# analysis-state.json 契约（schema 2.0）

状态文件是投资框架的**事实源**，报告是它的**视图**。跟踪运行只改状态和受影响小节，不重写整份报告。

文件放在与 `投资框架报告.md` 相同的 `exports/` 目录，名字固定为 `analysis-state.json`。手工新建时以 `assets/analysis-state.template.json` 为起点。

## 顶层

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | `"2.0"` | 是 | 固定字符串 |
| `framework_id` | string | 是 | 稳定标识，如 `IF-CXMT`；不随版本变化 |
| `revision` | integer ≥ 1 | 是 | 仅在内容有实质变化时 +1 |
| `stage` | `draft` / `reviewed` / `tracked` | 是 | `reviewed` 才要求观点与失效条件齐全 |
| `subject` | object | 是 | 见下 |
| `model` | object | 是 | 模型说明与核对，可为空对象 |
| `sources` | array | 是 | 原始文件/页面 |
| `evidence` | array | 是 | 从来源取出的一条事实 |
| `assumptions` | array | 是 | 观点依赖的假设 |
| `theses` | array | 是 | 观点台账，跟踪的核心 |
| `sensitivities` | array | 是 | 敏感性测试 |
| `valuations` | array | 是 | 情景估值 |
| `market` | object | 是 | 价格与共识 |
| `falsifiers` | array | 是 | **失效条件，跟踪的最小单元** |
| `gaps` | array | 是 | 未知与缺口 |
| `changes` | array | 是 | 版本变化记录 |
| `tracking` | object | 是 | 跟踪游标 |
| `review` | object | 是 | 自查状态 |

## subject

```
company, security, currency, units,
model_as_of, model_file, model_fingerprint,
valuation_date, market_price_date,
actuals_through, forecast_start, data_cutoff, horizon
```

日期一律 `YYYY-MM-DD`。`data_cutoff` 是本次判断使用的信息截止日，不是生成日期。未知写 `null`，不要用今天补。

## 对象与 ID

| 前缀 | 集合 | 用途 |
|---|---|---|
| `SRC` | `sources` | 文件、公告、行情、研报 |
| `E` | `evidence` | 从来源读到的一条事实 |
| `A` | `assumptions` | 观点依赖的假设（模型输入或研究假设） |
| `T` | `theses` | 观点/投资逻辑 |
| `S` | `sensitivities` | 敏感性测试 |
| `V` | `valuations` | 情景估值 |
| `F` | `falsifiers` | 失效条件/监控项 |
| `G` | `gaps` | 缺口 |
| `C` | `changes` | 版本变化 |

ID 全局唯一、跨版本稳定。观点失效后标 `retired`，**不要**把 `T1` 复用给另一条逻辑。

### evidence.kind

`model_input` / `formula` / `cached` / `actual` / `market` / `consensus` / `external_forecast` / `inference`

公式与数值不能混称同一性质；“模型预测”不是“已实现”；“一份券商模型”不是“市场共识”。

### assumptions.kind

`model_input`（原模型直接设定）/ `model_forecast`（原模型算出）/
`research_forecast`（本次研究新增）/ `actual`（已实现）。

`value` 可为 `null`（定性假设），此时 `statement` 必须写清判断方向。

### theses[] 必填

```
id, statement, mechanism, horizon, assumption_ids,
support_ids, counter_ids, alternatives, unknowns,
confidence, confidence_reason, status
```

- `statement`：一句话，可检验，不写“长期看好”这类不可证伪的话。
- `mechanism`：通过什么变化、什么路径带来回报。
- `support_ids` / `counter_ids`：必须都能解析到 evidence。
- `alternatives`：同一证据的其他合理解释；没有就写“暂未找到”。
- `confidence`：`high` / `medium` / `low`，`confidence_reason` 用证据质量与缺口解释，不打无依据的概率分。
- `status`：`active` / `weakened` / `invalidated` / `confirmed` / `retired`。

### falsifiers[] 必填（跟踪契约）

```
id, thesis_id, statement, metric, operator, threshold, observed,
source, frequency, warning, action, status, last_checked_at, last_observed
```

- `metric` 必须是**可观测**的量，且给出具体口径（如“季度 DRAM 合约价环比”），不能写“行业景气度”。
- `operator`：`>` `>=` `<` `<=` `=` `crosses_below` `crosses_above`。
- `threshold` 要有依据：历史波动、模型临界值、经营约束或明确约定；不默认 ±10%。
- `source`：数据源名称 + 发布节奏。
- `frequency`：`daily` / `weekly` / `monthly` / `quarterly` / `event`。
- `action`：触发后做什么（核验、改判、重算、降级），**不是自动交易**。
- `status`：`armed` / `warning` / `triggered` / `unknown` / `retired`。`warning` 表示已过预警阈值但未触发失效。
- 每条 `active` 或 `weakened` 的观点至少 1 条 `armed` 或 `triggered` 的失效条件。

允许定性失效条件（`threshold` 写"事件发生"），但必须写清核验方式与数据源；`unknown` 要写明缺什么。

### sensitivities[] 必填

```
id, assumption_ids, method, baseline, perturbation, result,
affects, evidence_ids, fixed_conditions, limitations
```

- `method`：`model_input`（扰动模型真正独立的输入，沿公式传播）/ `price_condition`（给定 EPS、倍数的价格对照）/ `scenario`（一致情景组合）。
- `affects`：受影响的 `valuations` 或 `theses` ID。
- `result`：方向 + 幅度 + 单位；不能只写“敏感”。
- `price_condition` 不能替代 `model_input` 测试，也不能用来通过“真正输入”验收。

### valuations[] 必填

```
id, scenario, method, as_of, value, unit,
assumption_ids, thesis_ids, evidence_ids, formula, limitations
```

`scenario`：`bear` / `base` / `bull` / `reverse`。`value` 可为 `null`，但必须在 `limitations` 写原因。多方法并列时分别列，不自选主目标价、不合成加权。

### changes[]

```
id, at, revision, affected_ids, before, after, reason, evidence_ids, run_id
```

只在有实质变化时追加。首次建框架不写 changes（没有前版）；措辞变化不写。

## tracking 游标

```
{
  "last_run_id": null,
  "last_run_at": null,
  "data_cutoff": null,
  "thesis_status": { "T1": "active" },
  "triggered_falsifier_ids": []
}
```

每次跟踪运行更新；这是宿主和下一次运行判断“上次看到什么”的依据。

## 校验

有 bash 时：

```bash
node scripts/validate_state.mjs analysis-state.json
```

没有 bash 时，按下面清单自查（与脚本检查项一致）：

- [ ] `schema_version` 是 `2.0`，`revision` ≥ 1，`stage` 合法。
- [ ] `subject.company` / `currency` / `units` 非空，`data_cutoff` 是 `YYYY-MM-DD`。
- [ ] 所有 ID 唯一；`evidence_ids` / `source_ids` / `assumption_ids` / `thesis_id` / `affected_ids` 都能解析。
- [ ] 每个 `active/weakened` 观点至少 1 条 `armed/triggered` 的 F。
- [ ] 每个 F 有 `metric`、`threshold`、`source`、`frequency`、`action`。
- [ ] 每条 S 的 `method` 合法，`result` 非空。
- [ ] 每条 V 的 `scenario` 合法，`value` 为 null 时写了 `limitations`。
- [ ] `revision > 1` 时有 `changes`，且每条 `affected_ids` 能解析。
- [ ] `tracking.thesis_status` 的键都是存在的观点。

脚本与清单都只检查结构；通过**不代表**金融判断正确。语义仍要人工或独立审核。
