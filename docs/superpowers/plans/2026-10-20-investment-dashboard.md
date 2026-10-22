# 固定式投研 Dashboard — 实施计划

- [x] 从 P1 分支创建独立 worktree `codex/investment-dashboard`
- [x] 定义 `pe.investment-dashboard@v1` TypeBox Schema 与固定区块目录
- [x] 实现只读 DashboardService（run result / 状态快照 / 版本历史 / monitors）
- [x] 接入两个 GET API，返回前做 Schema 校验
- [x] 实现浏览器组件目录与四个固定组件（validate/render/empty/error）
- [x] tracking 详情页增加 Dashboard 入口、run 选择、来源跳转、复制、键盘/响应式
- [x] 扩展 `openFile` 支持 `Sheet!A1` 定位；修复 P1 遗留的预览全局依赖
- [x] Node Schema/API/组件测试
- [x] Playwright 1440/1024/390、历史 run、来源、20+ checks、XSS、空状态
- [x] 视觉截图
- [x] 运行 P1 回归
- [x] 独立只读审查（OCR delegation + 独立上下文）与修复复验（APPROVE）
- [x] 最终报告
