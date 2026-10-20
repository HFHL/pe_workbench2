# 投资框架 Skill：从“写报告”到“可跟踪的判断台账”

> 状态：已实现。`investment-framework`（形成）+ `framework-update`（跟踪）。
> 相关实现：`lib/tracking.mjs`、`tracking.js`、`tracking.css`、`suggestions.js`、`scripts/test-framework-state.mjs`。
> 相关文档：[tracking-timer.md](tracking-timer.md)、[next-actions.md](next-actions.md)。

---

## 1. 要解决的问题

原来的框架流程只有一份 Markdown 报告。报告写得再完整，到了定期跟踪时仍然只能“重读一遍、凭感觉改”，因为没有东西告诉跟踪运行：

- 这份报告到底有几个**观点**？
- 每个观点依赖哪些**假设**？
- 做过哪些**敏感性**，扰动的是哪个输入？
- 什么情况下算**错了**？阈值、来源、频率是什么？

所以这次改动的核心不是“把七节写得更细”，而是给框架加一份**机器可读的事实源**，并让跟踪运行围绕它工作。

```text
模型/资料
   ↓
analysis-state.json  ←── 事实源（观点、假设、敏感性、失效条件、证据、版本）
   ↓
投资框架报告.md       ←── 七节视图，正文用 ID 引用
   ↓
跟踪运行（framework-update）
   ↓
逐条核对 F → 改 T 状态 → 更新 A/S/V → 回写状态 + 报告
   ↓
结果 JSON：观点状态 + 触发的失效条件 + 关键数字 + 依据
```

## 2. 对象模型

| 对象 | ID | 作用 | 跟踪时怎么用 |
|---|---|---|---|
| 观点 | `T1…Tn` | 一条可检验的投资逻辑 | 有状态：active / weakened / invalidated / confirmed / retired |
| 假设 | `A1…An` | 观点依赖的模型输入或研究假设 | 输入变了，沿依赖重算 |
| 敏感性 | `S1…Sn` | 对某个独立输入的扰动 | 说明哪个假设真正影响估值 |
| 失效条件 | `F1…Fn` | 什么情况下观点算错 | **跟踪的最小单元**，每条独立核对 |
| 估值 | `V1…Vn` | bear / base / bull / reverse | 假设变化后重算 |
| 证据 | `E1…En` | 一条可定位的事实 | 只评价“现在是否仍成立” |
| 来源 | `SRC1…` | 文件、公告、行情、研报 | 证据的出处 |
| 缺口 | `G1…Gn` | 还不知道什么 | 跟踪时若到期仍缺，标 `unknown` |
| 变化 | `C1…Cn` | 版本差异 | 与 `revision` 一一对应 |

关键约束（校验器会拦）：

- 每个 `active/weakened` 观点至少一条 `armed/triggered` 的失效条件。
- 每个失效条件必须绑定观点，且有指标、阈值、来源、频率、动作。
- `stage=reviewed` 时，观点必须有反面证据。
- 所有 ID 全局唯一、跨版本稳定；失效观点标 `retired`，不复用 ID。

## 3. 七节怎么映射

七节保留，但每节都对应状态对象，不再是一段自由文本：

| 节 | 状态对象 |
|---|---|
| 1 研究设定 | `subject` |
| 2 当前判断 | `valuations`、`changes` |
| 3 模型与经营驱动 | `model.understanding`、`model.checks`、`A` |
| 4 观点台账 | `T` + `E` |
| 5 估值、敏感性与回报 | `V`、`S`、`market` |
| 6 失效条件与监控 | `F` |
| 7 证据、缺口与版本变化 | `E`、`G`、`C`、`review` |

报告可以自由写，但**不能出现状态里没有的实质性判断**；反过来，状态里的每个观点都要在第四节有一小节。

## 4. 为什么失效条件是原子单位

观点会变，但“什么情况下算错”是稳定的、可执行的。把 F 做成顶层对象有三个好处：

1. 跟踪运行时可以逐条遍历，不依赖模型自由发挥；
2. 阈值、来源、频率写在同一处，避免报告里写一套、执行时另一套；
3. 结果 JSON 可以直接汇报“哪条失效条件触发了”，界面不用解析自然语言。

写法见 `investment-framework/references/monitoring-design.md`：三类信号（单期偏差 / 持续偏离 / 机制推翻）、阈值依据、频率匹配、按商业模式选指标。

## 5. 跟踪闭环

`framework-update` 的执行顺序是固定的：

1. 读状态和报告，建立基线（`revision`、`data_cutoff`、观点清单）。
2. 按 F 的 `source` / `frequency` 取数，而不是全量抓数据。
3. 先核对 F：`observed`、`triggered`、`unknown`，更新 `last_checked_at`。
4. 再改 T：只有证据支持才改状态，写清证据 ID 与 F ID。
5. 沿依赖改 A → S → V，只动受影响的部分。
6. 写状态（临时文件 + 替换），`revision` 仅在实质变化时 +1，追加 `changes` 和 `tracking` 游标。
7. 最小补丁改报告，末尾追加 `## 跟踪记录`。
8. 写结果 JSON，必须包含 `theses` 与 `invalidations`。

结果页的展示顺序因此变成：

```text
结论（目标价/判断有没有变）
  → 观点状态（T1 成立中 / T2 减弱 / …）
  → 失效条件核对（哪条触发、观察值、动作）
  → 判断变化
  → 为什么调整
  → 写回了什么
```

## 6. 结果契约

宿主读取 `.tracking/<tracking_id>/<run_id>.json`，经 `normalizeTrackingResult` 归一化后存库。新增两个字段：

```json
"theses": [
  { "id": "T1", "statement": "…", "status": "weakened",
    "change": "降级", "note": "F2 触发：库存 12.6 周" }
],
"invalidations": [
  { "id": "F2", "thesis_id": "T1", "condition": "库存 > 12 周",
    "observed": "12.6 周", "triggered": true, "action": "下调 A1，重算 V1" }
]
```

归一化规则：

- `theses` 过滤掉没有 `id` 的脏数据，状态非法时回退 `active`。
- `invalidations` 的 `triggered` 统一转布尔，触发的排在前面。
- 缺省为空数组，旧结果 JSON 不受影响。

## 7. 文件清单

```
skills/                                  # 仓库级，随产品分发
├── investment-framework/
│   ├── SKILL.md
│   ├── references/state-contract.md      状态字段逐项契约
│   ├── references/report-template.md     七节报告模板
│   ├── references/monitoring-design.md   失效条件设计
│   ├── assets/analysis-state.template.json
│   ├── assets/analysis-state.example.json
│   └── scripts/validate_state.mjs
└── framework-update/
    ├── SKILL.md
    ├── references/run-contract.md         结果 JSON 契约
    └── references/update-rules.md         什么算实质变化、按对象怎么改
```

Skill 分两层：

- `skills/`（仓库级）：产品内置，`server.mjs` 通过 `additionalSkillPaths` 注入，所有项目可用；
- `projects/<id>/.agents/skills/`（项目级）：单个项目的自定义 Skill，用来覆盖或补充产品内置能力。

`server.mjs` 的 `isProjectSkill` 只加载上述两处与 `.pi-agent/skills`，用户级 `~/.agents/skills` 仍被过滤，避免全局技能干扰路由。

## 8. 校验与测试

状态校验：

```bash
node skills/investment-framework/scripts/validate_state.mjs \
  projects/p-c1db281e/exports/.../analysis-state.json
```

检查项：schema、必填字段、ID 唯一、引用可解析、观点与失效条件配对、阶段规则、日期格式、`revision`/`changes` 一致性。**不检查金融语义**。

自测：

```bash
node scripts/test-framework-state.mjs
```

覆盖：示例通过、空模板被拦、悬空引用被拦、缺失效条件被拦、`revision>1` 只警告、结果归一化（过滤脏数据、排序、缺省）。

## 9. 设计取舍

- **保留七节，但不把七节当数据库**：七节是人读的视图，状态才是跟踪读的事实源。用户说“不限制七节”也可以，但对象模型不能省。
- **不追求自动改判**：跟踪只做核验与建议；观点失效、参数修改仍需要证据与（重大时）人工确认。
- **不做“概率打分”**：置信度用高/中/低 + 证据质量解释，避免伪精确。
- **不把价格当经营信号**：股价只进 `market` 与回报路径；经营失效条件用经营指标。
- **旧报告可迁移**：没有状态文件时，`investment-framework` 支持“由报告回溯补建”，标 `draft` 和 `inference`，核验后再升级。

## 10. 下一步

1. 用 `investment-framework` 对 `projects/p-c1db281e/exports/investment-model/高盛-长鑫-Model-20260904/投资框架报告.md` 跑一次“补建状态”，生成 `analysis-state.json`。
2. 在界面上给该报告建立跟踪（每周/每月，按 F 的频率）。
3. 首次运行后检查：结果页是否出现“观点状态”和“失效条件核对”，以及报告末尾是否追加了跟踪记录。
