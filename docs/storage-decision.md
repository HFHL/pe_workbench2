# 存储选型：SQL、JSON 文件，还是混合？

> 面向当前 Workbench / Pi harness 的数据：工作空间、会话、输入、产出、版本、计划、运行记录、文件内容、Agent 会话。

## 结论

**不是二选一，而是三层混合：**

| 数据 | 存储 | 理由 |
|---|---|---|
| 工作空间、会话元数据、资料（materials）、版本、输入产出关系、计划、运行记录、用量、搜索索引 | **SQLite** | 关系多、要事务、要按时间/状态/计划查询、要并发读写 |
| 文件内容（md、csv、png、pdf、导出物） | **文件系统**（内容寻址 blob） | 体积大、要直接给前端下载/预览、备份与迁移独立 |
| Pi 的会话 JSONL | **文件系统**（Pi 自己管理） | 这是 Pi 的持久化格式与上下文权威，不要重写；DB 只存路径与元数据 |
| skills、prompts、extensions、themes、settings | **文件**（Markdown / JSON） | Pi 从磁盘发现资源；人类可编辑、可进 Git |
| 原始事件 / 审计日志（可选） | **JSONL 追加** + 关键字段进 DB | 追加写简单；可查询的放 SQLite |

一句话：**元数据进 SQLite，字节进文件系统，Pi 会话保持 JSONL，配置保持文件。**

## 为什么不能只用 JSON 本地文件

你的场景恰好踩中 JSON 文件最不擅长的几件事：

1. **版本是关系**：每个资料有 N 个版本，还要查"某输入被哪些产出引用""某计划最近产出了哪些版本"。JSON 要么全量加载再过滤，要么维护多份冗余索引。
2. **计划 + 运行是一组原子写**：一次计划运行要同时「新增版本 + 写运行记录 + 更新下次运行时间 + 记用量」。多文件 JSON 没有事务，中途崩溃就是半套数据；SQLite 一个事务解决。
3. **并发写**：Node 服务、调度器、Agent 工具会同时写。JSON 只能整文件重写 + 自己加锁，容易丢更新；SQLite WAL 支持多读一写。
4. **长期追踪会无限增长**：裁剪保留版本、按工作空间删除、按时间归档，SQL 是一句 `delete ... where`；JSON 要重写整个文件。
5. **查询与分页**：右栏"最近 7 天被计划更新过的产出"、按状态过滤、全文搜索——SQL 有索引和 FTS5；JSON 全靠内存扫。
6. **崩溃安全**：SQLite 的事务 + WAL 是现成的；JSON 的 `writeFileSync` 不是原子的，需要临时文件 + rename，且多文件仍不原子。

JSON 文件仍然适合：配置、skills、prompt 模板、Pi 会话、可读的导出快照。**不适合作为运行时主库。**

## 为什么现在不上 Postgres

- 单机、单用户/小团队、数据量在十万行以内，SQLite 足够；零运维、单文件备份、随应用分发。
- Schema 可以按 Postgres 的写法设计（text/timestamptz/jsonb 的等价物），以后换库主要是驱动与迁移，不是重写。
- 真到多租户/多实例/需要行级权限时再迁 Postgres；届时 SQLite 的 schema 与 repository 层可以直接复用。

## SQLite 落地规范

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

- 只有一个写连接（`better-sqlite3` 同步 API 很适合单进程服务）；读可以多连接。
- 多进程/worker 时，写操作集中到一个 store 服务，或用写队列，不要让两个进程同时写。
- 时间统一存 UTC ISO8601 文本（或整数毫秒，二选一，全库一致）。
- 主键用 UUIDv7 / ULID 文本；版本号用 `integer`，每个资料从 1 递增。
- 迁移用 `PRAGMA user_version` + 有序 SQL；或 Drizzle/Kysely 的 migration。
- 备份用 `VACUUM INTO 'backup-YYYYMMDD.db'`，不要热拷贝 db 文件。

### 核心表（与前端字段一一对应）

```sql
create table workspaces (
  id text primary key,
  name text not null,
  root_path text not null,
  settings_json text not null default '{}',
  created_at text not null
);

create table sessions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  pi_session_id text,
  session_file text,
  name text,
  model text,
  status text not null default 'idle',
  created_at text not null,
  last_active_at text not null
);

create table materials (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  session_id text references sessions(id) on delete set null,
  name text not null,
  path text not null,
  ext text,
  mime text,
  kind text not null check (kind in ('input','output')),
  source text not null check (source in ('upload','agent','task','import')),
  status text not null,
  origin text,
  task_id text,
  created_at text not null,
  updated_at text not null,
  deleted_at text,
  unique (workspace_id, path)
);

create table material_versions (
  material_id text not null references materials(id) on delete cascade,
  v integer not null,
  blob_sha256 text not null,
  size integer not null,
  note text not null default '',
  author text not null,
  created_at text not null,
  preview_json text,
  primary key (material_id, v)
);

create table material_links (
  material_id text not null references materials(id) on delete cascade,
  input_id text not null references materials(id) on delete cascade,
  primary key (material_id, input_id)
);

create table plans (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  cron text,
  schedule_label text not null,
  timezone text not null,
  enabled integer not null default 1,
  target_id text references materials(id) on delete set null,
  next_run_at text,
  last_run_at text
);

create table plan_inputs (
  plan_id text not null references plans(id) on delete cascade,
  material_id text not null references materials(id) on delete cascade,
  primary key (plan_id, material_id)
);

create table plan_runs (
  id text primary key,
  plan_id text not null references plans(id) on delete cascade,
  started_at text not null,
  ended_at text,
  status text not null,          -- running | ok | failed
  version integer,
  message text
);

create table usage_events (
  id text primary key,
  session_id text references sessions(id) on delete set null,
  run_id text,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost real,
  created_at text not null
);

create virtual table material_fts using fts5(name, note, content='');
```

索引：

```sql
create index idx_materials_ws_updated on materials(workspace_id, updated_at desc);
create index idx_materials_ws_kind on materials(workspace_id, kind, status);
create index idx_versions_material on material_versions(material_id, v desc);
create index idx_plans_next on plans(enabled, next_run_at);
create index idx_runs_plan_started on plan_runs(plan_id, started_at desc);
create index idx_links_input on material_links(input_id);
```

### 一次计划运行 = 一个事务

```ts
const applyRun = db.transaction((planId: string, materialId: string, version: number, blob: string, size: number) => {
  db.prepare(`insert into material_versions (material_id, v, blob_sha256, size, note, author, created_at)
              values (?, ?, ?, ?, ?, '计划任务', ?)`).run(materialId, version, blob, size, '自动更新', now());
  db.prepare(`update materials set updated_at = ?, status = 'final' where id = ?`).run(now(), materialId);
  db.prepare(`update plans set last_run_at = ?, next_run_at = ? where id = ?`).run(now(), nextRun(planId), planId);
  db.prepare(`insert into plan_runs (id, plan_id, started_at, ended_at, status, version)
              values (?, ?, ?, ?, 'ok', ?)`).run(runId(), planId, startedAt, now(), version);
});
```

## 文件内容怎么放

```
data/
├── app.db
├── blobs/
│   └── 9f/2a/9f2a…（sha256，内容寻址，跨版本复用）
└── workspaces/<workspaceId>/
    ├── files/               # 用户可见路径（硬链接或软链到 blob）
    ├── uploads/
    └── .pi/                 # skills / extensions / settings / sessions/*.jsonl
```

- 数据库存 `blob_sha256 + size + path`，不存大 BLOB。
- 同一文件多个版本没变化时复用同一个 blob，只新增 `material_versions` 行。
- 删除资料先软删（`deleted_at`），保留 blob 一段时间再 GC，避免误删和任务引用失效。
- 预览只存小片段（几千字符）或缩略图路径，不存全文。

## Pi 会话怎么处理

- 会话文件保持在 `<workspace>/.pi/sessions/*.jsonl`，由 Pi 的 `SessionManager` 管理；`sessions` 表存 `session_file` 与元数据。
- 需要跨会话搜索时，在 `entry_appended` / `message_end` 时把消息镜像到 `messages` 表（含 `session_id`、`pi_entry_id`、`role`、全文）。
- 不要让数据库成为 Pi 上下文的唯一来源；Pi 的 JSONL 是权威，重建会话时用 `SessionManager.open(path)`。
- 需要数据库原生会话/崩溃恢复时，再评估 `pi-durable` 的 SQLite 存储（experimental）。

## 什么时候 JSON 就够了

只有满足全部条件时才考虑纯 JSON：

- 纯原型 / 演示，没有真实的版本与计划；
- 单进程、单用户，不存在并发写；
- 数据量小（几百条以内），不需要跨实体查询；
- 不需要崩溃恢复与保留策略。

即使满足，也建议**元数据从第一天就放 SQLite**——迁移成本远低于后期补。

## 迁移到 Postgres 的时机

- 多实例部署、需要行级权限或多租户隔离；
- 写入并发超出单写连接；
- 需要在线备份、只读副本、分析查询；
- 文件与数据库需要分机部署。

在此之前，SQLite + 文件系统是最合适的组合。

---

实现建议：在 `app.js` 与服务之间加一层 `repository`（`listMaterials`, `getMaterial`, `createVersion`, `runPlan` 等），前端只依赖 DTO；这样从 mock 内存数据切到 SQLite，再切到 Postgres，都不需要动界面。
