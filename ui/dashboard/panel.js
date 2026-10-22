/**
 * Fixed dashboard entry point for a tracking run.
 *
 * This module owns navigation, run selection and source links only. It never
 * writes models, submits layouts or injects payload HTML: every data value goes
 * through a component renderer that escapes text.
 */

import { withProject } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { esc } from "../shared/escape.js";
import { registerDashboardComponents } from "./components/index.js";
import { fmtDate, fmtPercent, fmtPrice } from "./format.js";
import {
  renderDashboardSections,
  validateDashboardDto,
} from "./registry.js";

registerDashboardComponents();

const state = {
  trackingId: "",
  runId: "",
  dto: null,
  loading: false,
  error: "",
  lastFocus: null,
  requestToken: 0,
};

function overlay() {
  return document.getElementById("dashboardOverlay");
}

function endpoint(trackingId, runId) {
  const base = runId
    ? `/api/trackings/${encodeURIComponent(trackingId)}/runs/${encodeURIComponent(runId)}/dashboard`
    : `/api/trackings/${encodeURIComponent(trackingId)}/dashboard`;
  return withProject(base);
}

async function fetchDashboard(trackingId, runId) {
  const res = await fetch(endpoint(trackingId, runId), { headers: { Accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `读取 Dashboard 失败（HTTP ${res.status}）`);
  const problem = validateDashboardDto(data);
  if (problem) throw new Error(problem);
  return data;
}

function runLabel(run) {
  return `${fmtDate(run.at, { time: true })} · ${run.status || "未知状态"}${run.hasResult ? "" : " · 无结果"}`;
}

function runSelector(dto) {
  const options = [`<option value="" ${state.runId ? "" : "selected"}>最新结果</option>`];
  for (const run of dto.runs) {
    if (run.isLatest) continue;
    options.push(`<option value="${esc(run.runId)}" ${run.runId === state.runId ? "selected" : ""}>${esc(runLabel(run))}</option>`);
  }
  return `<label class="dash-run-label"><span>运行版本</span><select id="dashRun" aria-label="选择历史跟踪运行">${options.join("")}</select></label>`;
}

function latestVersionInfo(dto) {
  return `schema ${esc(dto.schema.name)}@v${esc(dto.schema.version)} · 项目 ${esc(dto.projectId)} · run ${esc(dto.source.runId || "无")} · 材料 v${esc(dto.source.materialVersion ?? "?")} · ${esc(dto.timezone)}`;
}

function changeSubtext(version) {
  if (version?.changeKind === "unavailable") return "无结果，未产生可比较结论";
  if (version?.changeKind === "failed") return "运行失败，未产生可比较结论";
  if (version?.changeKind === "audit-only") return "仅审计版本，不是业务判断变化";
  return version?.conclusionChanged ? "有实质变化" : "无业务变化";
}

function summaryTiles(dto) {
  const byType = Object.fromEntries(dto.sections.map((section) => [section.type, section.data]));
  const valuation = byType["valuation-summary"];
  const version = byType["version-change"];
  const sensitivity = byType["sensitivity-matrix"];
  const falsification = byType["falsification-panel"];
  const target = valuation?.targetPrice === null || valuation?.targetPrice === undefined
    ? "未知"
    : fmtPrice(valuation.targetPrice, valuation.priceUnit || valuation.valueUnit);
  const upside = valuation?.upsidePercent === null || valuation?.upsidePercent === undefined
    ? "无法计算"
    : fmtPercent(valuation.upsidePercent);
  const change = version?.changeKind === "audit-only"
    ? "仅审计版本"
    : version?.changeKind === "business"
      ? "结论有变化"
      : version?.changeKind === "unavailable"
        ? "无结果"
        : version?.changeKind === "failed"
          ? "运行失败"
          : version?.statusLabel || "未知";
  const sens = sensitivity?.available && sensitivity.baseCase
    ? fmtPrice(sensitivity.baseCase.value, sensitivity.baseCase.unit)
    : "尚无数据";
  const checks = falsification?.counts || {};
  return `<div class="dash-overview" aria-label="四个核心问题的摘要">
    <article class="dash-overview-tile">
      <span>1 · 当前估值结论</span>
      <strong>${esc(target)}</strong>
      <small>上行 ${esc(upside)} · ${esc(valuation?.rating || "评级未声明")}</small>
    </article>
    <article class="dash-overview-tile">
      <span>2 · 相比上一版</span>
      <strong>${esc(change)}</strong>
      <small>${esc(version?.fromVersion || "?")} → ${esc(version?.toVersion || "?")} · ${esc(changeSubtext(version))}</small>
    </article>
    <article class="dash-overview-tile">
      <span>3 · 已有敏感性</span>
      <strong>${esc(sens)}</strong>
      <small>${sensitivity?.available ? `基准情景 · ${esc(sensitivity.valueUnit || "单位未声明")}` : esc(sensitivity?.emptyReason || "尚无敏感性数据")}</small>
    </article>
    <article class="dash-overview-tile">
      <span>4 · 推翻条件</span>
      <strong>${esc(String(checks.triggered ?? 0))} 项已触发</strong>
      <small>${esc(String(checks.warning ?? 0))} 项预警 · ${esc(String(checks.unknown ?? 0))} 项缺数据</small>
    </article>
  </div>`;
}

function shell(dto) {
  const historical = dto.source.runId && !dto.runs.find((run) => run.runId === dto.source.runId)?.isLatest;
  const warnings = dto.warnings.length
    ? `<details class="dash-warnings" ${dto.warnings.length <= 2 ? "open" : ""}>
        <summary>数据状态：${esc(dto.dataState)} · ${dto.warnings.length} 条提示</summary>
        <ul>${dto.warnings.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      </details>`
    : `<div class="dash-state-line"><span class="dash-state ${esc(dto.dataState)}">${esc(dto.dataState)}</span> 数据完整</div>`;
  return `<div class="dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dashTitle" tabindex="-1">
    <header class="dash-head">
      <div class="dash-mark" aria-hidden="true">PE</div>
      <div class="dash-head-main">
        <div class="dash-eyebrow">Investment Dashboard · 固定视图 · 只读</div>
        <h1 id="dashTitle">投研 Dashboard <span class="dash-schema">v1</span></h1>
        <p>${esc(fmtDate(dto.asOf, { time: true }))} · ${esc(dto.timezone)}${historical ? ' · <span class="dash-history">历史 run</span>' : ""}</p>
      </div>
      <div class="dash-tools">
        ${runSelector(dto)}
        <button type="button" class="dash-btn" data-dash-latest ${state.runId ? "" : "disabled"}>最新</button>
        <button type="button" class="dash-btn" data-dash-refresh>刷新</button>
        <button type="button" class="dash-btn" data-dash-close aria-label="关闭 Dashboard">关闭</button>
      </div>
    </header>
    <div class="dash-scroll" id="dashScroll">
      ${warnings}
      ${summaryTiles(dto)}
      ${renderDashboardSections(dto)}
      <footer class="dash-foot">
        <span>${latestVersionInfo(dto)}</span>
        <span>数字保存为 number，格式化只在展示层 · 不调用 LLM · 不写模型 · 不执行审批</span>
      </footer>
    </div>
  </div>`;
}

function loadingShell() {
  return `<div class="dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dashTitle" tabindex="-1">
    <header class="dash-head">
      <div class="dash-mark" aria-hidden="true">PE</div>
      <div class="dash-head-main">
        <div class="dash-eyebrow">Investment Dashboard · 固定视图</div>
        <h1 id="dashTitle">投研 Dashboard</h1>
        <p>正在读取该次运行的可追溯数据…</p>
      </div>
      <div class="dash-tools"><button type="button" class="dash-btn" data-dash-close>关闭</button></div>
    </header>
    <div class="dash-scroll"><div class="dash-loading" role="status" aria-live="polite"><span class="prev-spinner" aria-hidden="true"></span>构建 Dashboard…</div></div>
  </div>`;
}

function errorShell(message) {
  return `<div class="dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dashTitle" tabindex="-1">
    <header class="dash-head">
      <div class="dash-mark" aria-hidden="true">PE</div>
      <div class="dash-head-main">
        <div class="dash-eyebrow">Investment Dashboard · 固定视图</div>
        <h1 id="dashTitle">Dashboard 无法构建</h1>
        <p>没有 fallback 到任意 HTML。</p>
      </div>
      <div class="dash-tools"><button type="button" class="dash-btn" data-dash-close>关闭</button></div>
    </header>
    <div class="dash-scroll"><div class="dash-page-error" role="alert">
      <strong>读取失败</strong><p>${esc(message)}</p>
      <button type="button" class="dash-btn" data-dash-refresh>重试</button>
    </div></div>
  </div>`;
}

function paint(html) {
  const el = overlay();
  if (!el) return;
  el.innerHTML = html;
  el.hidden = false;
  document.body.classList.add("dash-body-lock");
  const dialog = el.querySelector(".dash-dialog");
  if (dialog) dialog.focus({ preventScroll: true });
}

async function load({ runId = state.runId } = {}) {
  const token = ++state.requestToken;
  state.runId = runId || "";
  state.loading = true;
  paint(loadingShell());
  try {
    const dto = await fetchDashboard(state.trackingId, state.runId);
    if (token !== state.requestToken) return;
    state.dto = dto;
    state.error = "";
    paint(shell(dto));
  } catch (error) {
    if (token !== state.requestToken) return;
    state.error = error.message || String(error);
    paint(errorShell(state.error));
  } finally {
    state.loading = false;
  }
}

export function openDashboard(trackingId, runId = "") {
  if (!trackingId) return;
  const el = overlay();
  if (!el) return;
  state.trackingId = trackingId;
  state.runId = runId || "";
  state.dto = null;
  state.error = "";
  state.lastFocus = document.activeElement;
  el.hidden = false;
  void load({ runId: state.runId });
}

export function closeDashboard() {
  const el = overlay();
  if (!el || el.hidden) return;
  state.requestToken += 1;
  el.hidden = true;
  el.innerHTML = "";
  state.trackingId = "";
  state.runId = "";
  state.dto = null;
  document.body.classList.remove("dash-body-lock");
  const focus = state.lastFocus;
  state.lastFocus = null;
  if (focus && typeof focus.focus === "function") focus.focus();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("已复制");
  } catch {
    toast("复制失败");
  }
}

function openSource(button) {
  const materialId = button.getAttribute("data-dash-material");
  if (!materialId) return false;
  const version = Number(button.getAttribute("data-dash-version")) || undefined;
  const locator = button.getAttribute("data-dash-locator") || null;
  if (typeof window.openFile !== "function") {
    toast("文件预览没有就绪");
    return false;
  }
  closeDashboard();
  window.openFile(materialId, version, locator || undefined);
  return true;
}

function wire() {
  const el = overlay();
  if (!el || el.dataset.wired === "1") return;
  el.dataset.wired = "1";
  el.addEventListener("click", (event) => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.closest("[data-dash-close]")) { closeDashboard(); return; }
    if (target.closest("[data-dash-refresh]")) { void load({ runId: state.runId }); return; }
    if (target.closest("[data-dash-latest]")) { state.runId = ""; void load({ runId: "" }); return; }
    const copy = target.closest("[data-dash-copy]");
    if (copy) { void copyText(copy.getAttribute("data-dash-copy") || ""); return; }
    const source = target.closest("[data-dash-material]");
    if (source) { event.preventDefault(); openSource(source); return; }
    const more = target.closest("[data-dash-more]");
    if (more) {
      const box = document.getElementById("dashChecksRest");
      if (box) {
        box.hidden = !box.hidden;
        more.setAttribute("aria-expanded", String(!box.hidden));
        more.textContent = box.hidden ? `展开其余检查` : "收起检查";
      }
    }
  });
  el.addEventListener("change", (event) => {
    if (event.target.id !== "dashRun") return;
    state.runId = event.target.value || "";
    void load({ runId: state.runId });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el || el.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closeDashboard();
  }, true);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeDashboard(); return; }
    if (event.key !== "Tab") return;
    const dialog = el.querySelector(".dash-dialog");
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], select, input, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

wire();

// Expose the narrow surface used by the classic tracking script.
window.TrackingDashboard = Object.freeze({ open: openDashboard, close: closeDashboard });
