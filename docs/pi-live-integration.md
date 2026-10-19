# Pi Agent × Workbench：真实接入说明

当前状态：**前端已经接上 Pi Agent，真实调用 DeepSeek 模型，工具执行、流式输出、会话持久化、文件上传都已经跑通。**

> 多项目：原来的“工作空间”已改称“项目”。每个项目有独立的目录、资料、计划和会话，接口通过 `?project=` 隔离。详见 [projects.md](projects.md)。

## 启动

```bash
cd /Users/Admin/project/pe_workbench2
npm install          # 已安装 @earendil-works/pi-coding-agent
npm start            # node server.mjs
# http://127.0.0.1:8080
```

`.env.local`（权限 600，已加入 `.gitignore`）：

```
DEEPSEEK_API_KEY=...   # 只放在环境文件里，不写进代码
PI_MODEL=deepseek-v4-pro
```

服务默认只监听 `127.0.0.1`，不对外网开放。

## 架构

```
浏览器 (index.html / app.js)
   │  REST + SSE
   ▼
server.mjs (Node http)
   │  @earendil-works/pi-coding-agent SDK
   ▼
AgentSession  ──  pi-agent-core  ──  pi-ai  ──  https://api.deepseek.com
   │
   ├─ 会话 JSONL: agent-workspace/.pi/sessions/*.jsonl
   └─ 工具读写: agent-workspace/{exports,uploads,inputs}
```

- 每个会话一个 `AgentSession`；事件订阅后转成 SSE 广播。
- 模型：`deepseek-v4-pro`（可在界面里切到 `deepseek-flash`）。
- 工具：`read / write / edit / grep / find / ls`，**没有启用 bash**。
- 系统提示：Workbench 人设 + 工作空间约定 + 中文/简洁/Markdown（无表格）。

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 模型、工作空间 |
| GET | `/api/sessions` | 会话列表（Pi JSONL + 内存中的空会话） |
| POST | `/api/sessions` | 新建空会话 |
| GET | `/api/sessions/:id/state` | 消息快照、流式状态、模型 |
| GET | `/api/sessions/:id/events` | SSE：snapshot / delta / tool / settled |
| POST | `/api/sessions/:id/messages` | 发送文本 + 附件路径 |
| POST | `/api/sessions/:id/abort` | 停止当前运行 |
| POST | `/api/sessions/:id/model` | 切换 `deepseek-v4-pro` / `deepseek-flash` |
| GET | `/api/materials` | 工作空间里的真实文件 |
| POST | `/api/upload` | 上传到 `agent-workspace/uploads/` |
| GET | `/api/file?path=` | 预览/下载工作空间文件 |

SSE 事件：`snapshot`、`run.started`、`assistant.delta`、`tool.started`、`tool.updated`、`tool.completed`、`run.settled`、`session.updated`、`material.saved`、`run.error`；跟踪域另有 `tracking.updated`、`tracking.deleted`。

## 前端改动

- 会话列表与消息改为真实数据；首次进入自动创建空会话。
- 流式渲染：`assistant.delta` 追加文本；工具调用显示为工具行（读取/写入/检索…），失败标红。
- 发送时展示停止按钮（运行中），可中止。
- 上传：文件真实落到 `uploads/`，作为输入出现在右栏，并在发送时把路径带给 Agent。
- Agent 写文件时，`material.saved` 实时在右栏新增/更新卡片；刷新后 `/api/materials` 会把工作空间文件补回来。
- Markdown 基础渲染：标题、列表、粗体、行内代码、代码块、链接。
- 会话标题取第一条消息的短标题；会话、模型、消息全部来自后端。

## 安全与边界

- API key 只在 `.env.local` / 进程环境里，代码和日志都不打印。
- `beforeToolCall` 拦截工作空间外的路径：`read /etc/passwd` 会返回“只能访问工作空间内的路径”。
- 工具没有 bash，写入限制在 `agent-workspace` 内（约定 + 路径守卫）。
- 上传文件名做了清洗，单文件上限 30 MB。
- 服务只绑定本机回环地址。

## 持久化

- 会话：`agent-workspace/.pi/sessions/*.jsonl`，服务重启后自动恢复并出现在左栏。
- 空会话（还没发消息）只在内存里，重启后消失——这是 Pi 的持久化规则。
- 文件：`agent-workspace/` 下的真实文件；资料索引在 SQLite 里，首次启动时从目录索引。

## 数据层

基底已经落到 SQLite（`data/workbench.db`）：资料、版本、输入产出关系、计划、运行记录都来自数据库，文件内容存内容寻址 blob。右栏不再有 mock 数据。详见 [foundation.md](foundation.md)。

## 已知限制 / 下一步

1. **计划任务手动触发**：旧 `plans` 任务仍手动运行；新的“跟踪”已有 30s 调度器（`trackings / tracking_runs`）。
2. **单进程**：多个 worker 需要把写操作集中，或换 `pi-durable`。
3. **计划编辑**：目前只能在种子数据/DB 里改 cron 与 prompt。
4. **模型切换不跨重启**：`setModel` 默认只改当前会话运行时。
5. **无鉴权**：本地单人使用；对外部署前加登录、CSRF、限流。
6. **deepseek-v4-pro 只接受文本**：图片上传可以存文件，但当前模型不能直接看图。
7. **标题是截断的第一条消息**：后续可让模型生成会话标题。
