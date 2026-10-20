# CopilotKit Headless Core 普通会话试点

> 状态：**实现完成，Go/No-Go 结论为 No-Go**。试点默认关闭，未 push / merge / 发布。
> 分支：`codex/copilotkit-headless-pilot`（独立 worktree，基于 P1 `codex/interactive-tools-refactor`）。
> 依赖前置：P0 AG-UI 协议层 `codex/ag-ui-protocol`（4769f4c），P1 拆分 `codex/interactive-tools-refactor`（496a17c）。

## 1. 范围

本试点只验证一件事：`@copilotkit/core` 能否接管**一个普通对话会话**的客户端运行生命周期，同时保留：

- Pi `AgentSession` / Pi JSONL 作为唯一对话事实源；
- 当前项目隔离（`?project=` / `X-Project-Id`）；
- 现有 `/api/materials`、`/api/trackings`、`/api/plans`、`/api/approvals` 等领域 API；
- 现有原生 JS UI、消息渲染器和 P1 工具渲染器（workbook / approval / tracking）。

明确不做：React、Dashboard、A2UI、多 Agent、领域 API 改造、Pi 迁移、CopilotKit SQLite Runner、`better-sqlite3`、托管 Thread/Memory/Learning/Telemetry。

## 2. 启用边界

两种等价开关，默认关闭：

```text
?agentTransport=copilotkit
COPILOTKIT_CORE_EXPERIMENT=1
```

- 未启用时：`ui/bootstrap.js` 不动态 import `ui/copilot-pilot/pilot.bundle.js`，不请求 `/api/copilotkit/*`，旧 SSE 链路完全不变。
- 启用后：`state.agentTransport = "copilotkit"`；`openAgentStream()` 直接返回 `null`，同一会话不会同时连接旧 Agent stream。
- 一旦选定 transport，该页面只由一种客户端发送 prompt 和维护 run 状态。切换 transport 需要重新加载页面。
- URL 开关优先于服务端 env；如果 bundle 未构建，状态为 `unavailable`，发送按钮禁用并提示构建，**不会静默回退到旧链路**。

## 3. 后端

### 3.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/copilotkit/info` | CopilotKit RuntimeInfo：只发布 `pi` 一个 agent；`telemetryDisabled: true`、`a2ui.enabled: false`、`suggestions: false`、`openGenerativeUIEnabled: false` |
| POST | `/api/copilotkit/agent/pi/run` | 复用 P0 `PiAgUiAdapter`，SSE |
| POST | `/api/copilotkit/agent/pi/connect` | 复用 P0 重放/续传，SSE |
| POST | `/api/copilotkit/agent/pi/stop/:threadId` | 复用 P0 abort |
| GET | `/api/copilotkit/thread/:threadId/state` | 试点专用游标：`streaming / activeRunId / lastEventId / lastEventOrdinal` |

`/run`、`/connect`、`/stop` 在 `lib/agent-protocol/copilotkit-endpoint.mjs` 中把 `/api/copilotkit` 前缀改写为 `/api/ag-ui` 后交给 P0 的 `handleAgUiRequest`，因此线程身份、项目校验、附件校验、SSE 游标、run 状态机和重放语义完全复用 P0。

### 3.2 事实源

- `threadId` 继续等于 Pi `sessionId`。
- 对话历史只写 Pi JSONL；`agent_events` 仍是 P0 的传输重放日志，不是第二套会话库。
- 工具结构化结果继续由 P1 `tool_presentations` 持久化，刷新时由 `snapshotMessages()` 合并。
- 新增的 Store 方法只有 `latestAgentEvent()`（读取一条最新重放事件作为游标）；没有新表、没有迁移。
- 没有安装 `@copilotkit/runtime`、`@copilotkit/sqlite-runner`、`better-sqlite3`。

### 3.3 项目与附件

- `projectFor()` 继续按 query / `X-Project-Id` 解析项目。
- `forwardedProps.projectId` 必须与路径项目一致，否则 403。
- `forwardedProps.attachments` 走 P0 `safeAttachments()`：realpath、项目内、普通文件、去重、最多 50 个。
- 浏览器只发送附件相对路径，不发送文件正文、工作簿内容或 API key。

## 4. 前端

```text
ui/copilot-pilot/
  entry.js             # esbuild 入口
  bootstrap.js         # install/uninstall、runtime.pilot
  client.js            # Core 连接、run/connect/stop、事件映射、metrics
  subscriptions.js     # Core subscriber + agent public subscribe
  message-adapter.js   # AG-UI -> 现有 renderer 的 DTO
```

公开 API 使用：

- `new CopilotKitCore({ runtimeUrl, runtimeTransport: "rest", headers, properties, deferInitialConnection: true })`
- `core.connect()`
- `core.subscribe({ onAgentsChanged, onRuntimeConnectionStatusChanged, onToolExecutionStart, onToolExecutionEnd, onError })`
- `core.subscribeToAgentWithOptions(agent, { onMessagesChanged, onStateChanged, onRunInitialized, onRunFinalized, onRunFailed, onRunErrorEvent })`
- `agent.subscribe({ onRunStartedEvent, onTextMessage*, onToolCall*, onRunFinishedEvent, onRunErrorEvent })`（Core 管理的 agent 的公开 AG-UI subscriber）
- `core.runAgent({ agent, forwardedProps })`、`core.connectAgent({ agent })`、`core.stopAgent({ agent })`
- `agent.threadId` / `agent.setMessages()` / `agent.detachActiveRun()`

没有使用任何 `ɵ` 导出。`agent.subscribe()` 是 Core 对后端工具事件的公开补充：Core 自身的 `onToolExecutionStart/End` 只覆盖前端工具，本试点没有注册前端工具。

映射策略：

- `state.live` 只由 Core 的 AG-UI 事件驱动（文本增量、工具开始/参数/结束/结果）。
- 每次 run 开始/完成、刷新、abort 后，从 `/api/sessions/:id/state` 读取 Pi 规范快照，投影到现有 `state.messages` 与 P1 渲染器；这是单向 canonical hydration，不把 UI 状态写回 Core。
- 刷新时先读快照，再用 `activeRunId` 过滤连接重放，避免历史 run 的 `RUN_FINISHED` 提前结束当前 run。
- 项目切换调用 `pilot.resetForProject()`，销毁 Core、重新按新项目 header 建连；订阅回调同时校验 `projectId` 和 `activeSession`。

## 5. 依赖与构建

精确版本：

| 包 | 版本 | 类型 |
|---|---|---|
| `@copilotkit/core` | `1.79.1` | dependencies（精确） |
| `esbuild` | `0.28.2` | devDependencies（精确） |

- 没有 `@copilotkit/runtime`；没有 `latest` / `^` 用于新增依赖。
- `package-lock.json` 从 119 个 package 条目增至 198 个（+79）；`node_modules` 实际安装约 170 个新增包（含平台二进制）。
- `npm run build:copilot-pilot` 只构建 `ui/copilot-pilot/entry.js` -> `ui/copilot-pilot/pilot.bundle.js`。
- 现有 UI 模块（`../state/store.js`、`../runtime.js`、`../chat/renderer.js`、`../shared/toast.js`、`../api/client.js`）在 bundle 中保持 external，浏览器继续使用同一份原生 ES module 实例，避免双份 state。
- bundle 产物被 `.gitignore` 忽略；试点路径需要先构建。默认路径不需要构建。
- 没有把现有前端迁移到 bundler，没有 CDN。

实测 bundle：

| 指标 | 数值 |
|---|---|
| `pilot.bundle.js` | 1,055,242 bytes |
| gzip | 231,739 bytes |
| esbuild bundled inputs | 661 |
| 现有默认 UI JS（15 个模块） | 183,422 bytes / 49,909 bytes gzip |

## 6. 网络与隐私清单

浏览器实测（fake Agent，无真实模型）：

默认路径：

- 同源：`/`、`/api/health`、`/api/projects`、`/api/notifications`、`/api/approvals`、`/api/sessions`、`/api/events`、`/api/materials`、`/api/plans`、`/api/trackings`、`/api/sessions/:id/state`
- 没有 `/api/copilotkit/*`
- 没有 `pilot.bundle.js`
- 没有外网请求

试点路径新增（全部同源）：

- `GET /ui/copilot-pilot/pilot.bundle.js`
- `GET /api/copilotkit/info`
- `POST /api/copilotkit/agent/pi/run`
- `POST /api/copilotkit/agent/pi/connect`（刷新/断线重连）
- `GET /api/copilotkit/thread/:threadId/state`（重连游标）
- `POST /api/copilotkit/agent/pi/stop/:threadId`（Core abort 时）

未出现：

- `api.deepseek.com`（浏览器不直连模型）
- `telemetry.copilotkit.ai` / `cdn.copilotkit.ai`
- AnySearch / ASR / westock 等未配置服务
- 任何非 same-origin 请求

请求隐私检查：

- run 的 `forwardedProps` 只含 `projectId`、`attachments`、`threadId`。
- `messages` 只含用户输入文本。
- 没有 `Authorization`、`Cookie`、`DEEPSEEK_API_KEY`、`sk-`、`apiKey`。
- 没有完整工作簿或材料正文进入 headers / forwardedProps。

服务端没有新增外发调用；模型、AnySearch、ASR 仍走原有配置路径。`@copilotkit/core` bundle 内含 Learning 的 telemetry URL 字符串，但因为没有配置 `learning`、runtime info 又声明 `telemetryDisabled: true`，实际没有发出请求。

## 7. 测试结果

### 7.1 命令

```bash
npm run build:copilot-pilot
npm run test:copilotkit          # 33 项，后端
npm run test:copilot-pilot       # 构建 + 后端 + 14 项 Playwright parity
npm run test:p1                  # 173 项 P0/P1
npm run test:e2e                 # 15 项 P1 浏览器回归
```

### 7.2 结果

| 套件 | 结果 |
|---|---|
| `test:copilotkit` | 33 passed, 0 failed |
| `test:copilot-pilot` browser | 17 passed, 0 failed |
| `test:p1` | 173 passed, 0 failed |
| `test:e2e` | 15 passed, 0 failed |

parity 场景（同一 fake Agent fixture，旧/新 transport 分别执行）：

- 默认路径不加载 pilot
- 创建/打开会话、普通消息、流式文本
- 文字 → 工具 → 文字，workbook 结构化卡片
- 多工具（workbook + grep）
- 工具失败
- Agent 异常
- abort 后同一会话继续发送
- 浏览器刷新 + connect
- 中途离线断线 + offline/online 自动 reconnect
- 项目切换隔离
- 同一 Pi thread 在旧/新 transport 之间往返读写
- 网络/隐私清单
- `COPILOTKIT_CORE_EXPERIMENT=1` 环境开关
- 最终快照失败时保留已完成回答
- connect 过程中抢跑 send 不启动第二个 run
- bundle 缺失时 fail-closed
- pilot 模式下没有旧 Agent SSE

### 7.3 实测数据

| 指标 | 旧 transport | CopilotKit transport |
|---|---|---|
| 首段文字到达（stream fixture） | 0.079 s | 0.081 s |
| 完成时间（stream fixture） | 0.483 s | 0.485 s（含测试固定 300ms settle 等待，仅作相对比较） |
| 最终 assistant 消息数 | 1 | 1 |
| 重复最终文本 | 0 | 0 |
| 工具卡数量（tool fixture） | 1 | 1 |
| 刷新后结构化卡恢复 | 是（P1 回归） | 是 |
| 刷新期间 reconnect | — | 精确恢复 25/25 片段，最终文本只出现 1 次 |
| 离线断线 reconnect | — | 精确恢复 10/10 片段，最终文本只出现 1 次（offline/online 自动触发） |
| reconnect 重放文本增量 | — | 刷新：25；离线 drop：累计 18（原 10 + 重放 8；旧连接已 detach） |
| 丢失事件（按最终 DOM/快照） | 0 | 0 |
| `RUN_FINISHED` / `RUN_ERROR` 顺序 | — | 正常 |

说明：Core 不向订阅者暴露 SSE `id:`，因此 reconnect 不是 P0 的 `Last-Event-ID` 增量续传，而是 `detachActiveRun()` 后重放当前 active run。刷新场景新增 25 个文本增量；离线 drop 场景累计 18（原 10 + 当前 run 重放 8），但旧连接已 detach，最终 DOM 仍只有 1 份文本，没有最终重复/丢失。长 run 的带宽成本高于 P0。

## 8. 代码量与可删除性

新增试点源码（不含测试/构建）：

| 文件 | 行数 |
|---|---:|
| `ui/copilot-pilot/client.js` | 766 |
| `ui/copilot-pilot/message-adapter.js` | 101 |
| `ui/copilot-pilot/subscriptions.js` | 57 |
| `ui/copilot-pilot/bootstrap.js` | 48 |
| `ui/copilot-pilot/entry.js` | 5 |
| `lib/agent-protocol/copilotkit-endpoint.mjs` | 112 |
| `server/routes/copilotkit.mjs` | 18 |
| 合计 | 1,107 |

可删除/简化的旧客户端生命周期代码（估算）：

- `ui/events/streams.js` 的 agent SSE 路径：约 30–35 行
- `ui/bootstrap.js` 的 `handleServerEvent` + snapshot poll + 旧连接/停止分支：约 130–150 行
- `ui/chat/composer.js` 的旧发送路径：约 30–35 行
- 合计约 200–220 行

`server/agent/event-bridge.mjs`、`PiAgUiAdapter`、`/api/ag-ui` 仍被 P0/工具 presentation 使用，不能随旧客户端一起删除。

## 9. Go / No-Go

**结论：No-Go（不进入正式迁移）。**

满足的 Go 条件：

- 普通会话功能等价：创建/打开、发送、流式、文字→工具→文字、多工具、工具失败、abort。
- 刷新/断线 reconnect 最终结果等价；没有最终重复/丢失。
- project/thread 不串数据；同一 Pi thread 可在两种 transport 间打开和继续写。
- P1 workbook/approval/tracking 渲染器正常；结构化卡刷新后恢复。
- 没有第二套会话事实源；没有复制 Pi JSONL；没有 SQLite Runner。
- 没有未授权外发；浏览器不直连模型。
- 没有使用 `ɵ` 内部 API。

不满足/超出阈值：

1. **bundle 与依赖成本明显大于收益**：新增 1.05 MB（231 KB gzip）浏览器 bundle、约 170 个安装包、79 个新 lock 条目；现有默认 UI JS 只有 50 KB gzip。为接管一个普通会话生命周期，代价过高。
2. **适配复杂度没有低于可删除代码**：新增 1,107 行试点源码，而可删除的旧客户端生命周期约 200–220 行；`client.js` 仍需自行实现 stop、reconnect、active-run 过滤、finalization 和 metrics。
3. **reconnect 弱于 P0 的精确增量续传**：Core 不暴露 SSE event id，只能 detach 后重放 active run；长 run 的带宽/重放成本高于 P0 `Last-Event-ID`。
4. **协议兼容噪音**：P0 事件带 `threadId`/`runId`，Core enforcement 会逐事件剥离并打印 warning；虽无功能影响，但说明两边协议并非完全同构。

建议：保留该分支作为可复现试点，默认继续走旧 transport；不合并。若未来 CopilotKit 提供更轻的 headless entry、公开 SSE 游标/事件 id，或自研生命周期代码显著增长，再重新评估。

## 10. 回滚步骤

1. 关闭开关：去掉 URL `?agentTransport=copilotkit`，或删除/设为 `0` 的 `COPILOTKIT_CORE_EXPERIMENT`。
2. 删除试点文件：
   - `ui/copilot-pilot/`
   - `lib/agent-protocol/copilotkit-endpoint.mjs`
   - `server/routes/copilotkit.mjs`
   - `scripts/build-copilot-pilot.mjs`
   - `scripts/test-copilotkit.mjs`
   - `scripts/test-copilot-pilot.py`
   - `docs/copilotkit-headless-pilot.md`
3. 撤销接线：
   - `app.js` 未改；`ui/bootstrap.js` 删除 `installPilotIfRequested()`、pilot 分支、`runtime.pilot` 调用、`refreshSnapshot` 的 pilot 选项、`runtime.syncStop/createSession/connectSession` 中仅试点需要的部分。
   - `ui/chat/composer.js` 删除 pilot 分支和 `pilotBusy/pilotUnavailable`。
   - `ui/events/streams.js` 删除 `agentTransport` 守卫。
   - `ui/state/store.js` 删除 `agentTransport`。
   - `server/create-app.mjs` 删除 route/import/`COPILOTKIT_ENABLED`。
   - `server/routes/projects.mjs` 删除 health 的 `features/copilotkit`。
   - `server/config.mjs` 删除 `copilotkitEnabled`。
   - `store.mjs` 删除 `latestAgentEvent()`（如果不再使用）。
   - `server/agent/fake-agent.mjs` 删除 `multi-tool` fixture（可选，纯测试）。
4. 删除依赖：
   - `npm uninstall @copilotkit/core`
   - `npm uninstall --save-dev esbuild`
   - 恢复 `package-lock.json`，或运行 `npm install` 清理。
5. 删除 `.gitignore` 中 `ui/copilot-pilot/pilot.bundle.js` 一行和生成的 bundle。
6. 清理 URL/本地 storage 中的试点参数；无需数据库迁移或数据修复。
7. 验证：
   ```bash
   npm run test:p1
   npm run test:e2e
   ```
   旧 transport 应正常打开试点期间创建的 Pi thread；`agent_events` 中残留的试点重放事件不会被旧 UI 读取，可保留，也可按 thread 归档。

## 11. 独立审查与修复

独立审查由一个只读子代理执行（独立上下文，非自审），使用 open-code-review-delegate，覆盖 OCR preview 的 21/21 个 reviewable 文件：

- 结论：无 Critical；3 High、6 Medium、5 Low；独立给出 No-Go。
- High 1（断网后没有生产环境 reconnect 调用）：已增加 `offline`/`online` 监听和自动重连（`handleOffline()` / `handleOnline()` / `#scheduleReconnect()`），测试改为不手动调用 `reconnect()`。
- High 2（最终快照失败会丢掉已完成回答）：`refreshSnapshot()` 支持 `throwOnError`，`#finishRun` 失败时用 `#commitLive()` 保留流式文本/工具行；新增快照失败浏览器测试。
- High 3（send/connect 竞态）：`connect()` 单飞 + `connectToken`，`send()` 在 await 后重新检查 streaming/项目/会话；新增 connect 过程中抢跑 send 测试。
- Medium 1（快照清空 live）：`refreshSnapshot()` 默认在 streaming 时保留 live，并支持 guard；`#finishRun` 的旧快照不会覆盖新 run。
- Medium 2（cursor 失败被当成 run 丢失）：区分网络错误，网络错误走自动重连。
- Medium 3（stop 失败被静默当成功）：显式 stop 请求失败时提示并保留运行状态。
- Medium 5（rejected send 留下幽灵用户消息）：composer 在修改 UI 前拦截 streaming/unavailable。
- Medium 6（onRunFailed 不是 run-scoped）：增加 `acceptEvents`/`finalized` 守卫。
- Medium 8（构建不强制 external）：`build:copilot-pilot` 在 shared UI 模块未全部 external 时直接失败。
- Low：live `startedAt` 改用 `Date.now()`；工具结果支持 ContentPart[]；health 去掉未使用的 bundle 字段；uninstall 恢复 transport。
- 未修复并保留为已知限制：M4（流式过程中没有 P1 结构化卡，结束时才由规范快照补齐）、M7（env 开启但未构建时 fail-closed，需要预构建或关闭 env）、M9（stop 失败路径没有自动化浏览器测试）。

复审在提交后由同一独立审查会话针对固定 commit 重新执行；结果见交付说明。

## 12. 已知限制 / 未验证

- 未做真实 DeepSeek 模型冒烟；全部使用 `PI_FAKE_AGENT=1`。真实模型下的 token、工具延迟、长文本重放成本未测。
- 未覆盖多标签页同时操作同一 Pi thread；服务端 P0 仍有单 run 锁和 409，但客户端没有跨标签页协调。
- 未覆盖真实网络代理/证书错误；只覆盖 Playwright offline/online。
- 未覆盖 P0 `agent_events` 清理策略；试点沿用 P0 的无限增长边界。
- 未引入 `@copilotkit/runtime`，因此没有验证官方 Runtime Runner 的注册/转发路径；本试点验证的是其公开 HTTP 契约兼容层。
- 未做 CopilotKit Learning/Telemetry/Thread/Memory 的启用路径；这些能力被明确关闭。
- 流式过程中只有工具文本行；P1 workbook/approval/tracking 结构化卡在最终规范快照时补齐。最终快照失败时只保留文本/工具行，不保留结构化卡。
- env 开关开启但 bundle 未构建时，所有会话进入 `unavailable`，聊天被禁用；这是有意的 fail-closed，需要部署前构建。
