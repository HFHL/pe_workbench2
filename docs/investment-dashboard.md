# P2：固定式投研 Dashboard

> 状态：实现完成。只读、确定性、可追溯。Dashboard 不调用 LLM，不写文件，不修改
> tracking / material，不执行审批。P1 的 `pe.tracking-result@v1` 与浏览器 renderer
> registry 仍是唯一跟踪结果契约；本任务没有建立第二套跟踪模型。

## 1. 设计原则

- 应用定义组件：`ui/dashboard/registry.js` 只接受启动时注册的四个组件。
- 应用定义 Schema：`lib/dashboard/contract.mjs` 的 `pe.investment-dashboard@v1`
  是服务端响应的唯一结构来源。
- 服务端提供经验证的数据：`server/dashboard/service.mjs` 组装 DTO，返回前做
  TypeBox 校验。校验失败返回 500，不返回半成品页面。
- LLM 不参与组装：服务不 import 模型、tool、session；浏览器不拼接 payload HTML。
- 所有关键数字可追溯：每个区块都有 `sourceRefs`，指向 material + version +
  locator（`Sheet!A1` / `valuations[V1]` / `falsifiers[F1]` / run）。

## 2. Dashboard Schema

`schema.name = "pe.investment-dashboard"`，`version = 1`。顶层：

```json
{
  "schema": { "name": "pe.investment-dashboard", "version": 1 },
  "projectId": "product-eng",
  "asOf": "2026-10-20T14:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "dataState": "complete | partial | empty",
  "source": {
    "trackingId": "...",
    "runId": "...",
    "materialId": "...",
    "materialVersion": 3
  },
  "runs": [{ "runId": "...", "at": "...", "status": "updated", "label": "...", "hasResult": true, "isLatest": true }],
  "warnings": [],
  "sections": []
}
```

`sections` 是固定顺序的四元组（tuple），每项 `{ type, version: 1, data }`：
`valuation-summary` → `version-change` → `sensitivity-matrix` →
`falsification-panel`。重复、重排、未知 type 或 version 都无法通过 Schema；
服务端不会产出它们，浏览器组件目录也会显示“未知组件 / 版本”错误占位，
不退化成任意 HTML。

### valuation-summary

`company, asOf, currency, valueUnit, priceUnit, method, currentPrice, priceDate,
targetPrice, upsidePercent, rating, confidence, baseCaseLabel, baseCaseId,
conclusion, unknowns, sourceRefs`。

- 数字字段只接受 number 或 `null`；字符串数字和不合法日期被 Schema 拒绝。
- `currentPrice` / `targetPrice` 缺失、单位不是每股、现价为 0 时，
  `upsidePercent = null`，界面显示“无法计算”，不显示 0。
- 目标价优先取该次运行写回后的模型输出（可定位到 `Sheet!Cell`），否则取该
  run 对应的 `analysis-state.json` 快照中的 base 估值。
- 状态文件没有评级时 `rating = null`，不推断评级。

### version-change

`fromVersion, toVersion, fromDate, toDate, headline, conclusion, status,
statusLabel, changeKind, conclusionChanged, auditNote, deltas, reasons,
writeback, modelOutputs, sources, notUsed, unverified, sourceRefs`。

- 直接复用 `pe.tracking-result` 的字段名与语义；`deltas/reasons/writeback/sources/
  notUsed` 不做改名。
- `changeKind`：`business`、`audit-only`、`none`、`review`、`baseline`、`failed`、
  `unavailable`。没有运行结果时用 `unavailable`（“无结果”），不伪造成“运行失败”；
  只有运行明确失败才显示 `failed`。
- `status=updated` 但没有业务 delta、没有 modelChanges、没有观点状态变化时，
  标为 `audit-only`，`conclusionChanged=false`，并明确提示“仅审计版本，不是业务
  判断变化”。`theses[].change=维持` 的 `confirmed` 观点不视为新判断；只有
  `weakened/invalidated/retired` 或 `change` 不是“维持/不变/无变化”才计为业务变化。
- `no_change` 与 `updated` 有不同状态、标签和说明。
- 展示顺序固定：版本与日期 → 结论是否变化 → 关键数字旧值→新值 → 调整原因 →
  写回位置 → 来源 → 未使用/未验证。

### sensitivity-matrix

`title, available, emptyReason, rowAxis, columnAxis, cells, baseCase, valueUnit,
units, summary, tests, unknowns, sourceRefs`。

- 只把 `analysis-state.json` 中**已存在**的 `valuations` 数值映射成
  情景 × 方法矩阵；不做新的敏感性计算，不调用 LLM 补齐。
- 每个 cell 带 `unit` 和 `sourceRefs`；base cell 同时有 `isBaseCase` 与文字
  “基准”标记，不只靠颜色。
- 没有数值估值时 `available=false`、`cells=[]`、`emptyReason` 明确写
  “尚无敏感性数据”，不生成虚构矩阵。
- 已有 `sensitivities` 文本作为只读 `tests` 展示，保留 `fixed_conditions` 与
  `limitations`。

### falsification-panel

`theses, checks, counts, unknowns, sourceRefs`。每个 check 包括
`id, thesisId, falsifierId, metric, operator, warning, threshold, observed,
status, statusLabel, statusMeaning, lastCheckedAt, nextCheckAt, action,
linkStatus, sourceRefs`。

- 状态：`armed / warning / triggered / unknown / retired`；每个状态都有文字标签
  与含义，不只靠颜色。
- `unknown` 明确显示“缺数据，不能视为正常”，排序在 `armed` 之前。
- `triggered` 最前；随后 `warning`、`unknown`、`armed`、`retired`。
- 每个 check 尝试绑定 thesis / falsifier；无法绑定时 `linkStatus=unbound` 并在
  `unknowns` 中提示，不静默隐藏。
- 显示上次 / 下次检查时间与触发动作；`sourceRefs` 可回到状态快照、监测台账、
  运行或合法 http(s) 来源。

## 3. 组件目录

服务端目录：`lib/dashboard/catalog.mjs`，固定四项与版本。浏览器目录：
`ui/dashboard/components/`：

| type | version | validate | render | empty | error |
|---|---|---|---|---|---|
| valuation-summary | 1 | 必填字段/数字/枚举 | 估值卡 | 不适用 | registry 统一错误卡 |
| version-change | 1 | 版本/状态/数组 | 版本变化卡 | 不适用 | registry 统一错误卡 |
| sensitivity-matrix | 1 | 轴/cell/单位 | 矩阵或空状态 | “尚无敏感性数据” | registry 统一错误卡 |
| falsification-panel | 1 | 状态/文字语义 | 检查列表 | “尚未配置失效条件” | registry 统一错误卡 |

`registerDashboardComponent` 校验组件必须提供 `validate`、`render`、`empty`；
未知 type/version 直接返回错误占位。payload 只能注册组件；用户或 Agent 不能提交
组件代码、布局、CSS、HTML 或脚本。

## 4. DashboardService 与数据来源

`server/dashboard/service.mjs#createDashboardService({ store, root }).build({ projectId, trackingId, runId?, materialVersion? })`

只读来源：

1. `tracking_runs.result_json` 中的 `pe.tracking-result@v1`（该 run 的结果）。
2. 该 run 对应的 `analysis-state.json` **不可变版本快照**：
   - 优先匹配 `material_versions.run_id = runId`；
   - 否则取 `created_at <= run.ended_at` 的最新版本；
   - 从 blob 读取，不读磁盘当前文件。历史 run 不混入最新状态。
3. `materials` / `material_versions`：目标文件的 before/after 版本、日期、断链判定。
4. `monitor_items`：仅用于**最新** run；历史 run 使用状态快照与
   `result.monitorChecks/invalidations`，避免把最新监测台账混进历史。
5. `sourceRefs`：material id + version + path + locator；文件/版本不存在时
   `status=missing|broken`，界面显示“断链”，不隐藏。

确定性：同一 `projectId + trackingId + runId + materialVersion` 不读当前时间、
不写缓存、不写数据库，输出相同 DTO。`generatedAt` 这类字段不进入 DTO。
历史 run 的 `runs` 只含该次 run，新增后续 run 不会改变已有历史 DTO；最新视图
才展示完整运行列表。最新视图的监测台账是当前值（因此会随最新监测更新）；
一旦某个 run 成为历史，Dashboard 只使用该次状态快照与本轮 `monitorChecks`，同一
历史 run 的 DTO 稳定。历史视图的 run 选择器因此折叠为“最新结果 + 当前 run”，
切换其他历史 run 需先回到最新视图。

`materialVersion` 只作为来源标记；若与 run 的结果版本不一致，写入 warning，
版本变化仍以 run 记录为准，避免用查询参数篡改历史。

## 5. API

```text
GET /api/trackings/:id/dashboard
GET /api/trackings/:id/runs/:runId/dashboard
```

- 可选 `?project=<projectId>`（与现有 API 一致）。
- 可选 `?materialVersion=<n>`。
- 未知 tracking/run：404。
- 响应先通过 `INVESTMENT_DASHBOARD.validate()`；失败 500 + `code=DASHBOARD_SCHEMA_INVALID`。
- 无 run、无 result、无状态文件时仍返回合法 DTO，`dataState=empty|partial`，
  `warnings` 明确说明，不伪造数字。

## 6. 前端入口与交互

在现有 tracking 详情头部增加固定入口 `Dashboard`，打开只读全屏 Dashboard。

允许：
- 打开来源 material / version；xlsx 来源可定位到 `Sheet!A1`。
- 选择历史 tracking run；最新/历史切换。
- 展开原因、检查项、来源；复制估值摘要。
- 键盘 Escape 关闭、Tab 焦点约束、状态文字与 `aria-label`。

禁止：写模型、拖拽布局、提交组件代码、iframe、MCP App、任意 HTML、自动审批。

## 7. 安全与格式

- 所有文本经 `esc()`；组件 render 只拼接转义文本，不允许 payload HTML。
- 计数也按整数校验并转义；组件级校验拒绝非整数 counts。
- URL 只允许应用内部路径 `/(?!/)` 或 `http(s)://`；渲染层再次 `safeUrl`。
- 数字以 number 保存；`%` 是百分点数值，展示时加 `%`；货币与每股单位分开。
- 日期以 ISO 存储；展示统一 `Asia/Shanghai`。
- 长数组：原因折叠、检查项 6 条后展开、来源最多 8 条 + 提示；矩阵横向滚动。
  服务端对 cells(200)、checks(300)、sourceRefs(100)、unknowns(100)、units(20)、
  轴值(50) 做上限截断并写入 warning，避免超限导致 500。
- 未知值统一显示“未知 / 无法计算 / 缺数据”，不显示 0。

## 8. 测试

```bash
npm run test:dashboard       # Node schema/API/组件 + Playwright
npm run test:dashboard:node  # Schema、组件目录、API 集成
npm run test:dashboard:e2e   # 1440 / 1024 / 390、历史 run、来源跳转、XSS
npm run test:p1              # P1 回归
```

截图：`docs/ui-shots/dashboard-full-1440.png`、`dashboard-full-1024.png`、
`dashboard-full-390.png`、`dashboard-xss-1440.png`。

已覆盖：四类合法组件、缺字段、未知组件/版本、重复/重排区块、非法数字/日期/单位
（含不存在的日历日期）、部分/空数据、audit-only 与 no_change、无结果不等于失败、
历史 run 不读最新值、新增后续 run 不改变历史 DTO、historical monitor ledger 不泄漏、
unknown 不显示正常、断链/缺失/未验证来源、无敏感性不生成矩阵、20+ checks、
超长文本、恶意 counts、HTML/事件属性/javascript: URL、Tab 焦点、键盘与非颜色状态、
三档视口。

## 9. 非目标

未实现：动态 A2UI、Agent 自选布局、新敏感性计算引擎、模型写回、CopilotKit Core、
多 Agent、Dashboard 编辑器、拖拽布局保存。没有改动模型写回/审批逻辑。

## 10. 已知限制

- `rating` 当前只读状态文件 `review.rating` / `rating`；现有模板没有该字段时显示
  “未声明”，不推断评级。
- 历史状态快照依赖 `material_versions` 已索引 `analysis-state.json`。未入库的
  状态文件显示断链，而不是回退到当前文件。
- 敏感性矩阵复用 `valuations`（情景 × 方法），不解析 `sensitivities.result`
  中的自由文本数字；`tests` 仅原文展示。
