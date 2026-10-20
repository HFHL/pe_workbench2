---
name: monitoring-setup
description: 建立或调整投资框架的自动监测契约。读 analysis-state.json 与报告，把失效条件整理成 MON 监测项，和投资人逐项确认指标、来源、频率、阈值、自治级别，试取数后写回状态与报告。用户说“开始跟踪/建立监测/盯这几个点/调整监控”时使用。
---

# 建立监测契约

不是再写一份报告，而是把“什么情况下我们错了”变成后台可以逐条执行的合同：**每个 MON 对应一个 F（失效条件）**，有指标、来源、频率、预警/失效阈值、触发动作、自治级别和下次检查日。

## 开始前

- 读同目录的 `analysis-state.json`（事实源）和投资框架报告；没有状态文件就停下，先让用户跑 `investment-framework` 补建，不要凭空造监测项。
- 读报告第 6 节（“什么情况下我们错了”/失效条件）。表里的每一行都应能对应到一个 `F`；没有 ID 的，先补 ID，不改变原判断。
- 读模型文件与已有的 `monitoring` 字段（若有），保留稳定 ID。

## 执行顺序

### 1. 提取候选

对每个 `falsifier` 整理：

- MON 编号（稳定，`MON1`…，与 `falsifier_id` 一一对应）
- 关联观点 `T`
- 指标（`metric`，必须可观测、带口径）
- 来源（`source`，具体到机构/公告/接口 + 频率）
- 频率（`daily / weekly / monthly / quarterly / event`）
- 预警阈值（`warning`）
- 失效阈值（`threshold` + `operator`）
- 触发动作（`action`）
- 阈值依据（`rationale`）
- 当前观察值（`last_observed`）与检查日（`last_checked_at`）
- 自治级别（`autonomy`：`observe / propose / auto_notify / auto_silent`）

**一条 F 只对应一个监测项**；不要为了“看起来完整”把一条拆成多条。

### 2. 和投资人确认

不要直接激活。逐项问清楚：

1. 指标能不能取到数？口径是什么？
2. 主来源是什么？有没有备用来源？来源等级（S1 公告/财报、S2 行业机构/主流媒体、S3 高频资讯、S4 传闻）？
3. 多久查一次？和披露节奏匹配吗？
4. 预警/失效阈值是否沿用框架？改阈值必须由用户明确同意。
5. 触发后允许做到哪一步：只提醒 / 改观点和报告 / 连模型一起改？
6. 通知方式：站内 / 桌面 / 都要？

如果某一项没有公开数据源（如 HBM 良率），**不要建 watcher**：

- 标为 `gap`，说明缺什么；
- 改成事件型（公告/调研/上传资料触发）；
- 或让用户手工录入观察值。

### 3. 试取数

用现有工具做一次 dry-run：

- 结构化财务/行情/公告：`westock_query`；
- 公开新闻/网页：`anysearch_search`，保留 URL 与日期；用户给出具体链接时用 `web_fetch` 读正文；
- 本地资料：`pdf_read` / `read`。

能取到的填当前值；取不到的写 `unknown`，并写清“缺什么、哪个来源、下次什么时候再试”。不要用旧值或模型缓存值冒充本期观察。

### 4. 写回状态

在 `analysis-state.json` 的每个 `falsifiers[]` 上补齐（保留原有字段，不要删）：

```json
{
  "monitor_id": "MON1",
  "autonomy": "auto_notify",
  "next_check_at": "2026-11-15",
  "source_query": "长鑫存储 DRAM 合约价 季度 环比",
  "source_tier": 2,
  "warning": "2026Q3/Q4 涨幅收窄至 20% 以下",
  "operator": "crosses_below",
  "threshold": "2027 年前价格明显回落、毛利率跌至 60% 以下"
}
```

- `monitor_id` 一旦分配不复用；
- `autonomy` 默认 `auto_notify`；用户要求“先只提醒”时用 `propose`；
- `next_check_at` 按频率算：日频 +1 天、周频 +7 天、月频 +1 月、季频 +3 月；事件型留空；
- `source_tier`：S1=1、S2=2、S3=3、S4=4；
- 不改变原 `id`、`thesis_id`、`action` 语义。

### 5. 写回报告

报告第 6 节的表由状态生成/校对，至少包含：

`跟踪项 | 关联判断 | 指标 | 来源 | 频率 | 预警阈值 | 失效阈值 | 触发后的动作 | 阈值依据 | 证据`

- 保留原有小节与文字；新增列或行只追加；
- 表中的 MON 编号必须与状态里的 `monitor_id` 一致；
- 不要把“观察值”写成“已触发”；状态未触发就写当前观察或 `unknown`。

### 5.1 模型写回（可选）

如果用户希望 Agent 在触发时直接改模型：

1. 让用户在跟踪详情里点 **“准备工作模型”**；宿主会把 `subject.model_file` 复制成 `exports/.../model/工作模型.xlsx`，并写入 `state.model.working_file`。
2. 用 `workbook_query` 找**输入单元格**（假设、驱动）和**输出单元格**（目标价、收入、毛利率），写进 `state.model`：

```json
{
  "working_file": "exports/.../model/工作模型.xlsx",
  "write_enabled": true,
  "bindings": [
    { "metric": "HBM 营收占比", "sheet": "Assumption", "cell": "AA54", "kind": "input", "verified": true }
  ],
  "outputs": [
    { "label": "目标价", "sheet": "Discount PE", "cell": "H29" }
  ]
}
```

- 只有用户确认过的映射才写 `verified: true`；没确认的保留 `false`。
- `write_enabled` 只有在映射确认后才设为 `true`。
- 不要绑定公式单元格；写回只允许输入单元格。
- 没有可靠映射时，不要启用模型写回，让 Agent 只出变更计划。

### 5.2 用自然语言建立跟踪

确认方案后，调用宿主工具 **`create_tracking`**：

```json
{
  "targetPath": "exports/.../投资框架报告.md",
  "freq": "weekly",
  "weekday": 1,
  "time": "09:00",
  "template": "framework",
  "activateMonitors": true
}
```

- 目标文件必须已经在右栏资料里；
- 有 `analysis-state.json` 时 `activateMonitors=true` 会把 falsifiers 激活成 MON，并创建来源轮询；
- 工具返回下次运行时间和监测项数量；不要再让用户去界面手动建一次；
- 没有确认前不要调用。

### 6. 交付与激活

完成后告诉用户：

- 本次建了几个 MON、哪些能自动取数、哪些是 `unknown`/`gap`；
- 默认自治级别与通知方式；
- 需要在界面上确认激活（或调用 `POST /api/trackings/:id/monitors/activate`），激活后才开始后台检查；
- 试取数的来源与日期。

**不要声称“已经在后台监控”**，除非宿主确认激活成功。

## 调整已有监测

- 用户说“把 MON2 频率改成周”“库存阈值改成 15 周”时，先确认影响（预警/失效阈值、动作是否变），再改状态与报告。
- 改阈值、换指标、删监测项属于 C4：必须明确确认，不能顺手改。
- 停用用 `status: retired`，不物理删除；保留历史观察。

## 边界

- 只改 `analysis-state.json` 与目标报告；不动模型文件（建约阶段只读）。
- 不自动交易，不自动改跟踪频率之外的重大判断。
- 不编造来源、日期、观察值；来源必须可点开。
- 高频资讯站（如 `stock.cfi.cn`）只能作为 S3 线索，不能单独作为自动触发依据。
