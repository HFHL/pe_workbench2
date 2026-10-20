# 更新规则

跟踪更新与原分析的区别：原分析可以重写，跟踪只能**增量修正**。下面这些规则用来决定“改不改、改哪、改完怎么记”。

## 什么算实质变化

| 变化 | 实质？ | 处理 |
|---|---|---|
| 观点状态变化（active → weakened 等） | 是 | 写 `changes`，`revision + 1` |
| 假设值或方向变化 | 是 | 写 `changes`，重算受影响敏感性/估值 |
| 估值或目标价区间变化 | 是 | 写 `changes`，更新第 2/5 节 |
| 失效条件触发或解除 | 是 | 更新 F 状态，写 `changes` |
| 新增观点、证据推翻替代解释 | 是 | 新 ID，写 `changes` |
| 只补一条支持证据、结论不变 | 否 | 追加 evidence，不升 revision |
| 措辞、排版、来源表述调整 | 否 | 不改状态，不写 changes |
| 只更新股价 | 否 | 只更新 `market`，不改估值 |

判断标准：**是否改变了对未来现金流或判断的信心**。只改变叙述方式不算。

## 按对象更新

### 假设 A

- 保留 ID；改值写 before/after，并在 `changes.reason` 说明证据。
- 新增假设用新 ID；旧假设不再使用标 `status: retired`，不删。
- 不把“实际值”直接替换成模型输入；新增 `kind: actual` 的证据，保留原预测。

### 敏感性 S

- 只有上游输入变化或方法变化才重算。
- 重算时写清基准、扰动、固定条件、复算范围；沿用原公式，不临时换口径。
- 价格条件对照（`price_condition`）不能因为股价变了就重算成“经营敏感性”。

### 估值 V

- 假设变化 → 重算受影响情景；方法变化需单独说明理由。
- 只更新价格不算估值更新；`market.price` 与 `V.value` 分开。
- 多方法并列时逐个更新，不合成加权目标价。

### 观点 T

- 状态只能按证据改：`active` / `weakened` / `invalidated` / `confirmed` / `retired`。
- 改状态必须同时写 `status_note`（或结果里的 `note`），指出证据 ID 与失效条件 ID。
- 观点失效后保留原文与历史，不删除、不复用 ID。

### 失效条件 F

- 每期都更新 `last_observed` / `last_checked_at`，即使没触发。
- 触发后执行 `action`，并在下一次运行前保持 `triggered`，直到观点处理完毕。
- 阈值需要调整时，写清依据；不要因为“快触发了”就放宽阈值。

## revision 与 changes

- `revision` 只在有实质变化时 +1，且必须与 `changes` 条目一一对应。
- `changes` 每条：`id, at, revision, affected_ids, before, after, reason, evidence_ids, run_id`。
- `affected_ids` 指向真正被改的对象，不要把所有 ID 都列上。
- 首次版本没有 changes；跟踪第一次运行如果只是建基线，用 `no_change`，不升 revision。

## 证据冲突

- 两个来源矛盾：都保留，标 `limitations`，在 `gaps` 写“待哪份数据裁决”。
- 新证据推翻旧证据：旧证据不删，标 `superseded_by`（写在 limitations 里），changes 记录原因。
- 口径不一致（合并/单体、单季/累计、汇率）：先统一口径再比较；无法统一就并列，不混算。

## 没有状态文件时

不要现场编一份 `analysis-state.json` 冒充历史。先判断目标是不是投资框架：

- 是（有观点、假设、失效条件结构）：按报告现有结构做最小复核，只更新受影响的小节；`theses` / `invalidations` 可以留空，但 `summary` 要说明“未建立状态文件，无法逐条核对观点”，`status` 用 `needs_review`，建议先跑一次 `investment-framework` 补建状态。
- 不是（一般文档、会议纪要、行情表）：按通用文件刷新处理，正常输出 `updated` / `no_change`，不要强行套状态契约。

## 报告 patch 边界

- 只改第 2、4、5、6、7 节中受影响的小节；第 1、3 节除非模型或对象变了，否则不动。
- 保留所有 ID、标题层级和表格列；新增行追加在表尾。
- `## 跟踪记录` 只追加，不覆盖；不删除历史记录。
- 写回前确认目标路径就是宿主给的那个，不新建副本。

## 输出前的自检

- [ ] 每个 `active/weakened` 观点都有本期核对记录。
- [ ] 每条 `armed` F 都有 `last_observed` 或 `unknown` 说明。
- [ ] 结果 JSON 的 `theses` 覆盖全部观点。
- [ ] `changes` 与 `revision` 一致。
- [ ] 报告与状态没有互相矛盾的数字。
- [ ] 未验证项写进了 `notUsed` 或 `writeback.note`。
