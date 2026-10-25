# 「盯」：只读的估值盯盘

> 状态：初版（2026-10-25）。右侧栏新增「盯」标签页；后台按规则扫描 + LLM 研判，只汇报重大信息，默认静默。
>
> 相关：[自动更新与主动提醒](auto-update.md)（监测契约与调度）、[投资框架设计](investment-card-design.md)（敏感性/失效条件）。

## 一句话

一个常驻的、绑在「最新估值模型 + 投资框架报告」上的只读盯盘 agent：先看敏感性分析里哪两个变量最影响目标价，再盯着失效条件，自己去查公告/财报/新闻；有重大发现才在右侧对话里说，没有就只留一行“一切安好”。

## 已确认的产品口径

| 决策 | 取值 |
|---|---|
| 目标范围 | **一个项目一个「盯」**，自动跟最新含 `analysis-state.json` 的估值目录 |
| 动作边界 | **只读**：只汇报，不改报告 / 状态文件 / 模型 |
| 检查节奏 | 后台默认每 30 分钟规则扫描；**有候选才调 LLM**；每天收盘后一次深度复核。界面不展示/不提供修改，节奏由服务端默认值或环境变量决定 |
| 静默 | 无发现时不产生消息、不亮 tab 圆点、不发站内/桌面通知；只保留一行状态 |
| 发现呈现 | 右侧「盯」对话里的发现卡：结论 → 命中 S/F/V → 影响 → 来源链接 → 建议动作 |

## 界面

- 右侧面板顶部新增 tab：`资料 / 盯`。
- 「盯」= 状态条 + 消息流 + 追问输入框。
- 状态条：`长鑫科技 · 一切安好` / `N 条发现待看` / `正在检查…` / `已暂停`，下面是最近检查、基准估值、下次扫描。打开 tab 后未读会自动标记已读，但发现卡保留在对话里。
- 发现卡：一句结论、`S2/F3/V1` 等 chip、目标价 `62 → 51 元（-18%）`、可点击来源（外链新标签页；本地文件直接打开文件详情）。
- 追问：`现在怎么样？`、`为什么说一切安好？`、`重点盯住 S2`；回答走同一份 brief，只读。
- 未开启时显示识别卡：公司 / 证券、报告、模型、**可展开的关注点**（基准估值 + 3 条敏感性 + 8 条失效条件，含 driver/影响/阈值/状态），一键「开始盯住」。
- 设置：启用/暂停、可展开的关注点、重建关注点、删除盯盘。扫描间隔和深度复核时间不在界面展示。
- 日志：状态条上的历史图标（或设置里的「查看检查日志」）打开审计日志；每次扫描/检查都能看到来源、候选、模型调用（URL/命令/文件路径）、判断依据和错误，哪怕最终「一切安好」。

## 数据

| 表 | 作用 |
|---|---|
| `watches` | 一个项目一条；目标路径、`brief_json`、节奏、状态、下次扫描/深度复核、聊天会话 id |
| `watch_events` | 规则扫描的候选（公告/新闻/搜索），按 `(watch_id, content_hash)` 去重；`new/used` |
| `watch_checks` | 每次研判的审计：触发方式、候选数、是否调 LLM、结果 JSON、失败原因 |
| `watch_messages` | 对话与发现：`watcher/finding`、`watcher/system`、`user/question`、`assistant/answer` |
| `watch_logs` | 审计日志：每次扫描/检查的来源任务、候选、模型工具调用、判断、错误；即使没有发现也保留 |

消息级联删除；`watch_messages` 的 `citations_json` / `related_json` 保存来源和影响链。

## brief

`lib/watch/brief.mjs` 从 `analysis-state.json` 投影出盯盘关注点，报告/模型只提供身份和版本：

- 目标：公司、证券、估值日、信息截止、报告路径/版本、状态文件、模型路径/版本。
- 基准/上行/下行估值（V1/V2/V3）。
- **Top 3 敏感性**：按影响百分比排序，带 driver（如 `毛利率`）、扰动、结果、关联观点。
- 失效条件（F1–F8）：指标、阈值、预警、来源、频率、状态、上次观察。
- 估值失效边界、检索主题、来源查询。
- 报告/模型出新版本时，下一次检查前自动重建 brief，并留一条“关注点已更新”的系统消息。

## 检查链路

```text
每 60s tick
  └─ 到扫描时间？
       ├─ westock notice list <symbol>   （tier 1）
       ├─ westock news <symbol>          （tier 3）
       ├─ anysearch_search <query>       （tier 3）
       └─ 解析 → 去重 → 打分 → watch_events(new)
  └─ 有 new 候选 或 到深度复核时间？
       └─ LLM 研判（只读 session，写入 .watch/<watchId>/<checkId>.json）
            ├─ material=false → 只写 watch_checks，不产生消息
            └─ material=true  → 写 watch_messages(finding) + SSE
```

- **规则扫描不调 LLM**：只做抓取、解析、去重、排序。
- **LLM 只在有候选时跑**：节省 token；失败后 5 分钟内不重试，候选保留。
- **每日深度复核**：即使没有候选也跑一次，主动拉行情/公告/财报 + 最近 24–48 小时新闻。
- **单飞**：同一个 watch 同时最多一个检查；检查 5 分钟超时。

## 发现契约

`lib/watch/contract.mjs`：

```json
{
  "material": true,
  "severity": "critical | warning | info",
  "headline": "一句话结论",
  "summary": "2–4 句：发生了什么、为什么影响估值、影响多少",
  "affected": [{ "kind": "sensitivity|falsifier|valuation|thesis|data", "id": "S2", "note": "..." }],
  "impact": { "label": "目标价", "from": "62 元", "to": "51 元", "delta": "-18%", "direction": "down" },
  "evidence": [{ "title": "来源", "url": "https://…", "sourceTier": 1, "publishedAt": "…" }],
  "confidence": "high | medium | low",
  "materialReason": "为什么算/不算重大",
  "suggestedAction": "只建议，不执行",
  "checked": ["本次实际核对了什么"],
  "nextWatch": "下次特别留意什么"
}
```

硬规则：

- `material=true` 必须有 `headline`、`summary`、`materialReason`，至少一条 `affected`，至少一个 **可点击链接**；
- 链接必须是 `http(s)`；本地文件可用项目相对路径；
- 券商首页、搜索页、`https://www.sse.com.cn/` 这类占位链接不算原文；
- 无链接 → 必须降为 `material=false`，不允许“先报再说”。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/watch` | 当前 watch + 消息 + 检查；未开启时返回 `detection`（识别到的最新估值） |
| POST | `/api/watch` | 创建/开始；`{ intervalMinutes, deepCheckTime }` |
| PATCH | `/api/watch/:id` | 启用/暂停、间隔、深度复核时间；`{ enabled, intervalMinutes, deepCheckTime }` |
| DELETE | `/api/watch/:id` | 删除 watch 及其消息/检查 |
| POST | `/api/watch/:id/check` | 立即检查；`{ deep: true }` 为深度复核 |
| GET | `/api/watch/:id/messages` | 消息列表；`?after=` 增量 |
| POST | `/api/watch/:id/messages` | 追问；`{ text }`，返回 202 |
| POST | `/api/watch/:id/read` | 标记已读（保留给未读角标） |
| GET | `/api/watch/:id/logs` | 审计日志；`?limit=600&run=<runId>` 可过滤单次运行 |
| POST | `/api/watch/:id/refresh` | 按最新报告/状态重建 brief |

SSE：`watch.updated`、`watch.message`、`watch.deleted`。

## 审计日志

每次规则扫描、每次 LLM 研判都会写 `watch_logs`，按 `run_id` 分组。典型内容：

- **规则扫描**：每个来源的 adapter、查询/子命令、返回条数、耗时、错误；每个新候选的标题、URL、来源级别、评分、分类。
- **LLM 研判**：每个工具调用的名称、详情（`web_fetch` 的 URL、`anysearch_search` 的 query、`westock_query` 的命令、`read` 的文件路径）、状态、耗时、结果摘要；模型回复；最终 `material`、`materialReason`、`checked`、`affected`、`impact`、`evidence`。
- **失败也记录**：来源失败、工具失败、结果 JSON 无效、超时，都能在日志里看到。

入口：

- 「盯」状态条的历史图标，或设置里的「查看检查日志」。
- `GET /api/watch/:id/logs?limit=600`，`?run=<runId>` 只看某一次。
- 数据落在本地 `watch_logs`，每个 watch 保留最近约 4000 行，自动裁剪。

这样“没有发现”不等于“没有过程”：管理员可以看到它扫了哪些站点/命令、看了哪些候选、为什么判 `material=false`。

## 只读保证

- 检查/对话 session 通过 `createEntry({ writeRoots: [".watch/"] })` 创建；`write`/`edit` 只能落到 `.watch/`，报告、`analysis-state.json`、模型都会被拦。
- prompt 明确要求只读，结果 JSON 是唯一可写文件。
- 不调用 `runTracking` 的监测写回路径，不产生 `approvals`，不改版本。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WATCH_SCHEDULER` | 开 | `0` 关闭调度（API 仍可用，手动检查可用） |
| `WATCH_INTERVAL_MINUTES` | `30` | 扫描间隔；不在界面展示，改环境变量后重启 |
| `WATCH_DEEP_CHECK_TIME` | `18:30` | 每日深度复核（服务器本地时区）；不在界面展示 |
| `WATCH_MAX_RUNTIME_MS` | `300000` | 单次检查超时 |
| `WATCH_ASK_TIMEOUT_MS` | `180000` | 单次追问超时 |

依赖：`WESTOCK_QUERY`（公告/新闻/行情）、`ANYSEARCH_QUERY`（公开新闻）、`web_fetch`（原文）。任何一个关闭时，规则扫描会降级，但不会伪造数据。

## 边界与已知限制

- **单进程**：服务不跑，盯盘就停；启动后按 `nextScanAt` 补一次。没有 launchd 常驻。
- **不是实时行情**：westock 是查询式数据，扫描间隔内不会推送。
- **公告没有 URL**：westock 公告列表的 `url` 为空，prompt 要求 agent 用 `anysearch_search` 找原文/可信转载；找不到就降为 `material=false`。
- **成本**：默认 30 分钟一次规则扫描（1 次 westock notice + 1 次 news + 1 次 AnySearch），LLM 只在有候选/深度复核时跑。AnySearch 配额紧张时用 `WATCH_INTERVAL_MINUTES=60`（或 120）重启服务。
- **只读**：发现不会自动改目标价/状态；需要人工在现有跟踪/审批链路处理。
- **“一切安好”** 只代表最近一次检查没有新增重大信息，不代表框架里没有已触发的失效条件（例如 F5 早已 triggered）；追问时 agent 会区分。

## 测试

```bash
npm run test:watch          # brief / finding 契约 / 来源解析 / service 端到端（stub session）
npm run test:monitoring     # 现有监测契约回归
npm run test:monitoring:store
```

`scripts/test-watch.mjs` 使用临时 workspace 和 stub session，不联网、不调模型、不碰 `data/`。
