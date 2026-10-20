# 跟踪运行契约

宿主把本次运行的信息写进 prompt；你的输出分两部分：**文件写回**和**结果 JSON**。两者必须一致。

## 宿主传入

| 字段 | 含义 |
|---|---|
| `tracking_id` | 跟踪 ID，写入 `tracking.last_run_id` 的逻辑关联 |
| `run_id` | 本次运行 ID |
| `targetPath` | 唯一允许原位更新的报告路径 |
| `baseVersion` | 更新前的文件版本 |
| `resultRelPath` | 结果 JSON 路径：`.tracking/<tracking_id>/<run_id>.json` |
| `baseVersion` 对应备份 | 宿主已备份，不要另建备份文件 |

## 结果 JSON

```json
{
  "status": "updated | no_change | needs_review",
  "conclusion": "一句话：目标价/判断有没有变",
  "summary": "2–4 句：为什么变或为什么没变",
  "confidence": "高 | 中 | 低",
  "deltas": [
    { "label": "目标价（base）", "from": "92 元", "to": "88 元", "note": "-4.3%", "tone": "down" }
  ],
  "theses": [
    {
      "id": "T1",
      "statement": "AI 服务器需求推动 DRAM 周期上行",
      "status": "active | weakened | invalidated | confirmed | retired",
      "change": "维持 | 降级 | 失效 | 升级",
      "note": "依据：F1 未触发，合约价 9 月环比 +4%"
    }
  ],
  "invalidations": [
    {
      "id": "F2",
      "thesis_id": "T1",
      "condition": "渠道库存 > 12 周",
      "observed": "12.6 周",
      "triggered": true,
      "action": "下调 A1，重算 S1/V1"
    }
  ],
  "monitorChecks": [
    {
      "id": "MON1",
      "falsifier_id": "F1",
      "observed": "+4% QoQ",
      "status": "armed | warning | triggered | unknown",
      "note": "来源与口径"
    }
  ],
  "reasons": [
    {
      "tag": "新实际 | 结构变化 | 估值对照 | 无变化",
      "title": "一句话依据",
      "detail": "如何影响预测/估值/判断",
      "source": "来源 · YYYY-MM-DD",
      "impact": "影响了哪个 T/A/S/V"
    }
  ],
  "judgment": {
    "title": "判断变化",
    "text": "哪条观点状态变了、哪些失效条件被触发或解除"
  },
  "sources": [{ "label": "TrendForce 合约价", "date": "2026-10-15" }],
  "notUsed": ["尚未披露的 2026Q3 毛利率"],
  "writeback": {
    "stats": "2 处假设 · 1 处观点 · 1 处结论",
    "note": "写回位置与未验证项",
    "changes": [
      { "where": "第 6 节 F2", "from": "9.2 周", "to": "12.6 周", "note": "触发" }
    ]
  }
}
```

## 字段规则

- `status`：有实质修改用 `updated`；只追加跟踪记录用 `no_change`；需要用户决策（如重大改判、缺关键数据）用 `needs_review`。
- `theses`：**必须**覆盖所有 `active / weakened / invalidated` 观点，即使没有变化。ID 与状态文件一致。
- `invalidations`：本期核对过的关键失效条件；`triggered: true` 排前面。没有触发的也要列出观察值，便于界面展示。
- `monitorChecks`：监测模式必需，覆盖本次每个 MON；`status` 是 armed / warning / triggered / unknown。
- `deltas`：只放关键数字（目标价、EPS、毛利率、估值倍数），2–5 条。
- `reasons`：3–5 条，每条能指到 ID 和来源；不要写“市场变化”这类空话。重算了敏感性时，在 `impact` 里写清 `S` ID 及结果变化（如“S1 从 92→88 元”）。
- 不要编造来源、日期或数字；无法验证的写进 `notUsed` 或 `writeback.note`。

## 与状态文件的对应

| 结果字段 | 状态字段 |
|---|---|
| `theses[].status` | `theses[].status` |
| `theses[].note` | `theses[].status_note`（可选） |
| `invalidations[].observed` | `falsifiers[].last_observed` |
| `invalidations[].triggered` | `falsifiers[].status`（`triggered` / `armed`） |
| `sources` | `sources` / `evidence` |
| `writeback.changes` | `changes[]` |

运行结束后，宿主会把结果展示在跟踪页：观点状态、触发的失效条件、关键数字和依据。**结果里没有的，界面就看不到**。

## 最小示例

没有实质变化：

```json
{
  "status": "no_change",
  "conclusion": "目标价维持 92 元，观点状态不变",
  "summary": "本期只更新了月度合约价，F1/F2 均未触发；未到财报期，盈利假设不变。",
  "confidence": "中",
  "deltas": [{ "label": "目标价（base）", "from": "92 元", "to": "92 元", "note": "0%", "tone": "flat" }],
  "theses": [
    { "id": "T1", "statement": "AI 服务器需求推动 DRAM 周期上行", "status": "active", "change": "维持", "note": "合约价环比 +4%" },
    { "id": "T2", "statement": "国产替代带来份额提升", "status": "active", "change": "维持", "note": "未到披露期" }
  ],
  "invalidations": [
    { "id": "F1", "thesis_id": "T1", "condition": "合约价连续两季环比 ≤ -5%", "observed": "+4% MoM", "triggered": false, "action": "—" }
  ],
  "reasons": [],
  "sources": [{ "label": "TrendForce 合约价", "date": "2026-10-15" }],
  "notUsed": ["2026Q3 财报（未披露）"],
  "writeback": { "stats": "0 处实质修改", "note": "仅追加跟踪记录", "changes": [] }
}
```
