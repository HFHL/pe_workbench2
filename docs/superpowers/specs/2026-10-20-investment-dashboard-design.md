# 固定式投研 Dashboard — 设计

## 目标

在 P1 的 `pe.tracking-result` 与 renderer registry 之上，提供一个固定、只读、
可审计的投研 Dashboard，直接回答估值结论、版本变化、已有敏感性、接近推翻的
条件。模型不参与页面组装。

## 关键决策

1. **固定四区块**：`valuation-summary`、`version-change`、`sensitivity-matrix`、
   `falsification-panel`，每项 v1。Schema 用 discriminated union；未知 type/version
   直接拒绝。
2. **服务端投影**：`DashboardService.build` 只读 tracking run result、对应
   analysis-state 版本快照、material history、monitor ledger；输出前 TypeBox 校验。
3. **历史隔离**：状态快照按 `run_id` / `created_at <= run.ended_at` 解析；历史 run
   不使用当前文件、当前监测台账或最新 run 值。
4. **组件目录在浏览器**：注册表要求 validate/render/empty；未知组件显示错误占位；
   渲染只用转义文本，不注入 payload HTML。
5. **来源可追溯**：每个数字/状态都有带 material/version/locator 的 sourceRef；
   断链显示状态，不隐藏。
6. **数字与单位**：number + 显式 currency/unit；未知为 null，`upside` 只在同币种、
   同每股单位且现价非 0 时计算。

## 风险与缓解

- 历史状态未版本化 → 显示断链，不回退当前值。
- 监测台账是当前值 → 历史 run 只使用快照与本轮 monitorChecks。
- 自由文本中可能含 HTML → 全部 `esc`；URL 白名单；不生成事件属性。
- 长列表阻塞 → 折叠/分页/横向滚动；20+ checks 实测。

## 验收映射

见 `docs/investment-dashboard.md` 测试章节。
