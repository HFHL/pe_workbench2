# Pi 接入方案：后端 Harness × 现有工作台前端

> 调研对象：已 clone 到 `/Users/Admin/project/pi-mono`（GitHub `badlogic/pi-mono`，规范仓库已迁移到 `earendil-works/pi`，两者同一 commit）。
> 基线：commit `482c138`（2026-10-18），所有包版本 `1.3.0`。Node 要求 `>= 22.19`。
> 依据：仓库源码 + `packages/coding-agent/docs/*.md`。**本文没有发起真实模型调用**，代码片段按公开 API 编写，落地时需按你锁定的版本做一次编译验证。

---

## 0. 结论先行

1. **推荐路线**：后端 Node 服务内嵌 `@earendil-works/pi-coding-agent`（SDK），一个 `AgentSession` 对一个会话；现有三栏前端保留，用 **REST + SSE** 包一层。不要一上来就上 RPC 或 durable。
2. **职责切分**：Pi 负责"运行时"——模型调用、agent loop、工具执行、会话树、skills、上下文压缩、事件流；你的 harness 负责"产品域"——工作空间、权限、文件索引、数据库、计费、审计、记忆。Pi 的设计意图就是被这样嵌入。
3. **Pi 不做的事**：没有内置 subagents、plan mode、长期语义记忆、数据库会话存储。多 agent 编排是宿主责任；需要崩溃恢复和后台子任务时再上 `pi-durable`（experimental）。
4. **持久化真相**：Pi 的会话是 JSONL 文件（`~/.pi/agent/sessions/--<cwd>--/…` 或自定义目录），不是数据库。DB 里放元数据、文件索引、可选的镜像消息；不要把 `SessionManager` 当成数据库 ORM。
5. **风险**：1.3.0 迭代很快（文档与 API 都在动），务必锁版本，并在自己的代码里做一层 `PiRuntime` 适配层，避免 SDK 类型渗透全站。

---

## 1. 仓库与版本

```bash
cd /Users/Admin/project/pi-mono
git log -1 --oneline
# 482c138 fix(ai): update GLM-4.6V Coding Plan cache read price in test
```

| 包 | 版本 | 作用 |
|---|---|---|
| `@earendil-works/pi-ai` | 1.3.0 | 模型与 provider 抽象、流式输出、用量、工具参数校验 |
| `@earendil-works/pi-agent-core` | 1.3.0 | `Agent` 循环、事件、工具、steering/follow-up 队列 |
| `@earendil-works/pi-coding-agent` | 1.3.0 | 面向编码场景的壳：`AgentSession`、`SessionManager`、资源发现、内置工具、skills、extensions、SDK/RPC/CLI |
| `@earendil-works/pi-durable` | 1.3.0 | 实验性：可持久化/可恢复的 harness、子 agent、任务图、SQLite 存储 |
| `@earendil-works/chord` | 1.3.0 | 分布式对象/状态同步底座，durable 依赖它 |
| `@earendil-works/pi-mcp` | 1.3.0 | 独立 MCP 客户端（stdio / Streamable HTTP） |
| `@earendil-works/pi-codemode` | 1.3.0 | 让模型写 JS 调用工具（工具多时省 token） |
| `@earendil-works/pi-evals` | 1.3.0 | 基于 vitest-evals 的行为评测 runner |

> 包名已从早期的 `@mariozechner/pi-*` 迁移到 `@earendil-works/pi-*`。网上大量教程仍是旧名字，注意区分。
>
> `@earendil-works/pi-web-ui` 在 npm 上仍存在，但停在 `0.75.x`，绑定旧版 pi-ai；它已不在当前 monorepo 里。**新项目不要依赖它**，用自己的前端（就像现在的 Workbench 页面）。

---

## 2. Pi 的分层与运行时事实

```
┌──────────────────────────────────────────────────────────────┐
│ 你的产品层：workspace / 用户 / 权限 / 文件 / 计费 / 审计 / 记忆    │
├──────────────────────────────────────────────────────────────┤
│ pi-coding-agent（本方案的主入口）                              │
│   AgentSession   一个会话 = 模型 + 工具 + 队列 + 压缩状态        │
│   SessionManager JSONL 会话树，是"模型上下文"的权威             │
│   ResourceLoader  extensions / skills / prompts / 上下文文件    │
│   内置工具        read · write · edit · bash · grep · find · ls │
├──────────────────────────────────────────────────────────────┤
│ pi-agent-core     Agent loop · 事件 · 工具协议 · 队列            │
├──────────────────────────────────────────────────────────────┤
│ pi-ai             Model / Provider / Stream / Usage             │
└──────────────────────────────────────────────────────────────┘
可选：pi-mcp（外部工具）· pi-codemode（工具即代码）· pi-durable（持久化编排）
```

几个必须记住的运行时事实（都来自源码/文档）：

- **事件顺序**：`agent_start → turn_start → message_start/message_update/message_end → tool_execution_* → turn_end → agent_end → agent_settled`。`agent_end` 不代表彻底结束（还可能重试/压缩/排队），**UI 的"这一轮结束"要等 `agent_settled`**。
- **上下文权威是 `SessionManager`**：文档明确说直接赋值 `session.agent.state.messages` 不会替换持久化上下文。恢复历史要通过构造带 entries 的 manager。
- **一个会话同一时刻只能有一个 run**：流式期间再 `prompt()` 必须指定 `streamingBehavior: "steer" | "followUp"`，否则会拒绝。这正好对应前端的"排队/打断"。
- **工具以进程 OS 权限运行**：`bash` 就是真 shell。隔离靠容器/沙箱，不靠 Pi。
- **内置工具默认只有 `read / bash / edit / write`**，`grep / find / ls` 需要显式开启。

---

## 3. 三条接入路线与选型

| 路线 | 进程边界 | 控制方式 | 适合 | 代价 |
|---|---|---|---|---|
| **A. SDK 内嵌**（推荐） | 同进程 | TS 方法 + 事件订阅 | Node/Bun 后端，想要完整控制 | SDK 升级需要跟；一个坏工具可能拖垮进程 |
| **B. RPC 子进程** | 子进程 | stdin/stdout JSONL | 语言无关、隔离、进程级权限控制、IDE 类产品 | 多一层协议与生命周期管理；事件需转发 |
| **C. `pi-durable`** | 同进程/Worker | `Harness` + `Conversation` + `Task` | 需要崩溃恢复、后台任务、子 agent、任务图 | 标记 experimental，API 会变；概念更多 |

**建议演进**：先 A，把 `PiRuntime` 适配层做薄、做稳；当你确认需要"进程重启后继续跑""子 agent 后台执行""任务 DAG"时，再把适配层内部换成 C。B 适合你未来把工具执行放进容器或独立 worker 池。

---

## 4. 最小验证（0.5 天）

```bash
node -v                       # 需要 >= 22.19
mkdir -p ~/pi-spike && cd ~/pi-spike
npm init -y
npm i @earendil-works/pi-coding-agent
export ANTHROPIC_API_KEY=...  # 或 OPENAI_API_KEY，按你用的 provider
```

```ts
// spike.ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({ cwd: process.cwd() });

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "agent_settled") console.log("\n[settled]");
});

await session.prompt("用一句话说明这个目录里有什么。");
session.dispose();
```

```bash
npx tsx spike.ts
```

这一步验证四件事：模型凭据、工具调用、事件流、会话文件落盘。跑通后再进入第 5 节。

本次调研已经用 1.3.0 做过**不调用模型**的冒烟（Node 24；`SessionManager.inMemory()` 与 `SessionManager.create()` 各测一轮）：

- `createAgentSession()`、`session.sessionId / messages / isStreaming / getActiveToolNames()`、`session.dispose()` 均可正常工作；
- `customTools` 注册成功，但 `noTools: "all"` 时不会出现在激活工具里（符合预期）；
- 只写 `session_info`（改名）的会话不会生成 JSONL，直到出现第一条 user/assistant 消息——这是设计约束，不是 bug，DB 侧要据此处理空会话。

---

## 5. 后端接入骨架

### 5.1 对象模型

```
进程
 └─ WorkspaceRegistry（按 workspaceId）
     ├─ 工作空间根目录 / 资源加载器 / 工具策略
     └─ SessionRegistry（按 sessionId，LRU）
         └─ AgentSession（Pi）── SessionManager（JSONL）
```

- **Workspace 是隔离单位**：一个工作空间一个根目录（`cwd`），一个 `.pi/` 资源目录，一套工具策略。
- **Session 是并发单位**：同一会话串行；不同会话可并行。
- **一个进程可以挂多个工作空间**，但每个会话的 `cwd` 固定。

### 5.2 `createAgentSession()` 配置对照表

| 你的需求 | 参数 | 要点 |
|---|---|---|
| 工作空间根目录 | `cwd` | 决定项目资源发现、上下文文件、内置工具路径 |
| 全局配置目录 | `agentDir` | 默认 `~/.pi/agent`；多租户时按工作空间隔离，或自定义 ResourceLoader |
| 会话持久化 | `sessionManager` | `SessionManager.create/open/continueRecent/inMemory` |
| 模型 | `model` / `thinkingLevel` / `modelRuntime` | 不传则用 settings / 第一个可用模型 |
| 工具白名单 | `tools` / `excludeTools` | 内置默认仅 `read,bash,edit,write`；建议按场景收紧 |
| 自定义工具 | `customTools: ToolDefinition[]` | TypeBox 参数，返回 content blocks |
| Skills / extensions / prompt | `resourceLoader` | `DefaultResourceLoader` + 各类 override |
| 上下文文件 | 资源加载器自动发现 | `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md` |
| 压缩/重试 | `settingsManager` | `SettingsManager.inMemory({...})` 可覆盖 |

### 5.3 会话池（最小可用版）

```ts
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

type SessionRow = {
  id: string;
  workspaceRoot: string;
  sessionFile?: string;   // DB 中保存的 JSONL 路径
};

type Live = { session: AgentSession; lastUsed: number };

const live = new Map<string, Live>();

export async function acquireSession(row: SessionRow): Promise<AgentSession> {
  const hit = live.get(row.id);
  if (hit) { hit.lastUsed = Date.now(); return hit.session; }

  const sessionManager = row.sessionFile
    ? SessionManager.open(row.sessionFile)
    : SessionManager.create(row.workspaceRoot, `${row.workspaceRoot}/.pi/sessions`);

  const { session } = await createAgentSession({
    cwd: row.workspaceRoot,
    sessionManager,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    // customTools: [rememberTool(row), delegateTool(row)],
  });

  live.set(row.id, { session, lastUsed: Date.now() });
  return session;
}

export async function releaseIdleSessions(ttlMs = 30 * 60_000) {
  const now = Date.now();
  for (const [id, entry] of live) {
    if (!entry.session.isStreaming && now - entry.lastUsed > ttlMs) {
      entry.session.dispose();      // dispose 会 abort 正在跑的任务，所以先判断 isStreaming
      live.delete(id);
    }
  }
  // 注意：dispose 不影响 JSONL；下次 acquire 会从文件恢复上下文。
}
```

### 5.4 发消息：注意流式队列

```ts
app.post("/api/sessions/:id/messages", async (req, res) => {
  const session = await acquireSession(await loadSessionRow(req.params.id));
  const { text, images, clientMessageId } = req.body;

  const queued = session.isStreaming;
  const run = session.prompt(text, {
    images,                                   // [{ type: "image", data: base64, mimeType }]
    ...(queued ? { streamingBehavior: "followUp" as const } : {}),
  });

  run.catch((err) => logger.error({ err, sessionId: session.sessionId }, "prompt failed"));

  res.status(202).json({
    accepted: true,
    queued,
    clientMessageId,
    sessionId: session.sessionId,
  });
});
```

要点：

- **不要 `await` 在 HTTP handler 里**，否则请求会挂到整轮跑完。用 SSE 推结果。
- 幂等：前端带 `clientMessageId`，服务端落库去重（Pi 本身不负责）。
- 上传的图片走 `images`；其他文件先落到工作空间 `uploads/`，在文本里给出相对路径，让 `read` 去读。
- `abort` 对应 `POST /api/sessions/:id/abort` → `await session.abort()`。

### 5.5 SSE 桥

```ts
function bridge(session: AgentSession, write: (event: unknown) => void) {
  return session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        write({ type: "run.started" });
        break;
      case "message_start":
        write({ type: "message.started", message: event.message });
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          write({ type: "message.delta", delta: event.assistantMessageEvent.delta });
        }
        break;
      case "message_end":
        write({ type: "message.completed", message: event.message });
        break;
      case "tool_execution_start":
        write({ type: "tool.started", id: event.toolCallId, name: event.toolName, args: event.args });
        break;
      case "tool_execution_update":
        write({ type: "tool.updated", id: event.toolCallId, partial: event.partialResult });
        break;
      case "tool_execution_end":
        write({ type: "tool.completed", id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError });
        break;
      case "compaction_start":
        write({ type: "context.compacting" });
        break;
      case "compaction_end":
        write({ type: "context.compacted", aborted: event.aborted });
        break;
      case "agent_settled":
        write({ type: "run.settled", aborted: event.aborted });
        break;
    }
  });
}
```

### 5.6 事件映射表（Pi → 前端）

| Pi 事件 | 前端事件 | 用法 |
|---|---|---|
| `agent_start` | `run.started` | 显示"处理中"、禁用发送或改为排队 |
| `message_start` (user) | `message.started` | 乐观更新落库 |
| `message_start` (assistant) | `message.started` | 插入流式占位 |
| `message_update.text_delta` | `message.delta` | 追加文本 |
| `message_end` | `message.completed` | 用权威消息替换占位 |
| `tool_execution_start` | `tool.started` | 工具卡（bash 输出、文件 diff） |
| `tool_execution_update` | `tool.updated` | 流式工具输出 |
| `tool_execution_end` | `tool.completed` | 工具结果、错误态 |
| `turn_end` | `turn.completed` | 一轮问答结束（可保留 run 状态） |
| `compaction_*` | `context.*` | 提示"压缩上下文" |
| `agent_settled` | `run.settled` | 真正空闲，允许下一次发送 |
| `entry_appended` | `session.updated` | 会话元数据/消息数刷新 |
| `session_info_changed` | `session.renamed` | 标题同步 |

### 5.7 断线重连与快照

SSE 断开后不要试图补发 delta。正确做法：

1. `GET /api/sessions/:id/state` 返回**快照**：`messages`（`session.messages`）、`isStreaming`、`sessionName`、模型、工具列表、当前 run 的临时状态。
2. 建立 SSE 连接，服务端先发 `snapshot.rev`，再发增量。
3. 用 `Last-Event-ID` 只做"检测断档"：若 rev 不连续，前端重新拉快照。

---

## 6. 接入现有前端（Workbench）

### 6.1 目标状态

现在的 `app.js` 里是 `state.sessions / state.files` 的 mock。改造顺序建议：

1. 抽出 `api.js`（fetch + EventSource）和 `store.js`（会话列表、当前会话、文件列表）。
2. 保留所有渲染函数，只替换数据来源。
3. 把"发送后模拟回复"改成"发送 → SSE 流 → 文件事件刷新右栏"。

### 6.2 API 契约（建议）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | 工作空间列表（id、name、根目录、默认模型） |
| GET | `/api/workspaces/:wid/sessions` | 会话列表（`SessionManager.list` + DB 元数据） |
| POST | `/api/workspaces/:wid/sessions` | 新建会话（`SessionManager.create`） |
| PATCH | `/api/sessions/:sid` | 重命名（`session.setSessionName`） |
| DELETE | `/api/sessions/:sid` | 删除（文件 + DB 记录） |
| GET | `/api/sessions/:sid/state` | 快照：messages、模型、运行状态 |
| GET | `/api/sessions/:sid/events` | SSE 事件流 |
| POST | `/api/sessions/:sid/messages` | 发送文本/图片，支持排队 |
| POST | `/api/sessions/:sid/abort` | 中止当前 run |
| PATCH | `/api/sessions/:sid/agent` | 切换模型 / 工具白名单 |
| GET | `/api/workspaces/:wid/files` | 文件列表（来源、时间、大小） |
| POST | `/api/workspaces/:wid/uploads` | 上传（multipart，落 `uploads/`） |
| GET | `/api/files/:fid` | 文件详情 + 预览 |
| GET | `/api/files/:fid/download` | 下载 |

### 6.3 前端组件映射

| 现有 UI | 数据源 | 交互 |
|---|---|---|
| 左栏工作空间 | `GET /workspaces` | 切换后重建会话列表与当前会话 |
| 左栏会话列表 | `GET /workspaces/:id/sessions` | 点击切换；`session.updated` 刷新标题/时间 |
| 中栏消息 | 快照 + SSE | 用户消息乐观渲染；assistant 用 delta 流式追加 |
| 中栏工具调用 | `tool.*` 事件 | 现在没有工具卡，需要新增（bash 输出、diff、read 结果） |
| 输入框 | `POST /messages` | 流式中发送 → `followUp`，显示"已排队" |
| 附件 chip | `POST /uploads` 后带路径 | 图片可直接进 `images`，其他文件给路径 |
| 右栏文件 | `GET /files` + `file.created/updated` | 新增/更新时高亮、置顶 |
| 文件弹窗 | `GET /files/:fid` | 预览文本/图片；下载走 `/download` |

### 6.4 文件联动

两条路，建议都做：

- **工具事件**：`tool_execution_end` 且 `toolName` 是 `write/edit`，把 `args.path` 标记为"agent 更新"。
- **文件监听**：对活跃工作空间用 `chokidar` 监听，忽略 `.pi/`、`node_modules`、`.git`。`bash` 产生的文件只能靠监听发现。

写入 DB 的文件记录建议带 `source`（`upload` / `output` / `agent`）与 `session_id`，与现在右栏的筛选一致。

### 6.5 认证

Pi 不管用户体系。SSE 也要鉴权：优先同源 Cookie + CSRF，或短时签名 URL。不要在 query 里放长期 token。

---

## 7. Agent 编排

### 7.1 先做单 agent 闭环

一个工作空间、一个会话、一组工具。把"路由/多 agent"推迟到有明确需求时。Pi 的单 agent loop 已经包含：多轮工具调用、并行工具执行、重试、压缩、队列。

### 7.2 队列与打断

| 场景 | 调用 |
|---|---|
| 正在跑，用户再发一条 | `session.prompt(text, { streamingBehavior: "followUp" })` 或 `session.followUp(text)` |
| 用户要立刻改方向 | `session.prompt(text, { streamingBehavior: "steer" })` 或 `session.steer(text)` |
| 停止 | `await session.abort()` |
| 等空闲 | `await session.waitForIdle()` |

`steer` 在当前 assistant turn 与工具调用后插入；`followUp` 等整个 run 的挂起工作结束后进入。前端要把这两种语义显式做出来（"排队" vs "打断"）。

### 7.3 编排层放在哪

```
WorkspaceRouter
  ├─ 选择 agent profile：模型、system prompt、工具白名单、skills 集
  ├─ 选择执行模式：单 agent / 子 agent / 固定流水线
  └─ 预算：最大轮数、token、时长、并发
```

Agent profile 建议存 DB，不写死在代码里：

```ts
type AgentProfile = {
  id: string;
  model: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  systemPrompt?: string;          // 场景人设 + 边界
  tools?: string[];               // 白名单
  skills?: string[];              // 允许的 skills（用 skillsOverride 过滤）
  memoryScopes?: string[];
};
```

### 7.4 多 agent 的四种模式

| 模式 | 做法 | 适合 | 注意 |
|---|---|---|---|
| **工具委派** | 自定义 `delegate` 工具，内部 `createAgentSession` 起子会话，返回最终文本 | 调研、审查、并行子任务 | 子会话有独立 token 成本；限制深度与工具 |
| **固定流水线** | 宿主按顺序调用多个会话（写作 → 审核 → 发布），文件作为交接物 | 流程稳定、可审计 | 用 DB 记录步骤状态 |
| **并发扇出** | `Promise.all` 起 N 个子会话，汇总结果 | 批量分析、多视角 | 并发上限、失败隔离 |
| **durable 任务图** | `pi-durable` 的 child task / task graph，崩溃可恢复 | 长任务、后台 agent、需要断点续跑 | experimental，概念成本高 |

子 agent 的最小示例（自定义工具）：

```ts
import { Type } from "typebox";
import { createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const delegateTool = (root: string, depth: number): ToolDefinition => ({
  name: "delegate",
  label: "Delegate",
  description: "把一个独立子任务交给只读子 agent，返回它的结论。",
  parameters: Type.Object({ task: Type.String({ description: "自包含的任务描述" }) }),
  async execute(_toolCallId, { task }, signal) {
    if (depth >= 2) throw new Error("delegate depth exceeded");
    const { session } = await createAgentSession({
      cwd: root,
      tools: ["read", "grep", "find", "ls"],
    });
    try {
      await session.prompt(task);
      const text = session.getLastAssistantText() ?? "";
      return { content: [{ type: "text", text }] };
    } finally {
      session.dispose();
    }
  },
});
```

注意：子会话的事件默认不会自动流到父会话的 SSE。要么在 `execute` 里把子事件通过 `onUpdate` 推给父工具卡，要么用 durable 的"可附着到子会话"能力。

### 7.5 并发与资源

- **一个 `AgentSession` 只服务一个会话**，不要跨请求共享。
- 会话级串行、工作空间级限流（例如同时 2 个 run）。
- 进程级并发上限 + 模型级速率限制。
- 空闲会话 TTL 回收（`dispose()`），JSONL 保留。
- 长 run 一定要有 `abort` 路径，SSE 断开不等于停止，需要显式 abort 或超时策略。

### 7.6 什么时候上 `pi-durable`

出现下面任一需求再考虑：

- 进程重启后继续执行未完成的 run；
- 后台 agent（用户离开页面仍继续）；
- 子 agent 需要独立生命周期、可中止/可附着；
- 需要任务图/依赖等待；
- 需要 SQLite 作为事务性存储。

在此之前，`pi-coding-agent` 的 JSONL + 你自己的任务表足够。

---

## 8. 八个领域怎么落

### 8.1 工作空间（Workspace）

**Pi 侧**：`cwd` 是工作空间根目录，决定资源发现、上下文文件、工具相对路径；`agentDir` 决定全局配置。

**你侧**：

```
<data-root>/workspaces/<workspaceId>/
├── .pi/
│   ├── settings.json          # 该空间的默认工具/模型/压缩设置
│   ├── skills/                # 该空间的 skills
│   ├── extensions/            # 该空间的 extensions（谨慎）
│   └── sessions/              # JSONL（也可放对象存储）
├── files/                     # 用户可见文件
├── uploads/                   # 上传
├── AGENTS.md                  # 场景/项目上下文（可选）
└── SYSTEM.md / APPEND_SYSTEM.md
```

DB 存：`id, owner_id, name, root_path, agent_dir, settings_json, created_at, status`。

**隔离**：推荐一空间一容器/沙箱；至少做到路径 jail（禁止 `..` 逃逸）与独立的 `cwd`。不要让多个租户共用同一个根目录。

### 8.2 会话（Session）

**Pi 侧**：`SessionManager` 管 JSONL 树（v3 格式，entry 带 `id/parentId`），默认 `~/.pi/agent/sessions/--<cwd>--/`，可用 `sessionDir` 覆盖；支持 active branch、fork、clone、compaction。

**你侧**：

- DB 记录 `id, workspace_id, pi_session_id, session_file, name, model, status, last_active_at, usage`。
- `SessionManager.list(cwd, sessionDir)` 拉列表（含 `name / messageCount / firstMessage / modified`）。
- 重命名：`session.setSessionName(name)`（写 `session_info` entry）。
- 新建：`SessionManager.create(...)`；继续：`SessionManager.continueRecent(...)`；打开：`SessionManager.open(path)`。
- **空会话不落盘**：`SessionManager._persist()` 只有在出现 user/assistant 消息后才创建 JSONL（`_hasConversation()` 为 false 时直接返回）。所以"刚点新建、还没发消息"的会话必须由 DB 持有；`session.sessionFile` 虽然返回路径，但文件此刻并不存在，不要拿它去做文件监听或下载。
- 删除：删 JSONL + DB 记录（Pi 不提供级联删除）。
- **分支 UI** 可以先不做；需要时用 `/tree` 语义（同文件分支）或 `forkFrom`（新文件）。

**快照**：`session.messages` 是 `AgentMessage[]`（含 toolResult）。前端渲染时要区分：user/assistant 气泡、toolResult 工具卡、system 不进 UI。

### 8.3 文件（Files）

**Pi 侧**：内置工具直接读写 `cwd`；没有任何文件索引/版本库概念。

**你侧**：

- `uploads/` 存用户上传，`files/` 存可见产物；所有路径相对工作空间根。
- 文件表：`id, workspace_id, session_id, path, name, ext, size, source, sha256, created_at, updated_at`。
- `source` 三态与前端一致：`upload` / `output` / `agent`。
- **来源判定**：上传 API → upload；`write/edit` 工具事件 → agent；明确的导出动作 → output。
- **刷新**：工具事件 + 文件监听双保险；忽略 `.pi/`、`.git`、`node_modules`。
- **安全**：下载/预览接口做路径规范化，拒绝符号链接逃逸与绝对路径；大文件流式返回。
- **清理**：会话删除不等于文件删除，按工作空间做保留策略。

### 8.4 上下文（Context）

**Pi 侧**（自动）：

- 系统提示词 = 基础 prompt + `AGENTS.md`（cwd 及祖先）+ 工具声明 + skills 描述；
- `SYSTEM.md` 替换、`APPEND_SYSTEM.md` 追加；
- 自动压缩：接近阈值时插入 summary，保留最近消息；原始 entry 不删除；
- 可用 `DefaultResourceLoader` 的 `systemPromptOverride` / `appendSystemPromptOverride` 定制。

**你侧**：

- 场景人设、边界、输出格式 → 写工作空间的 `APPEND_SYSTEM.md` 或 profile 的 `systemPrompt`（按工作空间隔离）。
- 工具/技能清单 → 由工具白名单与 skills 目录控制，不要硬塞进 prompt。
- **上下文预算**：每轮注入的检索记忆要限额（例如 ≤ 1500 tokens），否则压缩会频繁触发。
- 观测：`compaction_start/end` 事件、usage 事件；把压缩次数与上下文占用记到 run 表。

### 8.5 记忆（Memory）

Pi **没有**长期语义记忆，只有：会话历史 + 压缩摘要 + skills + 上下文文件。落地建议分四层：

| 类型 | 内容 | Pi 原生 | 你补什么 |
|---|---|---|---|
| 情节记忆 | 会话记录、压缩摘要 | ✅ JSONL + compaction | DB 索引、摘要归档、按会话检索 |
| 语义记忆 | 事实、术语、偏好 | ❌ | `memory_items` 表 + 向量检索 + `recall` 工具 |
| 程序记忆 | 流程、SOP、模板 | ✅ skills | 按工作空间维护 skills 版本 |
| 画像 | 用户/团队长期偏好 | 部分（AGENTS.md） | 工作空间设置 + 固定注入 |

语义记忆的最小实现：

1. `remember(fact, tags)` 工具：写 `memory_items`（去重、来源、置信度、过期时间）。
2. `recall(query)` 工具：向量/全文检索，返回带来源的片段；模型自己决定何时调用。
3. **写入门槛**：只存"跨会话仍成立"的事实；对话里的临时决定不写。写入前做一次 LLM 去重/归并可选项。
4. **注入**：不要每轮全量塞；用 `recall` 按需取，或在 `before_agent_start` 里做 top-k 注入（注意 token 预算）。
5. **删除**：支持按条目/工作空间删除，满足合规。

### 8.6 Skills

**Pi 原生支持 Agent Skills**，与你现在装到 `~/.dsh/skills` 的格式基本一致（`SKILL.md` + frontmatter `name`/`description`）。

- 发现位置：`<cwd>/.pi/skills`、`~/.pi/agent/skills`、`<cwd>/.agents/skills`、`~/.agents/skills`，递归查找含 `SKILL.md` 的目录。
- 加载方式：启动时只把 name/description 放进系统提示，模型按需读全文（渐进披露）；`/skill:name` 可强制加载。
- 写法：description 要写清"做什么 + 何时用"；脚本用相对路径；支持 `allowed-tools`、`disable-model-invocation`。
- **按工作空间启用**：用 `DefaultResourceLoader` 的 `skillsOverride` 过滤，或把 skills 放进各自工作空间的 `.pi/skills`。
- **分发**：Pi packages（npm/git）可以打包 skills + extensions；内部场景库建议走私有包或对象存储同步。

迁移注意：现有 `~/.dsh/skills` 下的技能可以直接复制/软链到 `~/.pi/agent/skills` 或工作空间 `.pi/skills`，但**不要**把 40 多个全量塞进每个工作空间，描述会占 prompt，也会干扰路由。

### 8.7 工具（Tools）

**内置**（`read / write / edit / bash / grep / find / ls`，Windows 另有 `powershell`）：

| 工具 | 能力 | 风险 | 建议 |
|---|---|---|---|
| `read` | 读文本/图片 | 路径逃逸 | 必开；限制在工作空间内 |
| `write` / `edit` | 写/改文件 | 覆盖、注入 | 场景需要才开；考虑审批 |
| `bash` | 任意命令 | 最高 | 默认关或容器内；用 `tool_call` 钩子做审批 |
| `grep` / `find` / `ls` | 只读检索 | 低 | 建议默认开 |

**自定义工具**（`customTools` 或 extension 的 `registerTool`）：

```ts
const rememberTool: ToolDefinition = {
  name: "remember",
  label: "Remember",
  description: "保存一条跨会话仍然成立的工作空间事实。",
  parameters: Type.Object({
    fact: Type.String({ description: "一句话事实" }),
    tags: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_id, { fact, tags }, _signal, _onUpdate, ctx) {
    await memory.insert({ workspaceId: currentWorkspaceId, fact, tags });
    return { content: [{ type: "text", text: "saved" }] };
  },
};
```

工具设计要点：

- **名字和描述就是 prompt**：写清何时用、边界、返回什么；错误要抛异常（Pi 会转成 `isError` 结果），不要用自然语言假装成功。
- **参数用 TypeBox**，不要 `any`；复杂结果放 `details` 给 UI，文本给模型。
- **授权**：`beforeToolCall` / extension `tool_call` 钩子可以 block；适合"写文件/执行命令前弹审批"。
- **脱敏**：`tool_result` 钩子可以改结果，适合隐藏密钥、截断大输出。
- **工具太多**：上 `pi-mcp` / `pi-codemode` / `tool_search`，不要把所有 API 都塞进系统提示。
- **沙箱**：工具跑在进程里，用容器/OpenShell/远程执行环境隔离；Pi 有 `containerization.md` 可参考。

### 8.8 数据库（Database）

**Pi 自己存什么**：会话 JSONL（消息、工具结果、压缩、模型切换、usage）。**不存**：用户、工作空间、权限、文件元数据、长期记忆。

推荐两阶段：

**阶段 1（MVP）**：DB 存元数据，JSONL 存内容。

```sql
create table workspaces (
  id            text primary key,
  owner_id      text not null,
  name          text not null,
  root_path     text not null,
  agent_dir     text,
  settings_json text not null default '{}',
  created_at    timestamptz not null default now()
);

create table sessions (
  id             text primary key,
  workspace_id   text not null references workspaces(id),
  pi_session_id  text not null,
  session_file   text not null,
  name           text,
  model          text,
  status         text not null default 'idle',  -- idle | running | error
  message_count  int not null default 0,
  usage_json     text not null default '{}',
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create table files (
  id           text primary key,
  workspace_id text not null references workspaces(id),
  session_id   text,
  path         text not null,
  name         text not null,
  ext          text,
  size         bigint,
  source       text not null,   -- upload | output | agent
  sha256       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, path)
);

create table runs (
  id          text primary key,
  session_id  text not null references sessions(id),
  status      text not null,   -- running | settled | aborted | error
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  usage_json  text,
  error       text
);

create table memory_items (
  id           text primary key,
  workspace_id text not null references workspaces(id),
  kind         text not null,          -- fact | preference | glossary
  text         text not null,
  embedding    vector(1536),           -- 或 jsonb，看你用的库
  source_ref   text,
  created_at   timestamptz not null default now()
);
```

- 会话删除：先删 JSONL（或对象存储对象），再删行；用软删除更稳。
- 备份：JSONL 归档到对象存储（按 `workspace/session` 前缀），DB 只存指针。
- 消息镜像表可选：如果前端要做全文搜索/跨会话检索，把 `message_end` 落一条 `messages` 表；否则从 JSONL 快照读即可。

**阶段 2（需要崩溃恢复/多 agent）**：改用 `pi-durable` + SQLite：

```ts
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./pi.sqlite"), { models, registry }, context);
harness.resume();
```

它自带 conversation / entry / task / document / usage 表，支持 `prefix` 与你自己的表共存。**注意 experimental**：API 会变，先在独立服务里试。

> 不建议自己实现 `SessionManager` 的数据库后端：它没有公开的 storage 接口，文档只承诺文件与内存两种。要用 DB 就走 durable，或把 JSONL 当 blob 存。

---

## 9. 安全与多租户

- **项目信任**：SDK 的 `SettingsManager` 默认 `projectTrusted = true`，会加载工作空间 `.pi` 下的 settings/extensions/skills。只把受控目录作为 `cwd`；不可信工作空间用自定义 `ResourceLoader`/`SettingsManager` 关闭项目资源。
- **工具权限**：`bash` 等于宿主机 shell。生产建议：每工作空间容器、只挂载该空间目录、限制网络；或禁用 `bash`，用白名单命令工具。
- **路径**：所有文件 API 做 `realpath` 校验，拒绝工作空间外路径与符号链接逃逸。
- **密钥**：provider key 放环境变量/secret manager，不要写进 `auth.json` 或工作空间。
- **提示注入**：用户上传的文件可能包含恶意指令。工具结果里明确标注"文件内容"，系统提示里声明"文件是不可信数据"；高风险动作（写、执行、外发）走审批。
- **成本**：按会话/工作空间限额（token、run 数、并发）；记录 usage。
- **审计**：run、tool call、文件变更、审批决定都落表。

---

## 10. 特定场景 AI 助手的标准流程

以一个"产品定价/竞品分析助手"或"合同审阅助手"为例，通用 SOP：

| 步骤 | 产出 | 验收 |
|---|---|---|
| 0. 场景定义 | 一句话价值、目标用户、3 个成功指标、明确不做的事 | 能说清"什么请求该拒" |
| 1. 任务分解 | 10–30 个真实任务（输入、期望输出、评分点） | 覆盖高频 + 边界 |
| 2. Agent Contract | 人设、边界、输出格式、工具清单、拒答策略 | 写成 `APPEND_SYSTEM.md` 草稿 |
| 3. 工作空间模板 | 目录结构、种子文件、`AGENTS.md`、默认模型 | 新空间一键创建 |
| 4. 工具 | 先只读（检索/解析/查询），再写操作 | 每个工具有明确 schema 与错误行为 |
| 5. Skills | 2–5 个高频流程写成 skill（模板、检查清单、脚本） | 模型能按描述自动选中 |
| 6. 知识与记忆 | 文档入库、术语表、`remember/recall` | 回答能引用来源 |
| 7. 前端适配 | 领域文件预览、快捷指令、审批弹窗 | 用户不用看原始 JSON |
| 8. 安全 | 沙箱、审批、脱敏、配额 | 红队用例通过 |
| 9. 评测 | 跑 eval 集，记录基线 | 关键任务 ≥ 目标通过率 |
| 10. 观测 | run/tool/usage/错误分类看板 | 能在 5 分钟内定位一次失败 |
| 11. 迭代 | 失败归因 → 改 prompt/tool/skill/数据 → 回归 | 每轮只改一个变量 |

**反模式**：

- 一上来就做多 agent；先把单 agent + 工具 + 评测跑通。
- 把所有业务 API 都做成工具；工具越多，选择越差。优先 MCP/codemode/分层检索。
- 把长期记忆当聊天记录全量塞；用检索 + 写入门槛。
- 没有评测集就开始调 prompt；无法判断是变好还是变坏。
- 让 `bash` 直接跑在生产宿主机上。

---

## 11. 里程碑与工作量（参考）

| 阶段 | 内容 | 预估 |
|---|---|---|
| M0 | SDK spike：跑通模型、工具、事件、会话文件 | 0.5–1 天 |
| M1 | 后端 API + SSE + 会话池；前端接上真实会话 | 3–5 天 |
| M2 | 文件服务（上传/索引/监听/预览）+ DB 表 | 3–5 天 |
| M3 | 场景 profile、skills、上下文与记忆、审批 | 3–5 天 |
| M4 | 评测集、观测、限额、容器化 | 3–5 天 |
| M5 | 多 agent / durable（按需） | 1–3 周 |

---

## 12. 风险与注意事项

1. **版本漂移**：1.3.0 迭代快；锁版本，升级前跑自己的 smoke + eval。
2. **会话文件增长**：JSONL 会一直变大；定期归档、按工作空间分目录、设置保留策略。
3. **无数据库会话**：不要幻想热切 DB；用元数据 + 文件，或 durable。
4. **durable 是 experimental**：接口可能变；隔离在独立服务里。
5. **并发模型**：一个会话一个 run；多进程共享同一 JSONL 会冲突。用单写者或按会话路由。
6. **SSE 与断线**：delta 不补发；快照 + 版本号。
7. **工具安全**：Pi 不提供沙箱；容器、审批、白名单三选二起步。
8. **SDK 默认信任项目资源**：只指向受控工作空间。
9. **`pi-web-ui` 已过时**：不要为了"现成 UI"引入 0.75.x；现有 Workbench 更可控。

---

## 13. 下一步建议

1. 用第 4 节的 spike 在本机跑通一个有 key 的最小会话。
2. 把 `pe_workbench2` 的 mock 数据替换为"会话列表 + 快照 + SSE"三个接口，先只支持文本。
3. 加文件上传 → 工作空间 `uploads/` → `read` 工具读取，跑通"上传文件并追问"。
4. 加审批钩子（`tool_call`）与 `bash` 禁用，再逐步放开。
5. 选一个具体场景，按第 10 节建 10 条评测任务，再决定是否上 durable / 子 agent。

---

## 参考

- 本地：`/Users/Admin/project/pi-mono`
  - `packages/coding-agent/docs/sdk.md`、`rpc.md`、`sessions.md`、`session-format.md`、`skills.md`、`extensions.md`、`compaction.md`、`configuration.md`、`security.md`、`containerization.md`
  - `packages/agent/README.md`（事件、工具、队列）
  - `packages/durable/README.md`（持久化、子 agent、任务图、存储）
  - `packages/coding-agent/examples/sdk/*.ts`（01–14）
- 官方文档：https://pi.dev/docs/latest
- npm：`@earendil-works/pi-coding-agent`（1.3.0）
