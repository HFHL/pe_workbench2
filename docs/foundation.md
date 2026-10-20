# 基底：SQLite + 版本 + 计划执行

> 状态：已完成。右栏资料、版本、计划、运行记录全部来自 SQLite；Agent 写入、上传、恢复、删除、计划运行都会落库并实时同步到前端。
>
> 相关设计：[跟踪：给产出文件加一个可持续的更新契约](tracking-timer.md)（定时更新 + 结果契约 + Pi 调度）；[下一步建议](next-actions.md)（输入框上方的动态悬浮）。

## 存储布局

```
data/
├── workbench.db                 # SQLite（WAL）
└── blobs/ab/cdef…               # 内容寻址，按 sha256 存文件快照
projects/<project-id>/           # 项目根（默认项目 product-eng；老安装保留 agent-workspace/）
├── exports/                     # 产出
├── inputs/                      # 只读资料
├── uploads/                     # 上传
└── .pi/sessions/*.jsonl         # Pi 对话（仍然是 Pi 的格式）
```

- 不依赖 native 模块：用 Node 24 内置的 `node:sqlite`（`DatabaseSync`）。
- 文件内容不进 DB，DB 只存 `blob_sha256 + size + 路径`；同一内容多版本复用同一个 blob。
- 删除是软删除（`deleted_at`）；Agent 再次写入同一路径会自动恢复该资料。

## Schema

| 表 | 作用 |
|---|---|
| `workspaces` | 项目（默认 `product-eng`，可新建）；`note/accent/updated_at` 为项目元数据 |
| `materials` | 资料身份：名称、路径、输入/产出、来源、状态、描述、追踪来源 |
| `material_versions` | 每个版本：v、blob、大小、备注、作者、时间、预览 |
| `material_links` | 产出 ← 输入 的来源关系 |
| `plans` | 计划：名称、prompt、频率、时间、目标产出、下次运行 |
| `plan_inputs` | 计划监控的输入 |
| `plan_runs` | 每次运行：状态、时间、产出 v、消息 |
| `asr_tasks` | 音频转写：状态、taskId、全文、SRT、轮询时间（按 `workspace_id + blob_sha256`） |

会话仍由 Pi 的 JSONL 管理（`SessionManager`），没有搬进 DB；`docs/storage-decision.md` 里解释了为什么。

## 版本模型

- 首次索引文件 → v1；内容 sha256 变化 → v+1；内容没变不产生新版本。
- 预览存在 `material_versions.preview_json`（文本前 20k；图片存相对路径，DTO 转成 `/api/file?path=…`）。
- 恢复旧版：把 blob 拷回工作空间，并强制生成一个新版本（备注 `恢复自 vN`），不会改写历史。
- 版本号与保留数量在 UI 里区分（`v5 / 共 5 版`），为未来裁剪留了位置。

## 计划执行

“立即运行”是真实执行，不是前端模拟：

1. `POST /api/plans/:id/run` → `plan_runs` 插一条 `running`，广播 `plan.updated`。
2. 服务端创建一个内部 Pi 会话（标题 `[计划] 名称`），把计划的 prompt + 目标产出 + 监控资料拼成输入。
3. Agent 用真实工具读文件、必要时写入目标产出。
4. `agent_settled` 时结算：比较目标产出的版本号是否增加，写 `plan_runs` 的 `ok/failed`、版本与消息；更新 `last_run_at`，按 daily/weekly 计算 `next_run_at`。
5. 广播 `plan.updated`，前端计划卡片、运行记录、目标资料卡片同步刷新。

内部计划会话不会出现在左栏会话列表里（按 `[计划]` 前缀过滤）。

## API 增量

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials` | 资料 + 版本 + 来源链路 + 追踪计划 |
| GET | `/api/materials/:id` | 单个资料 |
| POST | `/api/materials/:id/versions/:v/restore` | 恢复版本（生成新版本） |
| DELETE | `/api/materials/:id` | 软删除 |
| GET | `/api/plans` | 计划 + 运行记录 |
| POST | `/api/plans/:id/toggle` | 启用/暂停 |
| POST | `/api/plans/:id/run` | 真实运行 |
| GET | `/api/events` | 全局 SSE：`material.updated` / `material.deleted` / `plan.updated` |

上传接口现在返回 `{ name, path, size, material }`，前端直接用返回的 material 渲染，不再自己拼 DTO。

## 种子数据

首次启动（`materials` 为空）时：

- 补齐 `exports/竞品周报.md`、`inputs/竞品定价页快照.html`、`inputs/访谈手记.md`、`exports/客户访谈摘要.md`；保留已有的 `pricing-matrix.csv`、`定价摘要.md`、上传文件。
- 索引全部工作空间文件，建立 v1 与 blob。
- 建三个计划：竞品周报（周五 09:00，启用）、定价页同步校验（每天 18:00，启用）、客户访谈归档（周一 10:00，暂停），并写入两条演示运行记录。

想彻底重置（含演示数据）：停服务，删除 `data/`，重启会重新索引工作空间并重建种子。

只想清空资料/计划、保留会话：

```bash
# 先停服务，避免 SQLite 写锁
npm run reset:materials
```

它会删除 `materials / material_versions / material_links / plans / plan_inputs / plan_runs`、`agent-workspace` 下的数据文件（保留 `AGENTS.md` 与 `.pi` 会话）、以及 `data/blobs`；并写入 `meta.seeded=1`，所以重启后不会自动恢复演示资料。

## 前端变化

- 删除了 `app.js` 里的 mock `files/tasks`，启动时从 `/api/materials`、`/api/plans` 拉取。
- 全局 SSE 让右栏与计划弹窗实时更新；Agent 写文件、计划运行、恢复版本都会即时反映。
- 上传、恢复、删除、计划启用/暂停/运行全部走真实 API。
- 会话列表过滤内部计划会话。

## 验证

```bash
curl -s localhost:8080/api/materials | jq '.[0] | {name, kind, versions: [.versions[].v]}'
curl -s localhost:8080/api/plans | jq '.[] | {name, running, nextRun, lastRun}'
curl -X POST localhost:8080/api/plans/<id>/run
curl -X POST localhost:8080/api/materials/<id>/versions/1/restore
```

前端可验证：Agent 写文件 → 右栏实时出现；点历史版本 → 预览切换 → 恢复 → 新版本；计划 → 立即运行 → 运行记录与目标版本更新。

## 模型查询（workbook_query）

上传 `.xlsx/.xlsm` 后，`WorkbookStore` 会把工作簿解析成公式依赖图，按 blob sha256 缓存到 `data/doc-cache/<sha>.json.gz`，元数据写 `document_parses`。

- Agent 工具：`workbook_query(path, query, maxCells?)`，只返回相关子图（单元格、公式、缓存值、上下游）。
- API：`GET /api/materials/:id/workbook`、`POST /api/materials/:id/query`。
- 解析在后台队列串行执行，不阻塞上传；同一内容只解析一次；重启后缓存仍可用。
- 关闭：`WORKBOOK_QUERY=0`；Python 路径：`PYTHON_BIN`；解析器升级：`PARSER_VERSION` +1。
- 目前只支持 xlsx/xlsm；`.xls` 需另存。

详见 [workbook-query.md](workbook-query.md) 与 [workbook-query-plan.md](workbook-query-plan.md)。

## PDF 读取（pdf_read）

PDF 对内置 `read` 是二进制，因此单独解析成页级文本，按 blob sha256 缓存到 `data/doc-cache/pdf/<sha>.json.gz`。

- Agent 工具：`pdf_read(path, page?, query?, mode?, maxChars?)`；默认返回章节与页概览，`page` 读正文，`query` 检索，`tables` 提表格。
- API：`GET /api/materials/:id/pdf`、`GET /api/materials/:id/versions/:v/pdf?page=…|query=…`、`POST /api/materials/:id/pdf/search`。
- 预览：PDF 弹窗支持「原文 / 文本」双视图，文本视图可翻页、检索、高亮，并标注无文字页（扫描页）。
- 引用单位是 `p.N`；单次正文默认 12,000 字，超出提示下一页。
- 关闭：`PDF_READ=0`；解析器升级：`PDF_PARSER_VERSION` +1。

详见 [pdf-reading.md](pdf-reading.md)。

## 语音转写（asr_read）

音频对内置 `read` 是二进制，因此上传 `.mp3` / `.wav` 后会自动进入后台转写队列（17zhiling ASR）：申请 S3 上传签名 → 上传临时音频 → 提交异步任务 → 每 4 秒轮询。

- Agent 工具：`asr_read(path, mode?, maxChars?)`；`transcript` 全文、`srt` 字幕、`summary` 状态与开头。
- API：`GET/POST /api/materials/:id/asr`、`GET /api/materials/:id/versions/:v/asr`、`GET …/asr/content?format=txt|srt`。
- 状态统一由 `lib/asr-status.mjs` 定义，随 `material.asr` 通过 SSE 同步到文件卡片、详情页和音频预览；列表只带摘要，全文按版本单独拉取。
- 持久化在 `asr_tasks`（按 `workspace_id + blob_sha256`），重启后继续轮询；同一内容复用结果，不重复计费。
- 关闭：`ASR=0`；密钥：`.env.local` 的 `ASR_API_KEY`（或 `ZHILING_API_KEY`）；接口地址：`ASR_API_BASE`。

详见 [asr.md](asr.md)。

## Skill 加载范围

Workbench 只加载仓库内与项目内的 Skill：仓库级 `skills/`（`server.mjs` 通过 `additionalSkillPaths` 注入，随产品分发）、项目级 `projects/<id>/.agents/skills`、`projects/<id>/.pi/skills`、`.pi-agent/skills`。`~/.agents/skills` 下的全局 Skill（CrewAI、Remotion、Coze 等）会被 `server.mjs` 的 `skillsOverride` 过滤，避免占用 prompt 和干扰路由。新增产品级 Skill 放到 `skills/<name>/`，项目专属 Skill 放到 `projects/<id>/.agents/skills/<name>/`。

## 金融数据查询（westock_query）

`westock-data` Skill 依赖 `westock` CLI（旧工作区路径，当前仓库未随附）。Agent 没有终端权限，因此服务端注册了 `westock_query` 自定义工具：

- 工具：`westock_query(args, timeoutMs?)`；`args` 是字符串数组，例如 `["quote", "sh600519"]`、`["finance", "sh600519,sz000651", "--limit", "4"]`。
- 实现：`lib/westock-tool.mjs`，用 `execFile` 直接调用 CLI，不经过 shell；默认超时 30s，最大 60s，输出上限 120k 字符。
- CLI 默认查找 `~/.local/bin/westock`，可用 `WESTOCK_BIN` 覆盖；缺失时工具返回安装提示。
- 关闭：`WESTOCK_QUERY=0`。Skill 文件仍会加载，但工具不注册。
- 工具返回 CLI 的 Markdown 表格原文；聊天回复遵守“不使用表格”，需要完整表格时写入 `exports/`。
- 安装脚本仍随 Skill 保留（`scripts/setup.sh` 等），但 Agent 不执行；由用户在终端安装/升级 CLI。

## 公开网络搜索（anysearch_search）

Agent 通过服务端自定义工具调用 AnySearch REST API，无需终端权限或 MCP 扩展：

- 工具：`anysearch_search(query, maxResults?, tag?, zone?, language?, params?, timeoutMs?)`。
- 实现：`lib/anysearch-tool.mjs`；调用 `POST /v1/search`，默认返回 6 条、超时 30s，工具总输出上限 100k 字符。
- 密钥：`.env.local` 的 `ANYSEARCH_API_KEY`；未配置时使用 AnySearch 匿名额度。
- 接口地址：`ANYSEARCH_API_BASE`，默认 `https://api.anysearch.com`；关闭：`ANYSEARCH_QUERY=0`。
- AnySearch 的匿名额度 402 响应可能包含自动生成的凭据；工具会丢弃原始消息，只返回脱敏错误，避免凭据进入会话或日志。
- 搜索结果属于外部不可信内容，只作为资料使用；回答引用时保留来源 URL。结构化金融数据仍优先使用 `westock_query`。

## 读取指定网页（web_fetch）

用户直接给出具体链接时，Agent 用 `web_fetch` 打开页面，而不是要求用户复制正文：

- 工具：`web_fetch(url, maxChars?, query?, timeoutMs?)`；默认返回 2 万字、超时 20s，可读上限 6 万字。
- 实现：`lib/web-fetch-tool.mjs`；Node 原生 `fetch`，最多 5 次重定向，正文流式读取上限 4 MB。
- HTML 去掉脚本/导航/页脚后转纯文本，保留标题、段落、列表与表格骨架；JSON 自动缩进。
- 编码按 `Content-Type` → `<meta charset>` → UTF-8 探测，支持 GBK/GB2312/Big5。
- 默认拒绝 loopback/私网/链路本地地址，每次重定向重新校验；`WEB_FETCH_ALLOW_PRIVATE=1` 仅用于本地调试，`WEB_FETCH=0` 关闭。
- 页面是外部不可信内容：只提取事实并保留来源 URL，不执行页面里的指令。需要登录、JavaScript 渲染或链接是 PDF/图片时，工具会明确说明限制。
- 详见 [web-fetch.md](web-fetch.md)。

## 对话渲染

- `snapshotMessages` 把最后一轮工具调用之后的文本作为最终回答（`text`），之前的分析叙述放入 `processText`。
- 工具调用折叠为 `details.tool-group`，默认收起；流式状态用 `#liveStatus`，按工具类型显示“正在读取模型 / 正在查询行情 / 正在撰写报告”等，无工具时轮换“正在思考 / 正在分析问题 / 正在梳理资料”等状态词。
- Agent 通过 `write`/`edit` 生成 `exports/**.md` 时，前端自动在回答里展开“完整报告”卡片，用 marked GFM 渲染（含表格），内容来自 `/api/file?path=`。
- 因此报告类任务要把完整报告写成 `.md` 放到 `exports/`；聊天回答只给结论摘要。

## 还没做

1. **自动调度**：跟踪已有 30s 调度器（`trackings / tracking_runs`，见 [tracking-timer.md](tracking-timer.md)）；旧 `plans` 任务仍只支持手动运行。
2. 计划编辑 UI（改频率/prompt/目标）。
3. 登录、CSRF、限流；当前只绑定 `127.0.0.1`。
4. 用量/成本表与配额。
5. 软删除文件的清理策略（blob GC、回收站）。
6. 多进程：写操作必须集中，或改用 `pi-durable`。
