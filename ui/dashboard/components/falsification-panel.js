import { esc } from "../../shared/escape.js";
import { fmtDate, sourceRefsHTML } from "../format.js";

const THESIS_STATUS = { active: "成立中", weakened: "减弱", invalidated: "已失效", confirmed: "已确认", retired: "已归档" };
const STATUS_ORDER = ["triggered", "warning", "unknown", "armed", "retired"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default {
  type: "falsification-panel",
  version: 1,
  validate(data) {
    if (!isObject(data)) return "推翻条件区块不是对象";
    if (!Array.isArray(data.theses) || !Array.isArray(data.checks) || !Array.isArray(data.sourceRefs)) return "缺少 theses/checks/sourceRefs";
    if (!isObject(data.counts)) return "缺少 counts";
    for (const key of ["triggered", "warning", "unknown", "armed", "retired"]) {
      if (!Number.isInteger(data.counts[key]) || data.counts[key] < 0) return `counts.${key} 必须是非负整数`;
    }
    for (const check of data.checks) {
      if (!isObject(check)) return "check 不是对象";
      if (!STATUS_ORDER.includes(check.status)) return `check ${check.id || "?"} 的 status 非法`;
      if (typeof check.statusLabel !== "string" || typeof check.statusMeaning !== "string") return "check 缺少非颜色状态说明";
      if (!Array.isArray(check.sourceRefs)) return "check 缺少 sourceRefs";
    }
    return "";
  },
  empty(data) {
    return !data.checks.length;
  },
  emptyHTML() {
    return `<section class="dash-card dash-falsification is-empty" data-section="falsification-panel" aria-labelledby="dashFalsTitle">
      <div class="dash-eyebrow">04 · 推翻条件</div>
      <h2 id="dashFalsTitle">尚未配置失效条件或监测项</h2>
      <p>没有检查项时不推断“安全”，也不自动生成监测规则。</p>
    </section>`;
  },
  render(data) {
    const visible = data.checks.slice(0, 6);
    const rest = data.checks.slice(6);
    const thesisMap = new Map(data.theses.map((thesis) => [thesis.id, thesis]));
    return `<section class="dash-card dash-falsification" data-section="falsification-panel" aria-labelledby="dashFalsTitle">
      <div class="dash-card-head">
        <div>
          <div class="dash-eyebrow">04 · 推翻条件</div>
          <h2 id="dashFalsTitle">哪些条件正在接近推翻投资逻辑</h2>
          <p class="dash-sub">已触发优先 · 缺数据不按正常状态显示 · 每项可追溯到观点与来源</p>
        </div>
        <div class="dash-counts" aria-label="监测状态统计">
          <span class="dash-count is-triggered">${esc(String(data.counts.triggered))}<small>已触发</small></span>
          <span class="dash-count is-warning">${esc(String(data.counts.warning))}<small>预警</small></span>
          <span class="dash-count is-unknown">${esc(String(data.counts.unknown))}<small>缺数据</small></span>
          <span class="dash-count is-armed">${esc(String(data.counts.armed))}<small>监控中</small></span>
          ${data.counts.retired ? `<span class="dash-count is-retired">${esc(String(data.counts.retired))}<small>已归档</small></span>` : ""}
        </div>
      </div>
      ${data.unknowns.length ? `<div class="dash-note is-warn"><b>需要人工注意</b><ul>${data.unknowns.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
      <div class="dash-block">
        <h3>观点 <span class="dash-label-inline">${data.theses.length} 条</span></h3>
        ${data.theses.length ? `<div class="dash-theses">${data.theses.map((thesis) => `<div class="dash-thesis" data-thesis="${esc(thesis.id)}">
          <span class="dash-mono">${esc(thesis.id)}</span>
          <span class="dash-thesis-text">${esc(thesis.statement || "未填写观点")}</span>
          <span class="dash-thesis-status is-${esc(thesis.status)}">${esc(THESIS_STATUS[thesis.status] || thesis.status)}</span>
        </div>`).join("")}</div>` : `<p class="dash-muted">状态文件没有声明观点。</p>`}
      </div>
      <div class="dash-block">
        <h3>检查项 <span class="dash-label-inline">${data.checks.length} 项，已按状态排序</span></h3>
        <div class="dash-checks">${visible.map((check) => checkHTML(check, thesisMap)).join("")}</div>
        ${rest.length ? `<div class="dash-checks" id="dashChecksRest" hidden>${rest.map((check) => checkHTML(check, thesisMap)).join("")}</div>
          <button type="button" class="dash-more" data-dash-more="checks" aria-expanded="false" aria-controls="dashChecksRest">展开其余 ${rest.length} 项检查</button>` : ""}
      </div>
      <div class="dash-sources"><span class="dash-label">整体追溯</span>${sourceRefsHTML(data.sourceRefs)}</div>
    </section>`;
  },
};

function checkHTML(check) {
  return `<article class="dash-check is-${esc(check.status)}" data-status="${esc(check.status)}" aria-label="${esc(`${check.id} ${check.statusLabel}`)}">
    <div class="dash-check-head">
      <span class="dash-status ${esc(check.status)}">${esc(check.statusLabel)}</span>
      <span class="dash-mono">${esc(check.id)}</span>
      <span class="dash-check-link">${check.linkStatus === "linked" ? `→ ${esc(check.thesisId)} / ${esc(check.falsifierId)}` : "未绑定观点或失效条件"}</span>
      <span class="dash-check-meaning">${esc(check.statusMeaning)}</span>
    </div>
    <div class="dash-check-body">
      <strong>${esc(check.metric || "未说明指标")}</strong>
      <span class="dash-check-rule">${esc([check.operator, check.threshold].filter(Boolean).join(" ") || "阈值未声明")}</span>
      <span class="dash-check-observed">观察值：${check.observed ? esc(check.observed) : '<span class="dash-unknown">未知</span>'}</span>
      ${check.warning ? `<span class="dash-check-warning">预警：${esc(check.warning)}</span>` : ""}
    </div>
    <div class="dash-check-foot">
      <span>上次检查：${esc(fmtDate(check.lastCheckedAt, { time: true }))}</span>
      <span>下次检查：${esc(fmtDate(check.nextCheckAt, { time: true }))}</span>
      <span>动作：${esc(check.action || "未声明")}</span>
    </div>
    ${check.sourceRefs.length ? `<div class="dash-check-sources">${sourceRefsHTML(check.sourceRefs, { limit: 4 })}</div>` : ""}
  </article>`;
}
