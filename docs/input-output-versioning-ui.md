# 输入 / 产出 / 版本 / 计划：界面与数据模型

> 这是把 Workbench 前端从"文件列表"推进到"资料资产"的一版实现说明。当前仍是纯前端 mock（`app.js` 内存数据），但信息架构、metadata 字段与交互已经按可接后端的形态设计。

## 1. 信息架构

```
┌────────────┬─────────────────────────┬──────────────────────────────┐
│ 工作空间    │ 对话                     │ 资料 / 计划                   │
│ 会话列表    │  · 消息流（含资料引用）    │  [全部] [输入] [产出] [计划]   │
│            │  · 输入框 / 上传           │  卡片：状态 · 版本 · 来源       │
│            │                         │  点击 → 详情 / 版本 / 追踪      │
└────────────┴─────────────────────────┴──────────────────────────────┘
```

右栏回答三个问题：**这是什么（输入还是产出）· 现在哪一版 · 谁在维护它**。计划是独立 tab，因为它是"让产出持续更新"的驱动源。

## 2. 输入与产出的边界

| 类型 | 定义 | 谁写入 | 版本含义 | 默认状态 |
|---|---|---|---|---|
| **输入 input** | 外部资料、上传件、抓取快照、源表 | 用户上传 / 计划任务抓取 / Agent 同步 | 每次同步的快照 | 已同步 |
| **产出 output** | 文档、报告、图片、变更说明 | Agent / 计划任务 | 每次编辑或重写 | 草稿 / 更新中 / 已定稿 |

规则：

- 用户上传 → `input` + `source: upload`，v1。
- Agent 生成或改写 → `output` + `source: agent`，新增版本。
- 计划任务抓取 → `input` + `source: task`，新增同步版本。
- 计划任务生成报告 → `output` + `source: task`，新增版本。
- 输入是"证据"，尽量只追加；产出是"结论"，允许恢复旧版。

## 3. Metadata

每个资料对象：

```ts
type Material = {
  id: string;
  workspaceId: string;
  sessionId?: string;          // 关联会话
  name: string;
  path: string;                // 工作空间内相对路径
  ext: string;
  mime: string;
  kind: 'input' | 'output';
  source: 'upload' | 'agent' | 'task' | 'import';
  status: 'draft' | 'review' | 'final' | 'synced' | 'stale' | 'live';
  origin?: string;             // 追踪来源：URL / 表格连接
  taskId?: string;             // 哪个计划在维护它
  derivedFrom?: string[];      // 上游输入
  versions: Version[];         // 新的在前
  createdAt: string;
  updatedAt: string;
  sha256?: string;
  retention?: { keep: number }; // 长追踪场景的保留策略
};

type Version = {
  v: number;
  at: string;                  // 版本时间
  by: '林默' | 'Workbench' | '计划任务' | string;
  note: string;                // 这次改了什么（一句话）
  size: number;
  sha256?: string;
  preview?: { type: 'text'; text: string } | { type: 'image'; url: string } | { type: 'none' };
};
```

计划任务：

```ts
type Plan = {
  id: string;
  name: string;
  schedule: { cron?: string; label: string; timezone: string }; // 例：每周五 09:00
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  targetId?: string;           // 产出（新版本写到这里）
  inputIds: string[];          // 监控的输入
  history: Array<{ at: string; ok: boolean; note: string; version?: number }>;
};
```

界面上体现的字段（卡片 → 弹窗）：

| 字段 | 卡片 | 弹窗 |
|---|---|---|
| 名称 / 版本 | ✓（`v4` 角标） | ✓ |
| 输入 / 产出 | ✓ 徽标 | ✓ 元数据 |
| 状态 | ✓ 状态点 + 文案 | ✓ |
| 大小 / 时间 | ✓ | ✓ |
| 来源 | — | ✓（本地上传 / Workbench / 计划任务） |
| 关联会话 | — | ✓ |
| 追踪来源 | — | ✓（URL / 连接） |
| 上游输入 | — | ✓ 可点击跳转 |
| 计划 / 下次运行 | ✓ 追踪行 | ✓ 追踪条 |
| 版本历史 | — | ✓ 列表 + 选择 + 恢复 |

## 4. 卡片的信息层级

```
[图标] 名称.md                    v4
       ● 已定稿 · 6.8 KB · 14:18  产出
       ↻ 追踪 · 每天 18:00
```

- 第一行：名称（截断）+ 版本角标。
- 第二行：状态点、大小、时间、类型徽标。
- 第三行（仅被计划维护的资料）：追踪/同步频率。这行是"长期追踪"在列表里的存在感，没有它，版本和计划的关系只能进弹窗才知道。

列表按 `今天 / 昨天 / 更早` 分组；筛选 tab 改变集合，不改变分组。

## 5. 详情弹窗

从上到下：

1. **头部**：图标、文件名、工作空间路径。
2. **元数据**：文档状态、来源、版本时间、版本号、关联会话、追踪来源。
3. **来源链路**：`来自 pricing-matrix.csv v3`——输入 → 产出的可追溯关系。
4. **追踪条**：`计划任务 · 定价页同步校验  下次 今天 18:00`，点击直接打开计划。
5. **版本/同步记录**：每行 `v2 · 一句话说明 · 时间 · 作者 · 大小`；当前版本有"当前"标；点任意一行，预览与元数据切到该版本。
6. **预览**：文本 / 图片 / 无预览。
7. **操作**：复制路径、恢复为 vN（选中历史版本时出现）、删除、下载。

版本号与保留：`v12 / 保留最近 2 版`——长期追踪会裁剪历史，界面要区分"最新版本号"和"当前保留数量"，不能写成"共 2 版"。

## 6. 计划任务

- 右栏 `计划` tab：任务卡片显示名称、启用状态、频率、下次运行、上次结果与产出。
- 详情弹窗：频率、状态、下次/上次运行、目标产出、监控资料（可点击）、运行记录（时间 / 成功失败 / 耗时 / 产出 vN）。
- 动作：暂停/启用、立即运行。运行后**给目标产出追加一个新版本**，而不是新建一个文件——这是长期追踪的关键，版本历史才连得起来。
- 失败要保留在运行记录里，并且不产生新版本。

## 7. 接后端时要补的表 / 接口

```sql
-- 资料与版本
create table materials (
  id text primary key, workspace_id text not null, session_id text,
  name text not null, path text not null, ext text, mime text,
  kind text not null, source text not null, status text not null,
  origin text, task_id text, created_at timestamptz, updated_at timestamptz
);
create table material_versions (
  material_id text not null references materials(id),
  v int not null, at timestamptz not null, by text not null,
  note text, size bigint, sha256 text, preview jsonb,
  primary key (material_id, v)
);
create table material_links (
  material_id text not null, input_id text not null, primary key (material_id, input_id)
);

-- 计划与运行
create table plans (
  id text primary key, workspace_id text not null, name text not null,
  cron text, schedule_label text, timezone text,
  enabled boolean, target_id text, next_run_at timestamptz, last_run_at timestamptz
);
create table plan_inputs (plan_id text, material_id text, primary key (plan_id, material_id));
create table plan_runs (
  id text primary key, plan_id text not null, started_at timestamptz,
  ended_at timestamptz, status text, version int, message text
);
```

接口：`GET /materials?kind=&status=`、`GET /materials/:id`（含 versions）、`GET /materials/:id/versions/:v`、`POST /materials/:id/versions/:v/restore`、`GET/POST /plans`、`POST /plans/:id/run`、`POST /plans/:id/enable`。

实时：`file.created` / `file.version.created` / `plan.run.started` / `plan.run.finished`，右栏与计划卡片靠事件刷新。

## 8. 还没做（下一轮）

- 版本 diff（文本行级、表格列级）与"和上一版比"。
- 版本保留策略 UI（保留全部 / 最近 N / 按时间）。
- 计划编辑器（cron、时区、失败重试、通知）。
- 输入反查：这份输入被哪些产出引用。
- 审批：产出定稿、删除、恢复旧版前的人工确认。
- 版本评论 / 变更原因。

---

当前实现：`index.html` / `styles.css` / `app.js`，本地服务 `http://127.0.0.1:8080`。数据在 `app.js` 的 `state`，刷新即重置。
