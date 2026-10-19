# 项目：多项目空间

> 状态：已完成。原来的“工作空间 / 项目空间”统一改称**项目**。切换项目后，左栏会话、右栏资料、计划、跟踪和 Agent 工作目录都会切换到该项目自己的数据。

## 边界

一个项目是一个独立的目录 + 一组数据库记录：

```
projects/<project-id>/           # 每个项目的根目录（默认项目也是 projects/product-eng）
├── exports/                     # 产出
├── inputs/                      # 只读资料
├── uploads/                     # 上传
├── .tracking/                   # 跟踪运行结果
├── .pi/sessions/*.jsonl         # 该项目的 Pi 会话
└── .agents/skills/              # 项目级 Skill
```

- 老安装如果还存在 `agent-workspace/`，会继续把它当作默认项目根，避免 Pi 会话头里的 `cwd` 失效。
- 全新安装的默认项目在 `projects/product-eng/`，新项目在 `projects/<id>/`，目录结构相同。
- 每个项目在 SQLite 的 `workspaces` 表里有一行（`id` 即项目 id）；`materials`、`plans`、`trackings` 通过 `workspace_id` 隔离。
- 文件路径仍然以项目根为相对路径（如 `uploads/x.md`），展示时才拼上项目根标签。

## 切换项目时发生什么

1. 关闭文件、计划、跟踪弹窗，断开旧项目的 SSE。
2. 清空 `state.sessions / files / tasks / pending / messages`、已选资料和请求缓存。
3. 用 `?project=<id>` 重新拉取会话、资料、计划；跟踪面板 `reset()` 后重新加载。
4. 新项目没有会话时自动创建一个空会话。
5. 当前项目写入 `localStorage.workbench.project`，刷新后保持。

## API

所有项目数据接口都要求带 `project` 查询参数（缺省回落到默认项目），因此多标签页同时打开不同项目也不会串数据。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 创建项目 `{ name, note }`，同时建目录 |
| PATCH | `/api/projects/:id` | 改名 / 改备注 |
| GET | `/api/sessions?project=` | 该项目会话 |
| GET | `/api/materials?project=` | 该项目资料 |
| GET | `/api/plans?project=` | 该项目计划 |
| GET | `/api/trackings?project=` | 该项目跟踪 |
| GET | `/api/events?project=` | 该项目全局 SSE |

## 服务端

- `contexts: Map<projectId, ProjectContext>`；每个上下文有自己的 `store`、`workbooks`、`previews`、`tools`、`sessionsDir`、`uploadsDir`。
- `createEntry({ id, file, ctx })` 用项目根作为 `cwd`，Skill 也只加载当前项目内的。
- 计划/跟踪调度器遍历所有上下文；每个运行都落回它所属项目的材料与版本。
- 全局 SSE 按 `project` 过滤；会话 SSE 仍然按 session 隔离。

## 迁移

- 旧数据库启动时自动补 `note / accent / updated_at` 列，旧工作空间成为默认项目。
- 旧的 `agent-workspace/` 不移动；如果它不存在，默认项目落在 `projects/product-eng/`。
- 已有资料、计划、跟踪、会话无需迁移。
- 演示数据是显式 opt-in：只有 `WORKBENCH_SEED=1` 才会写入示例资料和计划；全新启动默认为空。
