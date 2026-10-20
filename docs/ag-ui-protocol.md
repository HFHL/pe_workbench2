# AG-UI 协议适配层（Pi Agent → AG-UI）

> 范围：协议、事件日志、断线重放、兼容接口。
> 非范围：投研领域逻辑（materials / tracking / plans / workbook / PDF / ASR / model writer）与现有前端渲染。`app.js`、`index.html`、`styles.css` 均未改动。

## 1. 事实源不变

| 数据 | 事实源 | 说明 |
|---|---|---|
| 会话历史 | Pi JSONL（`<project>/.pi/sessions/`） | adapter 只读事件，不写会话文件 |
| 资料 / 版本 / 计划 / 跟踪 / 通知 | 项目 SQLite（`data/workbench.db`） | 领域 SSE `/api/events` 不变 |
| AG-UI 传输事件 | 同一 SQLite 的 `agent_events` 表 | 仅用于断线重放，不是第二套会话事实源 |

`agent_events` 只记录 AG-UI 传输事件；material / tracking / plan / notification 等领域事件不会写入。

## 2. 标识规范（`lib/agent-protocol/ids.mjs`）

| 标识 | 规则 |
|---|---|
| `threadId` | Pi `sessionId`（稳定不变） |
| `runId` | 每次 prompt 前生成（`run_<uuid>`） |
| `messageId` | 优先 Pi 消息自带的 `id`，否则 adapter 生成 `msg_<uuid>` |
| `toolCallId` | Pi `toolCallId` |
| `eventId` | `evt_<runId>_<sequence 补零>`，随行持久化，重放不变 |
| `sequence` | 每个 run 从 1 开始严格递增，`unique(run_id, sequence)` 兜底 |
| `ordinal` | 每库单调计数，仅用于整条 thread 的跨 run 重放排序 |

## 3. 事件映射（`pi-ag-ui-adapter.mjs`）

| Pi 事件 | AG-UI 事件 | 备注 |
|---|---|---|
| `agent_start` | `RUN_STARTED` | 每个 run 的第一个业务事件 |
| assistant 首个 `text_delta` 前 | `TEXT_MESSAGE_START` | 懒启动，role = `assistant` |
| `message_update.text_delta` | `TEXT_MESSAGE_CONTENT` | 只转发文本增量（thinking 不转发） |
| assistant `message_end` | `TEXT_MESSAGE_END` | 无增量时用最终 content 补发一次 |
| `tool_execution_start` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` | args 为 JSON 字符串 |
| `tool_execution_update` | `CUSTOM`（`pi.tool_progress`） | 不干扰标准工具事件 |
| `tool_execution_end` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` | 顺序固定；`isError` 为扩展字段 |
| `agent_settled` | `RUN_FINISHED` | 关闭未闭合消息/工具后再发 |
| prompt 异常 / 适配器异常 / `stopReason: "error"` | `RUN_ERROR` | 同样先补齐未闭合项 |
| abort | `RUN_FINISHED`（`result.aborted = true`） | 之后的事件一律丢弃 |

`agent_end`、`turn_*`、`compaction_*`、`queue_update` 不进入 AG-UI；它们仍走旧 SSE。

**扩展字段**：`TOOL_CALL_RESULT.isError`（AG-UI 原生没有工具错误位）；`RUN_FINISHED.result.aborted`。

## 4. 状态机（`run-state-machine.mjs`）

- `RUN_STARTED` 必须是第一个业务事件；`RUN_FINISHED` / `RUN_ERROR` 必须是最后一个。
- `TEXT_MESSAGE_CONTENT` 必须在对应 `TEXT_MESSAGE_START` 之后，否则抛 `content_before_start`。
- `TOOL_CALL_RESULT` 只能紧跟同一 call 的 `TOOL_CALL_END`；未知/已关闭调用抛 `unknown_tool_call`。
- 终态后任何业务事件都抛 `run_already_terminal`。
- 异常结束（`fail`）、abort（`finish({aborted:true})`）会补齐 `TEXT_MESSAGE_END`、`TOOL_CALL_END` 和一条带 `isError: true` 的合成 `TOOL_CALL_RESULT`。

状态机不依赖 Pi、HTTP 或 SQLite，可纯内存测试。

## 5. 数据库

```sql
create table agent_events (
  event_id     text primary key,
  workspace_id text not null,
  thread_id    text not null,
  run_id       text not null,
  sequence     integer not null,
  ordinal      integer not null,
  event_type   text not null,
  payload_json text not null,
  created_at   text not null,
  unique (run_id, sequence),
  unique (ordinal)
);
```

索引：`(workspace_id, thread_id, ordinal)`、`(run_id, sequence)`。
建表在 `Store.migrate()`，增量迁移，不重建库；`node:sqlite`，未引入 `better-sqlite3`。

读取一律带 `workspace_id` 过滤。每个项目本来就有独立数据库文件，因此两个项目既无法互相 `list`，也无法按 `eventId` 互相读取。

## 6. HTTP 接口（`ag-ui-endpoint.mjs` + `server.mjs`）

所有路径都走现有 `projectFor()` 校验（`?project=` 或 `X-Project-Id`）。

### `GET /api/ag-ui/info`

```json
{
  "version": "1.0.0",
  "protocol": "ag-ui",
  "projectId": "product-eng",
  "agents": [{ "name": "pi", "threadIdSource": "pi-sessionId" }],
  "features": { "sse": true, "replay": true, "lastEventId": true, "afterEventId": true, "attachments": true, "projectIsolation": true }
}
```

### `POST /api/ag-ui/agent/pi/run`

```json
{
  "threadId": "<pi sessionId，可省略；省略则新建会话>",
  "messages": [{ "role": "user", "content": "分析这份报告" }],
  "forwardedProps": {
    "projectId": "product-eng",
    "attachments": ["uploads/2026-10-20-report.pdf"]
  }
}
```

- 返回 SSE；`projectId` 必须与路径解析出的项目一致（否则 403）。
- 附件必须是项目内相对路径（绝对路径、`..` 逃逸一律丢弃）；提示词按现有格式追加 `[已上传资料]` 列表。
- 同一 thread 已有活动 run → 409 `run_in_progress`；Pi 正在流式（例如旧接口发的消息）→ 409 `thread_busy`。

### `POST /api/ag-ui/agent/pi/connect`

```json
{ "threadId": "<pi sessionId>" }
```

只重放/续传，不启动新 run；连接建立时若该 thread 有活动 run，则持续流式到终态。

### `POST /api/ag-ui/agent/pi/stop/:threadId`

中止当前 run，返回 `{ ok, threadId, stopped }`。无活动 run 时 `stopped: false`。

### SSE 帧

```
retry: 2000

id: evt_run_xxx_000001
data: {"type":"RUN_STARTED","timestamp":...,"threadId":"...","runId":"..."}
```

`data` 是标准 AG-UI 事件对象；`id` 是稳定 `eventId`。

## 7. 断线重放

游标优先级：

1. `Last-Event-ID` 请求头（标准 EventSource 行为）
2. `afterEventId`（query、JSON body 或 `forwardedProps`）

语义：

- 带 `runId` 的流（`/run`）按 run 内 `sequence` 续传。
- `connect` 按整条 thread 的 `ordinal` 续传，可跨多个 run。
- 先订阅实时回调 → 再读 SQLite 重放 → 再按游标排空队列；因此「读库期间产生的事件」不会丢，重放与队列里重复的事件按 `eventId`/游标去重。
- 终态事件发出后主动关闭 SSE；活动 run 才保持连接（15s 心跳 `: ping`）。
- 超过 5000 条时自动分页，不会截断。

## 8. 兼容性

保留未改：

- `GET /api/sessions/:id/state`
- `GET /api/sessions/:id/events`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/abort`
- `GET /api/events`
- `npm start` → `node server.mjs`

前端默认仍走旧接口；AG-UI 是并行新增的传输层。同一会话两条路径可共存，但同一时刻只允许一个活动 run（AG-UI 侧返回 409）。

## 9. 测试

```bash
npm run test:protocol
```

覆盖：ID 规则、状态机不变量、纯文本 / 文本→工具→文本 / 多工具 / 工具失败 / prompt 异常 /  assistant 报错后重试 / abort / 适配器异常 / sequence 与 eventId / SQLite 重启重放 / 跨项目隔离 / SSE 游标与实时握手 / 路由语义 / 旧接口回归（真实起服务）。

其他既有测试：`test:framework`、`test:monitoring`、`test:monitoring:store`、`test:tracking-tool`、`test:workbook`、`test:pdf`、`test:web-fetch`、`test:anysearch`、`test:asr`。

## 10. 已知边界 / 未验证

- **没有发起真实模型调用**：真实 DeepSeek run 的事件顺序依赖 Pi 的 `agent_start → message_* → tool_execution_* → agent_settled` 契约；测试用 fake session 固定了这些 fixture。建议在有 API key 的环境跑一次真实短对话核对。
- 适配器按 `agent_start` 起 run；若进程在 run 中途崩溃，重放会停在半截（没有终态）。客户端可据 `RUN_STARTED` 无终态 + `connect` 立即关闭判断 run 已丢失。
- 客户端断开 SSE 不会 abort run（与 CopilotKit 一致：需要显式 `/stop`）。
- `agent_events` 没有自动清理策略；按项目库体积增长，后续可按 thread/时间做归档。
- 未引入 `@ag-ui/core` 依赖（本机 npm 不可用且不希望引入未锁定的 zod 传递依赖），事件形状由测试断言。
