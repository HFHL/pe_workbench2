# P1：结构化工具结果与模型写回审批

> 状态：已完成。Pi → AG-UI 协议层沿用 P0（`lib/agent-protocol/`），本阶段不接入
> CopilotKit Headless Core，不实现 Dashboard，也不迁移到 React。

## 1. 单一事实源

三个 v1 契约都在 `lib/contracts/`，TypeBox schema 同时可作为 JSON Schema 导出：

| 契约 | 文件 | 用途 |
|---|---|---|
| `pe.workbook-query.result` | `workbook-query-result.mjs` | `workbook_query` 的 UI 单元格/依赖子图 |
| `pe.model-change.proposal` | `model-change-proposal.mjs` | 待审批的模型写回提案 |
| `pe.tracking-result` | `tracking-result.mjs` | 跟踪结果（含 legacy 读取） |

Producer 校验：

- `lib/workbook-presentation.mjs` 把 `queryGraph()` 的结果收敛成契约；不合法直接抛错，不广播。
- `lib/tracking.mjs` 的 `normalizeTrackingResult()` 生成带 `schema/version` 的新结果。
- `lib/approvals/service.mjs` 在创建审批前校验 proposal。

Consumer 校验：

- `lib/contracts/index.mjs#extractPresentation` 在持久化和广播前校验工具 `details`。
- 浏览器 `ui/tool-renderers/validators.js` 在渲染前再次做结构校验；损坏 payload 只显示错误占位。

工具返回约定：

```js
{
  content: [{ type: "text", text: "给 Agent 的短文本" }],
  details: {
    presentation: {
      schema: { name: "pe.workbook-query.result", version: 1 },
      payload: { /* 只给 UI */ }
    }
  }
}
```

## 2. 持久化

`store.mjs` 新增：

- `tool_presentations`：`workspace_id + tool_call_id` 为主键，保存 `thread_id/run_id/tool_name/schema_name/schema_version/payload_json/created_at`。刷新/恢复会话时由 `snapshotMessages()` 按 `tool_call_id` 合并。
- `approval_requests`：保存 proposal 与决定，字段包括 `id/workspace_id/thread_id/run_id/tracking_id/kind/payload_json/status/decision_json/created_at/decided_at/applied_at`。

Pi JSONL 仍是对话事实来源；`details` 即使丢失，宿主持久化的 presentation 也能重建卡片。
大型 payload 不进入 Agent 文本，`content` 仍是长度受限的摘要。

## 3. 审批状态机

```
tracking result has modelChanges
        │
        ▼
pending_approval ──reject──► rejected
        │
     approve（重新校验）
        │
        ▼
     approved
        │
        ▼
     applying ──error──► failed
        │
        ▼
     applied

校验失败（版本/sha/写回开关/绑定/公式/输出/项目）
        └──────────────► conflict
```

规则：

- 只要存在 `modelChanges`，tracking 结果强制 `needs_review`，`decision.action` 改为 `propose`；autonomy 不会直接写回。
- `POST /api/approvals/:id/approve` 每次都重新读取项目、工作模型、`analysis-state.json`，不信任 proposal 里的旧检查。
- 基线版本或 sha 变化直接 `conflict` + HTTP 409，不产生新版本。
- `reject` 不写文件、不产生版本；`decision_json` 保存拒绝时间和原因。
- approve/reject 幂等；`applying` 期间服务重启会恢复为 `failed`，不会自动重试。
- 只有 apply 成功才调用 `applyModelChanges`（备份 → LibreOffice 重算 → 输出校验 → 新版本），随后更新 tracking run、approval，并广播 approval/tracking/material。
- 会话的 `beforeToolCall` 会阻止 Agent 直接 `write`/`edit` 任何 `**/model/*.xlsx`；工作模型只能由审批服务写入。
- 审批使用进程内按工作模型路径的互斥锁，并在 apply 前重新读取 `analysis-state.json`、重新计算文件 sha；LibreOffice 是否可用也在 approve 时重新检查。

接口：

- `GET /api/approvals?threadId=&trackingId=&status=`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`（body: `{ reason? }`）

## 4. 服务端模块

```
server.mjs                     # 仅 loadConfig + createWorkbench + listen
server/
  config.mjs                   # env/paths/flags，无监听、无定时器
  create-app.mjs               # 组合根：project/session/tracking/schedulers/routes
  project-context.mjs          # 每个项目的 store/caches/tools/approval service
  http/respond.mjs             # json/readJson/sse/static/range
  events/bus.mjs               # 项目级 domain event bus + SSE fan-out
  agent/
    session-service.mjs        # Pi/假 Agent 会话生命周期
    event-bridge.mjs           # Pi 事件 → SSE + tool presentation 持久化
    snapshot.mjs               # 会话快照（合并 presentation）
    fake-agent.mjs             # PI_FAKE_AGENT=1 的确定性替身（测试专用）
  tracking/service.mjs         # tracking/monitor/source 业务
  schedulers/{tracking,monitor,source,periodic}.mjs
  routes/{projects,sessions,materials,tracking,plans,approvals,ag-ui,testing}.mjs
```

- 路由只解析 HTTP、调用 service、返回响应。
- 每个 scheduler 都有 `start/stop/tick`；import 不创建 interval；测试手动 `tick()`。
- 一次 tick 最多启动一个本地 Agent run；lease/中断恢复语义沿用原实现。
- `TRACKING_SCHEDULER=0`、`MONITOR_SCHEDULER=0`、`SOURCE_SCHEDULER=0` 仍兼容。

## 5. 前端模块

```
app.js                         # 兼容入口，仅启动 ui/bootstrap.js
ui/
  bootstrap.js                 # 项目/会话/事件/初始化和旧脚本兼容层
  state/store.js               # getState/update/subscribe/selectors/resetForProject
  api/client.js                # withProject/api/uploadFile
  events/streams.js            # 全局 SSE 与 Agent SSE，项目/会话双守卫
  chat/{renderer,composer}.js  # 消息/实时运行 + 输入框/附件/上传
  materials/materials.js       # 右栏资料/版本/计划/过滤/通知
  previews/previews.js         # Markdown/PDF/Excel/音频预览
  approvals/approvals.js       # 审批货架与 approve/reject
  tool-renderers/              # registry + validators + workbook/approval/tracking
  shared/{dom,escape,toast}.js
```

- `tracking.js` / `suggestions.js` 仍是原生 classic script；bootstrap 只暴露只读状态与少量动作，不保留第二套实现。
- 项目切换通过 `resetForProject()` 清空项目相关状态并关闭两条 SSE；流内部同时校验 projectId/threadId，旧项目事件不会写入新项目。
- 所有工具卡片文本都经过转义；未知 schema/version、损坏 payload 都显示错误占位，不会破坏整条消息。

## 6. 测试

```bash
npm run test:tool-contracts   # schema/producer/consumer/envelope
npm run test:approvals        # 真 SQLite + xlsx + LibreOffice 审批状态机
npm run test:server           # 模块边界 + scheduler start/stop/tick
npm run test:protocol         # P0 协议回归（173 项）
npm run test:e2e              # Playwright + fake Agent 浏览器回归
npm run test:p1               # 前四项（不含浏览器）
```

`test:e2e` 使用 `PI_FAKE_AGENT=1`、`WORKBENCH_TEST=1` 和临时 storage，不读取真实模型密钥；需要 Python Playwright 与本机 Chrome。
