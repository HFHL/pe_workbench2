# 更新流程：现状分析与重构方向

> 状态：**分析稿（2026-10-20），未改代码。**
> 范围：产出文件的“更新”链路，包括**定时/手动跟踪运行**与会话内的**复核投资框架**。
> 不包含“形成框架”（`investment-framework`）本身；它是更新流程的上游，负责产出 `analysis-state.json` 与报告。
> 相关：[tracking-timer.md](tracking-timer.md)、[investment-framework-skill.md](investment-framework-skill.md)、[foundation.md](foundation.md)。
> 后续设计：[auto-update.md](auto-update.md)（自动更新、分级自治与主动通知）。

---

## 0. 结论

现在的“更新”不是一条流程，而是三套并行规则叠在一起：

1. **模板 prompt**（`lib/tracking.mjs`）定义 agent 做什么、写回哪里、结果 JSON 长什么样；
2. **Skill**（`framework-update` / `investment-framework`）定义怎么核对观点、怎么改状态；
3. **宿主结算**（`server.mjs`）定义什么算成功。

三者都能单独改，彼此没有强约束。宿主真正验证的只有两件事：**目标文件版本有没有 +1**、**结果 JSON 能不能解析**。至于“观点状态是否真的按失效条件改了”“状态文件是否合法”“报告和状态是否一致”，全部依赖 agent 自述。

这带来三个直接后果：

- 结果页可以显示“updated”，但目标文件没有新版本；
- 结果里的 `theses` / `invalidations` 与 `analysis-state.json` 没有交叉校验，界面却写着“与状态文件对应”；
- 当前工作区里的 `投资框架报告.md` 没有 `analysis-state.json`、也不是七节结构，但跟踪流程仍会按“逐条核对 F”的方式启动，最后只能退化成“重读一遍报告 + 标 needs_review”。

**重构的核心不是再加一个模板，而是把一次更新变成显式的 run：意图 → 准备 → 取证 → 评估（变更计划）→ 应用 → 宿主验收 → 提交。** 只有“计划”和“验收”变成机器可读的产物，模板、Skill、UI 才能共用一份契约。

---

## 1. 现状：两条更新路径

| | 跟踪运行（主路径） | 会话内复核（建议入口） |
|---|---|---|
| 入口 | 跟踪面板 / 文件详情“加入跟踪” / 立即运行 / 30s 调度器 | 输入框上方“复核投资框架”建议，或用户直接输入 |
| 实现 | `POST /api/trackings/:id/run` → 内部 Pi 会话 | 普通聊天会话 |
| 是否备份 | 是（`in_place` 模板） | 否 |
| 是否产生版本 | `in_place` 同路径 v+1 | 只有 agent 主动写文件时才有 |
| 是否有结果契约 | 是（`.tracking/<id>/<run>.json`） | 否 |
| 是否有运行记录 | 是（`tracking_runs`） | 否 |
| 是否可审计 | 部分（只有版本 + 自述 JSON） | 基本不可审计 |

两条路径都在改同一份状态文件与报告，但只有一条有宿主兜底。用户从建议入口做一次“更新”，和从跟踪入口做一次“更新”，得到的结果形态、备份、版本、记录完全不同。

---

## 2. 现状：一次跟踪更新怎么走

### 2.1 链路

```text
建立跟踪（文件 + 时间 + 模板）
  → 30s 调度器 / 立即运行
  → runTracking：基线版本、备份、内部会话、拼 prompt
  → Agent：读 state/report → 拉数据 → 核对 F → 改 T/A/S/V
           → 写 analysis-state.json → 改报告 → 追加「## 跟踪记录」
           → 写 .tracking/<tracking_id>/<run_id>.json
  → agent_settled
  → settleTrackingRun：等 320ms → 比版本 → 定状态 → 归一化 → 落库
  → SSE → 跟踪卡片 / 结果页 / 版本历史
```

### 2.2 分阶段与实现位置

| 阶段 | 做什么 | 实现 |
|---|---|---|
| 建立跟踪 | 一个文件只允许一个跟踪；`in_place` 模板只允许 `exports/`；模板默认按扩展名匹配 | `tracking.js:442-643`、`server.mjs:1547-1580`、`store.mjs:746-770` |
| 调度 | 30s tick，`lease_until` 防并发，每个 tick 最多启动一个 run | `server.mjs:1067-1109`、`store.mjs:865-889` |
| 准备 | 取基线版本；`in_place` 备份到 `backups/<timestamp>-<runId>/`；创建 `[跟踪]` 内部会话；拼 prompt | `server.mjs:957-1030`、`server.mjs:803-812`、`server.mjs:620-658` |
| Prompt | 工作空间索引（最多 80 个文件）、5 条硬规则、按模板的领域规则、结果 JSON schema | `lib/tracking.mjs:115-249`、`server.mjs:933-955` |
| 执行 | Agent 加载 `framework-update`，读状态与报告，用工具取证，改状态、改报告、写结果 | `skills/framework-update/SKILL.md` |
| 结算 | `agent_settled` 后等 320ms；比较目标文件版本；按结果和版本定状态；归一化；写 `tracking_runs`；推进 `next_run_at` | `server.mjs:823-931`、`lib/tracking.mjs:351-413`、`store.mjs:824-854` |
| 展示 | 结论 → 观点状态 → 失效条件 → 判断变化 → 原因 → 写回 → 来源 → 运行记录 | `tracking.js:717-860` |

### 2.3 分层职责（现在实际是什么）

| 角色 | 负责 | 不负责 |
|---|---|---|
| UI | 选文件、选时间、展示结论 | 不理解更新语义 |
| 模板 prompt | 目标路径、写回模式、领域规则、结果 schema | 不验证结果 |
| Skill | 观点/失效条件的核对方法、状态迁移规则 | 不知道宿主是否验收 |
| 宿主 | 备份、版本、解析 JSON、推进计划 | 不检查状态文件与结果是否一致 |
| Agent | 取证、判断、改文件、汇报 | 自己的汇报同时被当成“事实” |

一句话：**Agent 既执行更新，又提供更新成功的证据；宿主只检查“文件确实动过”。**

---

## 3. 规则与契约现在放在哪

| 关注点 | 现在写在 | 问题 |
|---|---|---|
| 模板元数据 / 写回模式 | `lib/tracking.mjs:12-34`，UI 又复制一份 `tracking.js:23-65` | 两份定义；`model` 标签写“生成更新副本”，实际不生成副本 |
| 模板选择 | `lib/tracking.mjs:39-44`、`tracking.js:273-278`、`server.mjs:1560-1564` | 按扩展名：所有 `.md` 默认“投资框架复核” |
| 实际执行的 prompt | `lib/tracking.mjs:115-249` | 很长、同时承担“上下文注入 + 规则 + schema”三种职责 |
| UI 里的“内置更新逻辑”预览 | `tracking.js:23-65` | 是旧版简化 prompt，**不是实际执行的 prompt** |
| 更新语义 | `framework-update/SKILL.md` + `references/update-rules.md` + prompt 的领域规则 | 同一套规则写三遍，已经开始漂移 |
| 状态契约 | `investment-framework/references/state-contract.md` + `scripts/validate_state.mjs` | 校验器存在，但运行时不会调用 |
| 结果 schema | prompt（`lib:205-248`）、`references/run-contract.md`、`docs/tracking-timer.md` §5.3 | 三份不一致：字段名（`notUsed` / `not_used`）、`schema` 字段、`reasons` 结构都不同 |
| 写回验收 | `server.mjs:823-931` | 只有版本号与 JSON 解析 |
| 结果展示 | `tracking.js:717-860`、`lib/tracking.mjs:351-413` | 展示依赖 agent 自述，缺字段时静默降级 |

---

## 4. 现状问题

### 4.1 P0：会让结论不可信

**1）状态判定与文档冲突：说 updated 但没有新版本，仍算 updated。**

`server.mjs:851-859`：

```js
else if (rawResult?.status === "updated" || versionIncreased) status = "updated";
```

只要 agent 在 JSON 里写 `updated`，即使目标文件没有产生新版本，最终状态还是 `updated`；随后 `result.writeback.version` 被写成“未产生新版本”（`server.mjs:894`）。

但文档承诺的是相反的行为（`docs/tracking-timer.md` §3.2 第 6 步：“若 Agent 说 updated 但没有新版本 → needs_review”）。结果是同一张结果页可以同时出现“本期结论”和“未产生新版本”，审计上无法区分“真的写了”和“只写了结果 JSON”。

**2）结果 JSON 与 `analysis-state.json` 没有交叉校验。**

`theses` / `invalidations` 只来自 agent 写的结果文件（`lib/tracking.mjs:351-413`），宿主从不读 `analysis-state.json`。因此：

- 结果里的 `T2` 可以不存在于状态文件；
- `F2.triggered=true` 可以不等于状态文件里的 `falsifiers[].status`；
- 状态文件可以完全没更新，结果页仍然显示“观点状态”。

UI 文案却写着“与状态文件对应”（`tracking.js:762`）。这是当前更新流程最实质的审计缺口。

**3）结构校验器没有接入运行时。**

`validate_state.mjs` 只在 `scripts/test-framework-state.mjs` 里被调用。运行时：

- 工具列表没有 bash（`server.mjs:74`），prompt 里“若当前会话有 bash，可跑 node …”不会生效；
- 宿主也不在结算阶段调用校验器；
- prompt 里注入的校验脚本路径只出现在测试断言里。

所以 `revision` 与 `changes` 不一致、ID 悬空、观点缺少失效条件，都可以直接落库。

**4）没有状态文件也能按“逐条核对 F”启动。**

`framework` 模板只检查“报告是不是投资框架”，没有硬门槛。当前工作区就是反例：

- `projects/p-c1db281e/exports/investment-model/高盛-长鑫-Model-20260904/投资框架报告.md` 存在；
- 同目录没有 `analysis-state.json`；
- 报告是“结论 / 假设 / 敏感性 / 失效条件 / 行业对标 / 完整框架”六节结构，不是 Skill 要求的七节。

`investment-framework` Skill 明确要求“已有报告但没有状态时，先补建状态，不要直接让跟踪去猜”。但跟踪运行的实现没有“补建状态”这个模式，只能由 agent 在 prompt 里自行判断并标 `needs_review`。第一轮更新因此不是“复核”，而是“边建基线边复核”，结论不可比。

**5）没有超时 / 看门狗。**

一次 run 只有 `agent_settled` 才会结算（`server.mjs:1029-1032`）。如果会话卡住、工具挂起或事件丢失：

- `tracking_runs` 永远停在 `running`；
- `listDueTrackings` 用 `not exists (... status='running')` 排除它（`store.mjs:872-875`），该跟踪从此不再自动运行；
- `recoverTrackingRuns` 只在服务重启时救命（`store.mjs:856-863`）。

没有 `max_runtime`、没有成本上限、没有失败重试策略。文档里列的这些约束目前仍是设计项。

**6）写回边界只靠 prompt，宿主不验证。**

`blockOutsideProject` 只拦“项目外路径”（`server.mjs:522-530`）。以下都只写在 prompt 里，没有验收：

- 只能改目标路径、不能建 `*-v2.md` 副本；
- 必须在文末追加 `## 跟踪记录`；
- `data_cutoff` 不能倒退；
- 报告与状态文件的数字、状态必须一致。

以上任何一条不满足，宿主都看不出来。一次 run 里如果 agent 多次写报告，还会产生多个 material 版本，而结果只指向最后一个版本，run 与版本之间没有完整映射。

### 4.2 P1：语义与覆盖

**7）模板契约三处漂移，UI 预览还是旧的。**

- `model` 模板在 UI 和 `lib/tracking.mjs:20-26` 都写“生成更新副本”，但实际 prompt 只要求 `update-plan.json` / `change-log.md`，不生成副本（`lib/tracking.mjs:160-165`）；文档 §5.5 也说不生成副本。用户看到的是第三种说法。
- `tracking.js:23-65` 的“查看内置更新逻辑”是硬编码的旧 prompt：没有工作空间索引、没有 `theses` / `invalidations`、没有结果 schema，和实际执行内容完全不同。
- 结果 schema 在 prompt、`run-contract.md`、`docs/tracking-timer.md` §5.3 三处字段不一致。

这会让排障时无法判断“agent 到底看到了什么”。

**8）模板按扩展名选，而不是按产物语义选。**

所有 `.md` 默认 `framework`（`lib/tracking.mjs:39-44`、`tracking.js:273-278`）。普通报告、会议纪要、周报都会被套上“失效条件 / 观点状态”的规则；`generic` 只能手动选。更合理的判断依据是“同目录有没有 `analysis-state.json`、正文有没有 T/F 结构”，而不是后缀。

**9）`needs_review` 没有闭环。**

结果页会显示“等待确认”，但没有确认、应用、驳回、重新运行的入口（API 只有 create / toggle / run / schedule / delete）。对 `model` 模板来说，这意味着每次更新都停在“已生成变更计划”，流程永远不结束。

**10）会话内更新绕过整套契约。**

`suggestions.js:209-212` 的“复核投资框架”只填一段自然语言 prompt：

- 没有备份；
- 没有运行记录；
- 没有结果 JSON；
- 不保证状态与报告一致；
- 结果形态和跟踪页完全不同。

同一次“更新”，从两个入口做，得到两种审计质量。

**11）Skill 与 prompt 重复定义同一套语义。**

`framework-update/SKILL.md` 有 8 步执行顺序，`lib/tracking.mjs` 的 `domainRules` 又写了 7 条，`update-rules.md` 再写一遍对象级规则。三处已经开始出现细节差异（例如报告 patch 的边界、何时升 `revision`）。维护时要同时改三处，且没有测试能发现漂移。

**12）种子失效，演示链路不可复现。**

`store.mjs:891-929` 的种子指向：

- `exports/investment-model/长鑫存储高盛模型/投资框架报告.md`
- `uploads/1792400627391-高盛-长鑫-Model-20260904.xlsx`
- `.../同行行情.md`

当前 `materials` 里没有这些路径，`trackings` 为 0。且 `seedTrackings()` 在启动时无条件调用（`server.mjs:232`），不受 `WORKBENCH_SEED` 控制。文档里“已验证 v1→v4”的链路，在新安装上无法复现。

### 4.3 P2：体验与文档

- **结果降级太安静**：agent 没写结果 JSON 时，`fallbackTrackingResult` 只保留最终回复摘要，观点和失效条件为空；界面仍按完整结果页渲染，用户看不出“这次没有结构化验收”。
- **结果契约缺版本信息**：没有 `template_version` / spec 版本 / `run_id`，无法解释“为什么上周和这周同一份报告，行为不同”。文档自己也说模板应该版本化。
- **`baseline` 状态名存实亡**：文档、归一化都允许 `baseline`，但代码从不产生它；`needs_review` 与 `baseline` 的边界没有定义。
- **成本与错过运行没有实现**：token/cost 不记录，服务停机期间到点的运行只是延后，没有补跑策略或提示。
- **文档重复且互相引用**：`tracking-timer.md`（30k）、`investment-framework-skill.md`、两个 Skill 的 references 都在描述同一套流程；`tracking-timer.md` §1.1 仍说 Excel 生成更新副本，§5.3 仍是旧结果 schema。

---

## 5. 根因

1. **三代设计叠加**：P0 先做“调度 + prompt + 版本”（`tracking-timer.md`），随后加“状态文件 + Skill”，最后又给结果页补 `theses` / `invalidations`。每一代都新增一份契约，没有回收上一代。
2. **契约是散文，不是代码**：规则写在 prompt 和 Skill 里，验收写在 server 的一小段 if 里；三者没有共享的 schema 或测试。
3. **没有“变更计划”这个中间产物**：因为没有 plan，宿主验收时没有可 diff 的对象，只能退回“看版本号 + 信任 JSON”。
4. **模板选择依据错了**：按文件扩展名选更新语义，而不是按“这个产物有没有状态、是否可跟踪”选。
5. **更新入口分裂**：聊天入口和跟踪入口各有一套行为，只有跟踪入口有宿主兜底。

---

## 6. 重构方向：把更新做成显式 run

### 6.1 设计原则

1. **一个 run 对象**：无论手动、定时、会话触发，都产生同一种 run，有基线、计划、验收、结果。
2. **计划与执行分离**：先产出 `change-plan.json`，再应用；`model` 只到计划，`framework` / `generic` 计划通过后应用。
3. **Agent 提供判断，宿主验证事实**：观点状态、理由由 agent 给；版本、状态文件合法性、F/T 对应、截止日、写回范围由宿主验。
4. **状态是事实源，报告是视图，结果是派生**：结果页的 `theses` / `invalidations` 从校验后的状态文件生成，不再由 agent 另写一份。
5. **失败必须显式**：`needs_review` 是一个有待办动作的状态，不是终点；验收失败不能显示 `updated`。

### 6.2 目标流程

| # | 阶段 | 谁 | 产出 | 通过条件 |
|---|---|---|---|---|
| 0 | 解析 Resolve | 宿主 | 目标、模板、模式（`baseline` / `recheck` / `refresh` / `migrate`）、写回策略、spec 版本 | `in_place` 只能是 `exports/`；`framework` 必须有状态，否则进入 `migrate` |
| 1 | 准备 Prepare | 宿主 | 基线快照（版本、sha、`revision`、`data_cutoff`）、备份、run 目录、本期到期的 F 列表 | 基线可读；备份成功；同一目标无并发 run |
| 2 | 取证 Evidence | Agent | `evidence.json`：每条含指标、观察值、`as_of`、来源、`triggered/armed/unknown` | 每个到期的 `armed` F 都有观察值或 `unknown` 及缺口说明 |
| 3 | 评估 Assess | Agent | `change-plan.json`：T 状态迁移、受影响 A/S/V、报告小节、理由、证据 ID | ID 可解析；状态迁移合法；`revision` / `changes` 一致 |
| 4 | 应用 Apply | Agent | 状态文件（先写）、报告补丁、`## 跟踪记录` 追加 | 只改允许路径；每个文件一次写；不建副本 |
| 5 | 验收 Verify | 宿主 | `verification.json`：schema、版本、计划↔实际、状态↔结果、截止日、路径 | 全部通过；否则 `needs_review` 并记录失败项 |
| 6 | 提交 Commit | 宿主 | 结果 v2、运行记录、审计 artifact、SSE、待办队列 | 结果只由已验收的事实生成 |

关键差异：

- 现在的“结算”在阶段 4 之后直接猜状态；新流程在阶段 5 有明确的通过/失败条件。
- 现在 agent 一次会话里同时“想”和“写”；新流程先写计划，再写文件，宿主可以对比“计划说改 T2，实际状态里 T2 是否真的变了”。
- `framework` 没有状态时不再假装复核，而是进入 `migrate`：先由 `investment-framework` 补建状态，第一次 run 只建立基线，不做失效条件触发判断。

### 6.3 关键设计决策

**D1：单一 spec。** 新增 `lib/tracking-spec.mjs`（暂名），集中模板、写回策略、prompt 片段、结果 schema 版本。server 拼 prompt、UI 展示“内置更新逻辑”、测试断言都读同一份。删除 `tracking.js:23-65` 的硬编码预览，改为从 API 取实际 prompt 或 spec。

**D2：计划/应用分离。** run 目录固定为 `.tracking/<tracking_id>/<run_id>/`：

```text
<run_id>/
├── baseline.json        # 版本、sha、state revision、data_cutoff
├── evidence.json        # 本次取证结果
├── change-plan.json     # 准备改什么（ID、before/after、理由、证据）
├── verification.json    # 宿主验收结果
└── result.json          # 最终结果（v2）
```

`model` 模板只产出 `evidence` + `change-plan`，状态 `needs_review`，等后续 apply（或人工应用）。

**D3：宿主验收模块。** 新增 `lib/tracking-verify.mjs`，供 server 与测试共用；内部复用 `validate_state.mjs` 的规则（先抽成可 import 的函数，不再依赖 bash）。

验收至少包括：

- 结果 JSON 合法，schema 版本匹配；
- 目标文件版本正好 +1（或明确记录版本区间）；
- 状态文件通过结构校验，`revision` / `changes` 一致；
- `theses` / `invalidations` 与状态文件逐条对应，F 的 `triggered` 与 `status` 一致；
- `data_cutoff` 不早于基线；
- `## 跟踪记录` 已追加，且带 run id；
- 只改了允许的路径，没有新副本；
- 计划里的每个变更都能在状态 diff 里找到。

**D4：结果由状态派生。** `writeback.changes` 不再采用 agent 自报的数组，而是由宿主对比基线状态与更新后状态生成；`theses` / `invalidations` 直接读状态文件。Agent 的叙述只用于 `summary` / `reasons`。

**D5：`needs_review` 变成待办。** run 记录里存 `pending_actions`（接受计划 / 应用 / 补数据 / 驳回），UI 提供操作；应用后复用同一 run 的 `change-plan`，不再让模型重新想一遍。

**D6：统一入口。** 会话里的“复核投资框架”改为启动一次 run（默认 `plan` 模式，不写文件；用户确认后再 `apply`），或至少复用同一套 result/verification，不再走无记录的聊天即席更新。

**D7：运行时兜底。** 每次 run 有 `max_runtime`（如 15 分钟）、token/cost 记录、失败原因；超时由宿主标记 `failed` 并释放锁，不让跟踪永久卡死。

**D8：迁移路径。** `framework` 目标缺状态时，run 模式为 `migrate`：调用 `investment-framework` 补建 `analysis-state.json`（`stage=draft`，证据标 `inference`），本次不改报告结论，不判断触发；下一次 run 才是 `recheck`。

### 6.4 结果契约 v2（草案）

```json
{
  "schema": "pe.tracking.result/2",
  "run": {
    "id": "run-...",
    "tracking_id": "trk-...",
    "trigger": "schedule",
    "template": "framework",
    "spec_version": 2
  },
  "baseline": {
    "material_version": 3,
    "state_revision": 5,
    "data_cutoff": "2026-10-18"
  },
  "status": "updated | no_change | needs_review | baseline | failed",
  "verification": {
    "ok": true,
    "checks": ["version_delta", "state_schema", "plan_applied", "falsifier_linkage"],
    "errors": []
  },
  "theses": [{ "id": "T2", "status": "weakened", "change": "降级", "note": "F2 触发" }],
  "falsifiers": [
    { "id": "F2", "due": true, "observed": "12.6 周", "status": "triggered",
      "source": "渠道调研 · 2026-10-15", "checked_at": "2026-10-18" }
  ],
  "changes": [
    { "object": "thesis", "id": "T2", "before": "active", "after": "weakened",
      "reason": "库存超过阈值", "evidence_ids": ["E12"], "falsifier_ids": ["F2"] }
  ],
  "summary": "……",
  "reasons": [],
  "sources": [],
  "notUsed": [],
  "writeback": {
    "mode": "in_place",
    "version": 4,
    "backup": "backups/.../投资框架报告.md",
    "record_appended": true,
    "verification_failed": []
  }
}
```

`status` 只由宿主据验收结果决定；`verification.ok=false` 时只能是 `needs_review` 或 `failed`。

### 6.5 与现状的对应关系

| 现状 | 重构后 |
|---|---|
| `lib/tracking.mjs` 巨型 prompt | spec 模块 + 分阶段生成，prompt 只注入本阶段所需 |
| agent 自述 `theses` / `writeback` | 状态文件 diff → 结果 |
| 320ms 后比版本 | 显式 `verification` 阶段，失败可定位 |
| 模板按扩展名 | 按状态存在性 / 产物语义选，扩展名只做默认值 |
| `needs_review` 死胡同 | 待办动作 + apply |
| 聊天即席复核 | plan run / apply run |
| 种子路径失效 | 种子从真实 fixture 生成，或删除演示种子 |
| 文档三套 schema | 一份 `result/2` 契约，其他文档引用 |

---

## 7. 实施顺序与验收

### 7.1 建议顺序

**P0：契约与验收（不改更新语义）**

1. 抽 `lib/tracking-spec.mjs`，统一模板、写回策略、prompt 片段、schema 版本；删除 UI 里过期的 prompt 预览。
2. 抽 `lib/tracking-verify.mjs`，接入 `validate_state.mjs` 的规则；结算阶段强制执行。
3. 状态判定改为“事实优先”：`updated` 必须同时满足“结果声明更新”和“版本 +1”；否则 `needs_review`。
4. 结果 v2（先兼容旧字段），`theses` / `invalidations` 从状态文件生成。
5. 加 run 超时与失败释放；一次 run 的版本区间写入记录。

**P1：把“计划/应用”做实**

6. `framework` 缺状态时强制 `migrate`，不允许按 `recheck` 启动。
7. `change-plan.json` + 计划↔状态 diff 验收；`writeback.changes` 改为派生。
8. `needs_review` 待办动作与 apply 流程。
9. 会话“复核”改为 plan/apply run，复用同一契约。

**P2：覆盖与清理**

10. `model` 模板的 apply 方案（当前没有 Excel 写入/重算能力，可先做“人工应用 + 记录”）。
11. 种子、文档、演示链路修复；`tracking-timer.md` 的旧 schema 和“生成副本”说法统一。
12. 成本/token、错过运行策略、通知。

### 7.2 验收用例（应写成脚本）

- agent 声明 `updated` 但没写目标文件 → `needs_review`，不能显示新版本；
- `framework` 目标无状态文件 → `migrate` / `baseline`，不得输出“F 已核对”；
- 状态文件 `revision` 与 `changes` 不一致 → 验收失败；
- 结果里的 T/F 与状态文件不一致 → 验收失败；
- 报告没有追加 `## 跟踪记录` → 验收失败；
- `data_cutoff` 早于基线 → 验收失败；
- 多写一次目标文件 → 记录版本区间，结果指向最终版本并可追溯；
- run 卡住超过 `max_runtime` → `failed`，锁释放，下一次调度可继续；
- 同一目标并发触发 → 只有一次 run；
- 会话“复核”入口 → 产生同样的 run 记录与验收结果（或明确 plan 模式不写文件）。

---

## 8. 待确认

1. **Excel 模型更新的终点**：继续 `propose_only`（只出计划 + 人工应用），还是投入做原生写入/重算？这决定 `model` 模板是否需要 apply 阶段。
2. **旧报告迁移**：`framework` 缺状态时，是否允许跟踪运行自己补建状态（`migrate` 模式），还是要求用户先显式跑一次 `investment-framework`？
3. **会话入口**：点“复核投资框架”时默认只出计划（不写文件），还是直接跑完整更新（写文件 + 备份）？
4. **模板数量**：保留三个模板，还是收敛为“有状态复核 / 无状态刷新”两类，把 `model` 作为“只读计划”的特例？
5. **本轮范围**：只落 P0（契约、验收、去重、超时），还是连 P1（计划/应用、迁移、聊天统一）一起做？
