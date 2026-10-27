# analysis-state.json 契约（schema 2.1）

状态文件是投资框架的**事实源**，报告是它的**视图**。跟踪运行只改状态和受影响小节，不重写整份报告。

文件放在与 `投资框架报告.md` 相同的 `exports/` 目录，名字固定为 `analysis-state.json`。手工新建时以 `assets/analysis-state.template.json` 为起点。

## 版本与兼容

- 新建框架、或对已有框架做实质更新，写 `schema_version: "2.1"`。
- `2.0` 只读兼容：校验器仍做旧版结构检查，但会提示“2.0 无法验证方法、归因与可比性”。历史文件不重写；下一次实质更新时升级到 2.1，并在 `changes` 里保留原判断。
- 升级到 2.1 时，历史 `changes` 可以保留 2.0 写法；校验器只对 `revision === 当前 revision` 的 change 强制 `kind` / `from-to` / 归因字段，旧 change 缺字段给 warning。不要为了通过校验去改写历史版本。
- 2.1 的核心变化只有一件事：**把“估值”从单个数字改成“方法 + 口径 + 驱动 + 状态”**，并把版本变化从自由文本改成可核对的结构。没有这些字段，读者无法区分“同一模型里调了假设”和“换了一个模型”。

## 顶层

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | `"2.1"` | 是 | 新建/实质更新用 `"2.1"`；历史文件可为 `"2.0"` |
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

估值也一样：**方法切换必须新建 V ID**，旧 V 保留原 `method_key` / `value`，并标 `superseded` 指向新 V。不要覆盖旧 V，否则历史版本之间失去可比性；报告仍可以把旧 V 作为对照引用，但状态上它不再是当前基准。

### evidence.kind

`model_input` / `formula` / `cached` / `actual` / `market` / `consensus` / `external_forecast` / `inference`

公式与数值不能混称同一性质；“模型预测”不是“已实现”；“一份券商模型”不是“市场共识”。

估值变化至少要有 1 条**非 `inference`** 证据；只有“人工判断偏高/偏低”不构成改估值的证据。只引用 `market` 证据时，要在归因里说明不是用现价反推。

### assumptions.kind

`model_input`（原模型直接设定）/ `model_forecast`（原模型算出）/
`research_forecast`（本次研究新增）/ `actual`（已实现）。

`value` 可为 `null`（定性假设），此时 `statement` 必须写清判断方向。

假设分两类用途，不要混：

- **公式驱动**：进入某个 `V.drivers` 的直接操作数（ARR、倍数、EPS、汇率、股数、折现率、终值增长率、净现金等）；
- **叙述/观点依赖**：支撑观点但不直接进入估值公式。

不进入公式的假设可以写进观点和风险，**不能**写进目标价变化的归因。

### valuations[] 必填（2.1）

```
id, scenario, method_key, method, output, as_of, value, unit,
multiple_basis, multiple_period, drivers[], assumption_ids,
thesis_ids, evidence_ids, formula, limitations,
status, superseded_by
```

- `scenario`：`bear` / `base` / `bull` / `reverse`。
- `method_key`：稳定的机器键，小写字母/数字/下划线，如 `dcf`、`arr_multiple`、`pe_forward_discounted`。**同一 key = 同一模型、同一输出口径、同一倍数口径**；模型或口径一变就必须换 key。
- `method`：人读的方法说明。
- `output`：`target_price` / `equity_value` / `enterprise_value` / `per_share_value`。不同 `output` 的值不能互相比较，更不能写成同一目标价序列。
- `value` 是**模型输出**，`multiple` 是**输入**。`10x → 11x` 不等于“目标价 +10%”；还要看基数、汇率、股数、净现金。
- `multiple_basis` + `multiple_period`：只要 `drivers` 里有 `multiple`，就必须写清倍数乘的是什么、哪一期，如 `ARR` + `2026E`、`EPS` + `2027E`。写“11x 2026E ARR”，不要简称“PE”；PE(TTM) 为负时 PE 根本不是可用的锚。
- `drivers`：**只列公式直接操作数**，每项 `{assumption_id, role, value, unit}`；`role` ∈ `base_metric` / `multiple` / `margin` / `fx` / `share_count` / `net_cash` / `discount_rate` / `terminal_growth` / `other`。公式里出现的每个数都要有对应的 A，包括汇率和股数。
- `assumption_ids`：该 V 依赖的全部假设，必须包含所有 `drivers` 的 A，可以再列间接依赖（如 EPS 由 ASP、产能、毛利率推出）。
- `status`：`current` / `superseded`。`superseded` 必须写 `superseded_by`，指向替代它的 V。
- 多方法并列时分别列，不自选一个加权目标价；报告要写清哪个是基准、哪个是对照，以及理由。

示例（ARR 倍数法）：

```json
{
  "id": "V3",
  "scenario": "base",
  "method_key": "arr_multiple",
  "method": "ARR 倍数法（2026E ARR × 目标倍数，折港元）",
  "output": "target_price",
  "multiple_basis": "ARR",
  "multiple_period": "2026E",
  "as_of": "2026-10-26",
  "value": 458,
  "unit": "港元/股",
  "drivers": [
    { "assumption_id": "A1", "role": "base_metric", "value": 26, "unit": "亿美元 ARR" },
    { "assumption_id": "A8", "role": "multiple", "value": 11, "unit": "x ARR" },
    { "assumption_id": "A12", "role": "fx", "value": 7.8, "unit": "HKD/USD" },
    { "assumption_id": "A13", "role": "share_count", "value": 4.876, "unit": "亿股" }
  ],
  "assumption_ids": ["A1", "A8", "A12", "A13"],
  "thesis_ids": ["T1"],
  "evidence_ids": ["E1", "E8"],
  "formula": "26 × 11 × 7.8 ÷ 4.876 ≈ 458 港元/股",
  "limitations": "倍数法是一阶近似，未做净现金/股数口径调整；与 DCF 并列，不合成",
  "status": "current",
  "superseded_by": null
}
```

### changes[] 必填（2.1）

```
id, at, revision, kind, affected_ids,
from_valuation_id, to_valuation_id, comparability, comparability_reason,
bridge[], value_before, value_after,
attribution[], combination, residual, residual_reason,
stability_note,
before, after, reason, evidence_ids, run_id
```

- `kind`：
  - `method_switch`：换了模型/基准/倍数口径；
  - `assumption_update`：同一模型里驱动值变化；
  - `correction`：算术、口径或事实错误修正；
  - `evidence_update`：只增证据、不改估值；
  - `scope`：研究范围变化；
  - `editorial`：措辞/排版。
- 任何动了估值的 change 都要写 `from_valuation_id` / `to_valuation_id`，并把这些 V 放进 `affected_ids`。
- `comparability`：同一 `method_key` 才能是 `comparable`；不同方法必须是 `not_comparable`，并写 `comparability_reason`。
- `value_before` / `value_after`：数值。被保留的旧 V 必须与 `value` 一致；同一 V 的连续 change 要首尾相接，最后一次的 `value_after` 与当前 `V.value` 一致。
- **`method_switch` 硬规则**：
  - 新 V 用新 ID；旧 V 保留原 `method_key` / `value`，标 `superseded` 且 `superseded_by` 指向新 V；
  - `comparability` 必须是 `not_comparable`；
  - 必须写 `bridge`（至少 2 项，列出方法、基准指标、倍数口径等差异）；
  - 不写 `attribution`：两个不同模型的值之间没有可加/可乘的“贡献”；
  - 报告里不能写成 `1560 → 320` 这样的目标价序列。
- **`assumption_update` 硬规则**：
  - `attribution` 覆盖 from → to 的**所有变化驱动**；
  - 每个 `assumption_id` 必须是 to V（若 from V 不同，也必须是 from V）的 `drivers` 成员；不在公式里的 A 不能作为归因；
  - `contribution` 是占起始值的比例（可负）；`combination` 是 `multiplicative`（如 ARR × 倍数）或 `additive`（如 DCF 分项）；
  - `residual` 是未解释比例；闭合误差应在 0.5% 内。未解释部分 >5% 要写 `residual_reason`，>15% 直接视为归因不完整。
- **稳定性**：同一 `at` 日期内对同一估值做反向修正，必须写 `stability_note`（为什么推翻上一版、新增了什么非推断证据、如何避免锚定现价）。没有新增非推断证据的反向修正，校验器会拦。
- `before` / `after` / `reason`：人读说明，但不能替代上面的结构字段。
- 只在有实质变化时追加。首次建框架不写 changes；措辞变化不写。

方法切换示例（DCF → ARR 倍数法）：

```json
{
  "id": "C2",
  "at": "2026-10-26",
  "revision": 3,
  "kind": "method_switch",
  "affected_ids": ["V1", "V2", "A1", "A8"],
  "from_valuation_id": "V1",
  "to_valuation_id": "V2",
  "comparability": "not_comparable",
  "comparability_reason": "V1 是 DCF 输出，V2 是 2026E ARR × 倍数；两者的基准、倍数口径和公式都不同，不能分解为同一目标价的涨跌。",
  "bridge": [
    { "factor": "方法", "from": "高盛 DCF", "to": "ARR 倍数法" },
    { "factor": "基准指标", "from": "DCF 现金流/终值", "to": "2026E ARR 20 亿美元" },
    { "factor": "倍数口径", "from": "叙述中的 12x（不进入 DCF 公式）", "to": "10x 2026E ARR" }
  ],
  "value_before": 1560,
  "value_after": 320,
  "before": "DCF base 1560",
  "after": "ARR 倍数法 base 320",
  "reason": "模型内嵌图片导致 DCF 表读取失败；改用 ARR 倍数法，DCF 参数待修复后复核",
  "evidence_ids": ["E1", "E2"],
  "run_id": "manual-20261026"
}
```

同方法假设更新示例（320 → 458）：

```json
{
  "id": "C3",
  "at": "2026-10-26",
  "revision": 4,
  "kind": "assumption_update",
  "affected_ids": ["V2", "A1", "A8"],
  "from_valuation_id": "V2",
  "to_valuation_id": "V2",
  "comparability": "comparable",
  "value_before": 320,
  "value_after": 458,
  "attribution": [
    { "assumption_id": "A1", "from": 20, "to": 26, "contribution": 0.30 },
    { "assumption_id": "A8", "from": 10, "to": 11, "contribution": 0.10 }
  ],
  "combination": "multiplicative",
  "residual": 0.001,
  "before": "2026E ARR 20 亿美元、10x",
  "after": "2026E ARR 26 亿美元、11x",
  "reason": "ARR 由 20 调至 26（+30%），倍数由 10x 调至 11x（+10%）；两者合计 1.43x",
  "evidence_ids": ["E8", "E9"],
  "run_id": "manual-20261026"
}
```

注意：这个例子里没有 A3（利润率）。ARR 倍数法的公式是 `ARR × 倍数 × 汇率 ÷ 股数`，利润率不进入公式；它可以解释观点，但不能解释 320→458。

### model.checks[] 必填

```
id, item, result, note, reason, locator, attempted, gap_ids
```

- `result`：`pass` / `difference` / `plug` / `unverified`。
- `reason`（`unverified` 时必填）：`tool_failure` / `source_missing` / `not_disclosed` / `not_attempted`。
- `locator`：实际检查的 sheet/单元格/页码。
- `attempted`：试过什么读取路径/方法。
- **工具失败不是来源事实**：
  - 解析报错、超时、图片/公式损坏导致读不到，记 `tool_failure` + `gap_ids`（对应 `gaps.kind = "tool"`）；
  - 不得在 `item` / `note` 里写“未披露”。只有成功读取到空值/硬编码，才能记 `not_disclosed`；
  - 修复读取路径后要回到原模型复核，不能把失败期间的替代口径永久留下。
- 模型含 DCF 表且参数可读时，不得以“未披露”为由放弃 DCF；确要改用倍数法，按 `method_switch` 记录，并保留 DCF 的未解决 gap。

### gaps[] 必填

```
id, question, impact, evidence_needed, kind, status, resolution
```

- `kind`：`data` / `tool` / `method` / `scope`。工具失败用 `tool`。
- `status`：`open` / `resolved` / `accepted`。`resolved` 要写 `resolution`。
- 被 `model.checks[].gap_ids` 引用的 tool gap，必须是 `kind: "tool"`；未修复前保持 `open`。

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
- 允许定性失效条件（`threshold` 写"事件发生"），但必须写清核验方式与数据源；`unknown` 要写明缺什么。

### sensitivities[] 必填

```
id, assumption_ids, method, baseline, perturbation, result,
affects, evidence_ids, fixed_conditions, limitations
```

- `method`：`model_input`（扰动模型真正独立的输入，沿公式传播）/ `price_condition`（给定 EPS、倍数的价格对照）/ `scenario`（一致情景组合）。
- `affects`：受影响的 `valuations` 或 `theses` ID。
- `result`：方向 + 幅度 + 单位；不能只写“敏感”。
- `price_condition` 不能替代 `model_input` 测试，也不能用来通过“真正输入”验收。
- 不进入某个 V 的 `drivers` 的假设，不能写成该 V 的估值敏感性；只能作为观点/情景说明，并在 `limitations` 写清。

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

- [ ] `schema_version` 是 `2.1`（历史文件可为 `2.0`），`revision` ≥ 1，`stage` 合法。
- [ ] `subject.company` / `currency` / `units` 非空，`data_cutoff` 是 `YYYY-MM-DD`。
- [ ] 所有 ID 唯一；`evidence_ids` / `source_ids` / `assumption_ids` / `thesis_id` / `affected_ids` 都能解析。
- [ ] 每个 `active/weakened` 观点至少 1 条 `armed/triggered` 的 F。
- [ ] 每个 F 有 `metric`、`threshold`、`source`、`frequency`、`action`。
- [ ] 每条 S 的 `method` 合法，`result` 非空。
- [ ] 每条 V 有 `method_key` / `output` / `status` / `drivers`；有 `multiple` 驱动时有 `multiple_basis` + `multiple_period`；`drivers` 的 A 都在 `assumption_ids` 里。
- [ ] 每条 V 的 `value` 为 null 时写了 `limitations`。
- [ ] 当前 revision 的 change 有 2.1 字段（`kind` / `from-to` / 归因等）；历史 change 可保留旧写法并给 warning，不重写历史。
- [ ] 动了估值的 change 有 `from/to`、`comparability`、`value_before/after`。
- [ ] `method_switch` 有新 V、旧 V 标 `superseded` 且保留原值、`bridge`、`not_comparable`；没有 `attribution`。
- [ ] `assumption_update` 的 `attribution` 只引用 V 的 `drivers`，且乘/加闭合，残差有说明。
- [ ] 估值变化至少引用 1 条非 `inference` 证据；同日反向修正有 `stability_note` 和新增非推断证据。
- [ ] `model.checks` 的 `unverified` 有 `reason`/`locator`/`attempted`；`tool_failure` 有 `gap_ids`，且没有写成“未披露”。
- [ ] `revision > 1` 时有 `changes`，且每条 `affected_ids` 能解析。
- [ ] `tracking.thesis_status` 的键都是存在的观点。

脚本检查的是**结构一致性**：方法身份、驱动引用、归因闭合、可比性、证据类型、稳定性。它不能替你判断假设本身对不对；通过不代表金融判断正确。

## 常见错误（会拦）

| 写法 | 为什么错 | 正确做法 |
|---|---|---|
| `1560 → 320 → 458` 写成连续目标价 | DCF 与 ARR 倍数法不是同一模型 | 分列估值，标 `not_comparable`，写 `bridge` |
| 方法切换后把新值写回原 V | 旧方法的值被覆盖，历史不可复核 | 新建 V；旧 V 标 `superseded`，保留原值供对照 |
| `320→458` 只写“倍数 10→11” | 遗漏 ARR 20→26，归因不闭合 | `attribution` 覆盖全部变化驱动，`residual` 说明 |
| 把 A3 利润率列为 320→458 的原因 | A3 不在 V 的 `drivers`，不进入公式 | 只写观点/风险，不作为估值归因 |
| `11x` 写成 `PE` 或“目标价 +10%” | 倍数是输入，目标价是输出，口径未定义 | 写 `11x 2026E ARR`，列 ARR/倍数/汇率/股数贡献 |
| DCF 解析失败写成“未披露” | 工具失败被误判成来源缺失 | `tool_failure` + `gap_ids`，修复后回 DCF |
| 同日两次反向修正，只写“人工判断” | 没有新增硬数据，容易锚定现价 | 补非推断证据 + `stability_note`，否则标 `needs_review` |
