/**
 * 「盯」panel: status strip, finding cards and a small chat with the watcher.
 *
 * The panel is read-only by design. Every finding carries a source link (web
 * or local material); questions are queued on the server so the view can stay
 * optimistic-free: user messages and answers arrive through SSE.
 */

import { $, $$, esc, icon } from "../shared/dom.js";
import { state } from "../state/store.js";
import { api } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";
import { mdToHtml } from "../chat/renderer.js";

const ui = {
  loaded: false,
  loading: false,
  error: "",
  watch: null,
  messages: [],
  checks: [],
  detection: null,
  typing: false,
  settings: false,
  submitting: false,
  markingRead: false,
  wired: false,
  initPromise: null,
  scrollBottom: true,
  scrollTarget: null,
  logs: { open: false, loading: false, error: "", logs: [] },
};

const SEVERITY_LABEL = { critical: "重大", warning: "关注", info: "提示" };
const CONFIDENCE_LABEL = { high: "高", medium: "中", low: "低" };

function watchRoot() {
  return $("#watchView");
}

function threadEl() {
  return $("#watchThread");
}

function timeLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return hm;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

function relativeLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const diff = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function nextLabel(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return timeLabel(date.toISOString());
}

function companyShort(watch = ui.watch) {
  const company = String(watch?.brief?.target?.company || "").trim();
  return company.split(/[（(]/)[0].trim() || "盯盘";
}

function fmtValue(value, unit = "") {
  if (value == null || value === "") return "—";
  const shortUnit = String(unit || "").split(/[（(]/)[0].trim();
  return `${value} ${shortUnit}`.trim();
}

function materialByPath(relPath) {
  return (state.files || []).find((file) => file.relPath === relPath)
    || (state.files || []).find((file) => file.path === relPath)
    || null;
}

function openMaterial(relPath) {
  const file = materialByPath(relPath);
  if (!file) {
    toast(`没有找到文件：${relPath}`);
    return;
  }
  closeDrawerIfNarrow();
  runtime.openFile?.(file.id);
}

function closeDrawerIfNarrow() {
  if (window.matchMedia("(max-width:760px)").matches) {
    runtime.closeDrawers?.();
  }
}

/* ---------- data ---------- */

export async function loadWatch() {
  if (ui.loading) return ui.initPromise;
  ui.loading = true;
  ui.error = "";
  renderPanel();
  const run = (async () => {
    try {
      const data = await api("/api/watch");
      applyOverview(data);
      ui.loaded = true;
    } catch (error) {
      ui.error = error.message || "加载盯盘失败";
    } finally {
      ui.loading = false;
      renderPanel();
    }
  })();
  ui.initPromise = run;
  return run;
}

function applyOverview(data) {
  if (!data) return;
  ui.watch = data.watch || null;
  ui.messages = Array.isArray(data.messages) ? data.messages : [];
  ui.checks = Array.isArray(data.checks) ? data.checks : [];
  ui.detection = data.detection || null;
  ui.scrollBottom = true;
}

/* ---------- panel chrome ---------- */

export function renderPanel() {
  const root = watchRoot();
  if (!root) return;
  const active = state.panelTab === "watch";
  const filesView = $("#filesView");
  if (filesView) filesView.hidden = active;
  root.hidden = !active;
  if (!active) return;

  $("#panelTitle").textContent = "盯";
  const findings = Number(ui.watch?.counts?.findings || 0);
  $("#fileCount").textContent = findings > 0 ? String(findings) : "";
  const newTrack = $("#newTrackBtn");
  if (newTrack) newTrack.hidden = true;

  renderStatus();
  renderThread();
  syncComposer();
}

function renderStatus() {
  const host = $("#watchStatus");
  if (!host) return;
  if (!ui.watch) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const watch = ui.watch;
  const last = watch.lastCheck;
  const base = watch.brief?.valuation?.base;
  let dot = "ok";
  let main = "一切安好";
  if (!watch.enabled) {
    dot = "";
    main = "已暂停";
  } else if (watch.status === "checking") {
    dot = "busy";
    main = "正在检查…";
  } else if (last?.status === "failed") {
    dot = "bad";
    main = "上次检查失败";
  } else if (Number(watch.counts?.unread) > 0) {
    dot = "warn";
    main = `${watch.counts.unread} 条发现待看`;
  } else if (!last) {
    dot = "";
    main = "等待第一次检查";
  } else if (last.status === "finding" || (last.result?.material === true)) {
    dot = "warn";
    main = "上次检查有发现";
  }

  const meta = [];
  if (last?.startedAt) meta.push(`<span>最近检查 ${timeLabel(last.startedAt)}</span>`);
  else if (watch.lastScanAt) meta.push(`<span>最近扫描 ${timeLabel(watch.lastScanAt)}</span>`);
  if (base) meta.push(`<span>基准 ${fmtValue(base.value, base.unit)}</span>`);
  if (watch.enabled && watch.nextScanAt) meta.push(`<span>下次 ${nextLabel(watch.nextScanAt)}</span>`);
  if (!watch.enabled) meta.push(`<span>重新开启后会补一次检查</span>`);
  const failureTitle = last?.status === "failed" && last.error ? ` title="${esc(last.error)}"` : "";
  host.innerHTML = `
    <div class="watch-status-main"${failureTitle}>
      <span class="watch-dot ${dot}"></span>
      <strong>${esc(companyShort())}</strong>
      <span class="sep">·</span>
      <strong>${esc(main)}</strong>
      <span class="watch-status-actions">
        <button class="watch-icon-btn" data-watch-logs aria-label="检查日志" title="检查日志">${icon("history", 14)}</button>
        <button class="watch-icon-btn" data-watch-check aria-label="立即检查" title="立即检查" ${watch.status === "checking" ? "disabled" : ""}>${icon("refresh", 14)}</button>
        <button class="watch-icon-btn" data-watch-settings aria-label="盯盘设置" title="盯盘设置">${icon("more", 14)}</button>
      </span>
    </div>
    ${meta.length ? `<div class="watch-status-meta">${meta.join('<span class="sep">·</span>')}</div>` : ""}
  `;
}

function renderThread() {
  const host = threadEl();
  if (!host) return;
  if (!ui.watch) {
    host.innerHTML = renderSetup();
    return;
  }
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40 || ui.scrollBottom;
  const parts = [];
  if (ui.settings) parts.push(renderSettings());
  if (!ui.messages.length) {
    parts.push(`<div class="watch-empty">
      <span class="watch-empty-icon">${icon("search", 17)}</span>
      <h3>已开始盯住</h3>
      <p>我会在后台定期扫一遍公告、财报和新闻，只有重大发现才会出现在这里。</p>
      <button class="btn small" data-watch-check>现在检查一次</button>
    </div>`);
  }
  for (const message of ui.messages) {
    parts.push(renderMessage(message));
  }
  if (ui.typing) {
    parts.push(`<div class="watch-typing"><i></i><i></i><i></i><span>盯盘助手正在想…</span></div>`);
  }
  if (ui.messages.length <= 2 && !ui.typing) {
    parts.push(`<div class="watch-chips" style="margin-top:2px">
      <button class="watch-chip" data-watch-ask="现在怎么样？">现在怎么样？</button>
      <button class="watch-chip" data-watch-ask="为什么说一切安好？">为什么说一切安好？</button>
      <button class="watch-chip" data-watch-ask="最近最该盯的是哪个变量？">最该盯哪个变量？</button>
    </div>`);
  }
  host.innerHTML = parts.join("");
  if (state.panelTab === "watch") void markRead();
  if (ui.scrollTarget) {
    const target = host.querySelector(`[data-message="${CSS.escape(ui.scrollTarget)}"]`);
    if (target) {
      host.scrollTop = Math.max(0, target.offsetTop - 8);
      ui.scrollTarget = null;
      ui.scrollBottom = false;
      return;
    }
  }
  if (atBottom) host.scrollTop = host.scrollHeight;
  ui.scrollBottom = false;
}

const FALSIFIER_STATUS_LABEL = {
  armed: "监控中",
  warning: "接近阈值",
  triggered: "已触发",
  unknown: "缺数据",
  retired: "已归档",
};

function focusHTML(focus, { id = "watchFocus", open = false } = {}) {
  if (!focus) return "";
  const sensitivities = Array.isArray(focus.sensitivities) ? focus.sensitivities : [];
  const falsifiers = Array.isArray(focus.falsifiers) ? focus.falsifiers : [];
  if (!sensitivities.length && !falsifiers.length) return "";
  const count = `${sensitivities.length} 敏感 · ${falsifiers.length} 失效`;
  const base = focus.base;
  return `
    <button type="button" class="watch-focus-toggle" data-watch-focus="${esc(id)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${esc(id)}">
      <span class="wf-toggle-label">关注点<b>${count}</b></span>
      ${icon("chevron-down", 12)}
    </button>
    <div class="watch-focus" id="${esc(id)}"${open ? "" : " hidden"}>
      ${base ? `<div class="watch-focus-base">基准 ${esc(base.id || "V1")} ${esc(base.scenario || "base")} <b>${esc(fmtValue(base.value, base.unit))}</b></div>` : ""}
      ${sensitivities.length ? `<div class="watch-focus-sec">
        <div class="watch-focus-head"><span>敏感性</span><span>按影响排序</span></div>
        ${sensitivities.map((item) => `
          <div class="watch-focus-item">
            <span class="wf-id is-s">${esc(item.id)}</span>
            <span class="wf-main">
              <span class="wf-title">${esc(item.driver || "")}${item.impactPercent ? ` <em>±${esc(String(item.impactPercent))}%</em>` : ""}</span>
              <span class="wf-sub" title="${esc(item.result || item.perturbation || "")}">${esc(item.result || item.perturbation || "")}</span>
            </span>
          </div>`).join("")}
      </div>` : ""}
      ${falsifiers.length ? `<div class="watch-focus-sec">
        <div class="watch-focus-head"><span>失效条件</span><span>触发即需复核</span></div>
        ${falsifiers.map((item) => `
          <div class="watch-focus-item">
            <span class="wf-id is-f">${esc(item.id)}</span>
            <span class="wf-main">
              <span class="wf-title">${esc(item.metric || "")}<span class="wf-state ${esc(item.status || "armed")}">${esc(FALSIFIER_STATUS_LABEL[item.status] || item.status || "监控中")}</span></span>
              <span class="wf-sub" title="${esc(item.threshold || "")}">${esc(item.threshold || "")}</span>
            </span>
          </div>`).join("")}
      </div>` : ""}
    </div>`;
}

function renderSetup() {
  const detection = ui.detection;
  if (ui.loading) {
    return `<div class="watch-empty"><span class="watch-empty-icon">${icon("refresh", 17)}</span><h3>正在识别最新估值…</h3><p>找同目录的 analysis-state.json、报告和模型。</p></div>`;
  }
  if (ui.error) {
    return `<div class="watch-empty">
      <span class="watch-empty-icon">${icon("info", 17)}</span>
      <h3>没有连上盯盘</h3>
      <p>${esc(ui.error)}</p>
      <button class="btn small" data-watch-retry>重试</button>
    </div>`;
  }
  if (!detection?.found) {
    return `<div class="watch-empty">
      <span class="watch-empty-icon">${icon("search", 17)}</span>
      <h3>还没有可盯的估值</h3>
      <p>${esc(detection?.error || "先在对话里完成一次投资框架分析，产出 analysis-state.json 和报告。")}</p>
      <button class="btn small" data-watch-retry>重新识别</button>
    </div>`;
  }
  const warnings = Array.isArray(detection.warnings) ? detection.warnings : [];
  const canStart = detection.baseValue != null;
  const companyName = String(detection.company || "最新估值").split(/[（(]/)[0].trim();
  return `<div class="watch-setup">
    <div class="watch-setup-card">
      <h4 title="${esc(detection.company || "")}">${esc(companyName)}</h4>
      ${detection.security ? `<div class="watch-setup-row"><b>证券</b><span>${esc(detection.security)}</span></div>` : ""}
      <div class="watch-setup-row"><b>报告</b><span title="${esc(detection.reportPath || "")}">${esc(detection.reportName || detection.reportPath || "—")}</span></div>
      <div class="watch-setup-row"><b>模型</b><span title="${esc(detection.modelPath || "")}">${esc(detection.modelName || detection.modelPath || "—")}</span></div>
      ${detection.focus
        ? focusHTML(detection.focus, { id: "watchFocusSetup" })
        : `<div class="watch-setup-row"><b>关注点</b><span>${Number(detection.sensitivities) || 0} 条敏感性 · ${Number(detection.falsifiers) || 0} 条失效条件</span></div>`}
      ${warnings.length ? `<p class="watch-setup-warn">${esc(warnings.join("；"))}</p>` : ""}
    </div>
    <p class="watch-setup-hint">只读：不会改报告、analysis-state.json 或模型。没有重大发现就不打扰你。</p>
    <div class="watch-setup-actions">
      <button class="btn primary small" data-watch-start ${ui.submitting || !canStart ? "disabled" : ""}>${ui.submitting ? "正在开始…" : canStart ? "开始盯住" : "缺少基准估值"}</button>
    </div>
  </div>`;
}

function renderSettings() {
  const watch = ui.watch;
  return `<div class="watch-setup-card watch-settings">
    <h4 style="margin-bottom:2px">盯盘设置</h4>
    <label class="watch-toggle">
      <span>启用盯盘</span>
      <input type="checkbox" id="watchEnabledEdit" ${watch.enabled ? "checked" : ""}>
    </label>
    <button type="button" class="watch-log-link" data-watch-logs>${icon("history", 12)} 查看检查日志</button>
    ${focusHTML({
      base: watch.brief?.valuation?.base,
      sensitivities: watch.brief?.sensitivities || watch.brief?.topSensitivities,
      falsifiers: watch.brief?.falsifiers,
    }, { id: "watchFocusSettings" })}
    <div class="watch-setup-actions">
      <button class="btn small" data-watch-save>保存</button>
      <button class="btn small" data-watch-refresh>重建关注点</button>
    </div>
    <div class="watch-setup-actions">
      <button class="btn small" data-watch-close-settings>收起</button>
      <button class="btn small danger" data-watch-delete>删除盯盘</button>
    </div>
  </div>`;
}

function citationHTML(citation, index) {
  const title = citation.title || citation.url || citation.path || `来源 ${index + 1}`;
  if (citation.url) {
    return `<a class="watch-link" href="${esc(citation.url)}" target="_blank" rel="noreferrer" title="${esc(citation.url)}">
      ${icon("external", 12)}<span>${esc(title)}</span>
      ${citation.source ? `<span class="watch-link-src">${esc(citation.source)}</span>` : ""}
    </a>`;
  }
  if (citation.path) {
    return `<button type="button" class="watch-link" data-watch-file="${esc(citation.path)}" title="${esc(citation.path)}">
      ${icon("file-text", 12)}<span>${esc(title)}</span>
      <span class="watch-link-src">本地</span>
    </button>`;
  }
  return "";
}

function affectedChips(affected) {
  const labels = { sensitivity: "敏感性", falsifier: "失效", valuation: "估值", thesis: "观点", data: "数据" };
  const classes = { sensitivity: "is-s", falsifier: "is-f", valuation: "is-v", thesis: "is-t", data: "" };
  return (affected || []).map((item) => {
    const label = labels[item.kind] || "";
    return `<span class="watch-chip ${classes[item.kind] || ""}" title="${esc(item.note || "")}"><b>${esc(item.id)}</b>${label ? ` ${label}` : ""}</span>`;
  }).join("");
}

function impactHTML(impact) {
  if (!impact) return "";
  const direction = impact.direction === "down" ? "down" : impact.direction === "up" ? "up" : "";
  return `<div class="watch-impact">
    <b>${esc(impact.label || "目标价")}</b>
    ${impact.from ? `<span class="from">${esc(impact.from)}</span><span>→</span>` : ""}
    <span class="to">${esc(impact.to || "—")}</span>
    ${impact.delta ? `<span class="delta ${direction}">${esc(impact.delta)}</span>` : ""}
  </div>`;
}

function renderFinding(message) {
  const related = message.related || {};
  const citations = (message.citations || []).slice(0, 4).map(citationHTML).filter(Boolean);
  const chips = affectedChips(related.affected);
  const severity = message.severity || "warning";
  return `<article class="watch-msg is-finding" data-message="${esc(message.id)}">
    <div class="watch-finding sev-${esc(severity)}">
      <div class="watch-finding-head">
        <span class="watch-sev ${esc(severity)}">${esc(SEVERITY_LABEL[severity] || "发现")}</span>
        <span class="watch-finding-time">${esc(timeLabel(message.createdAt))}</span>
      </div>
      <div class="watch-finding-title">${esc(message.title || "发现")}</div>
      <div class="watch-finding-body">${mdToHtml(message.body || "")}</div>
      ${chips ? `<div class="watch-chips">${chips}</div>` : ""}
      ${impactHTML(related.impact)}
      ${citations.length ? `<div class="watch-links">${citations.join("")}</div>` : ""}
      <div class="watch-finding-foot">
        <button class="watch-action primary" data-watch-ask="用一句话解释这条为什么算重大">让盯解释</button>
        <button class="watch-action" data-watch-report>看报告</button>
        ${related.confidence ? `<span class="watch-finding-note" style="margin:0 0 0 auto">置信度 ${esc(CONFIDENCE_LABEL[related.confidence] || related.confidence)}</span>` : ""}
      </div>
      ${related.suggestedAction ? `<div class="watch-finding-note">建议：${esc(related.suggestedAction)}</div>` : ""}
    </div>
    <div class="watch-msg-time">${esc(relativeLabel(message.createdAt))}</div>
  </article>`;
}

function renderMessage(message) {
  if (message.kind === "finding") return renderFinding(message);
  if (message.role === "user") {
    return `<div class="watch-msg is-user" data-message="${esc(message.id)}">
      <div class="watch-bubble">${esc(message.body || "")}</div>
      <div class="watch-msg-time">${esc(timeLabel(message.createdAt))}</div>
    </div>`;
  }
  if (message.kind === "error") {
    return `<div class="watch-msg is-assistant" data-message="${esc(message.id)}">
      <div class="watch-bubble" style="color:var(--red-fg)">${esc(message.title || "回答失败")}：${esc(message.body || "")}</div>
    </div>`;
  }
  if (message.kind === "system") {
    return `<div class="watch-msg is-system" data-message="${esc(message.id)}">
      <div class="watch-bubble"><strong>${esc(message.title || "")}</strong>${message.body ? `<br>${esc(message.body)}` : ""}</div>
      <div class="watch-msg-time">${esc(timeLabel(message.createdAt))}</div>
    </div>`;
  }
  return `<div class="watch-msg is-assistant" data-message="${esc(message.id)}">
    <div class="watch-bubble">${mdToHtml(message.body || "")}</div>
    <div class="watch-msg-time">${esc(timeLabel(message.createdAt))}</div>
  </div>`;
}

/* ---------- audit logs ---------- */

const RUN_KIND_LABEL = {
  scan: "规则扫描",
  gate: "研判",
  deep: "深度复核",
  manual: "手动检查",
};

const RUN_STATUS_LABEL = {
  watching: "已扫描",
  degraded: "降级",
  finding: "有发现",
  silent: "一切安好",
  failed: "失败",
};
const RUN_STATUS_TONE = {
  watching: "ok",
  degraded: "warn",
  finding: "warn",
  silent: "ok",
  failed: "bad",
};

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${String(Math.round((value % 60_000) / 1000)).padStart(2, "0")}s`;
}

function groupLogs(logs) {
  const runs = new Map();
  for (const log of logs) {
    if (!runs.has(log.runId)) {
      runs.set(log.runId, { runId: log.runId, runKind: log.runKind, logs: [] });
    }
    runs.get(log.runId).logs.push(log);
  }
  return [...runs.values()].map((run) => {
    run.logs.sort((left, right) => Number(left.seq) - Number(right.seq) || String(left.at).localeCompare(String(right.at)));
    run.start = run.logs.find((log) => log.kind === "run_start") || null;
    run.end = [...run.logs].reverse().find((log) => log.kind === "run_end") || null;
    run.judgment = run.logs.find((log) => log.kind === "judgment") || null;
    run.startedAt = run.start?.at || run.logs[0]?.at || "";
    run.endedAt = run.end?.at || run.logs[run.logs.length - 1]?.at || "";
    run.sources = run.logs.filter((log) => log.kind === "source");
    run.candidates = run.logs.filter((log) => log.kind === "candidate");
    run.tools = run.logs.filter((log) => log.kind === "tool_end" || log.kind === "tool_start");
    run.errors = run.logs.filter((log) => log.kind === "error");
    return run;
  }).sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
}

function logSourceHTML(log) {
  const payload = log.payload || {};
  return `<div class="wl-row${payload.ok ? "" : " is-error"}">
    <span class="wl-tag">${esc(payload.adapter || "")}${payload.kind ? `/${esc(payload.kind)}` : ""}</span>
    <span class="wl-main" title="${esc(payload.query || "")}">${esc(payload.query || "")}</span>
    <span class="wl-num">${payload.ok ? `${Number(payload.count) || 0} 条` : "失败"}${payload.durationMs ? ` · ${formatDuration(payload.durationMs)}` : ""}</span>
  </div>${payload.error ? `<div class="wl-error">${esc(payload.error)}</div>` : ""}`;
}

function logCandidateHTML(log) {
  const payload = log.payload || {};
  const title = payload.url
    ? `<a href="${esc(payload.url)}" target="_blank" rel="noreferrer">${esc(payload.title || payload.url)}</a>`
    : esc(payload.title || "");
  return `<div class="wl-row">
    <span class="wl-tag">${esc(String(payload.sourceTier || 3))}</span>
    <span class="wl-main">${title}${payload.categories?.length ? `<span class="wl-sub">${esc(payload.categories.join(" / "))}</span>` : ""}</span>
    <span class="wl-num">${Number(payload.score) || 0}</span>
  </div>`;
}

function logToolsHTML(run) {
  const starts = new Map();
  for (const log of run.logs) {
    if (log.kind === "tool_start") starts.set(log.payload?.toolCallId, log);
  }
  const rows = [];
  for (const log of run.logs) {
    if (log.kind !== "tool_end") continue;
    const payload = log.payload || {};
    const start = starts.get(payload.toolCallId);
    const status = payload.status === "error" ? "错误" : "完成";
    rows.push(`<div class="wl-tool">
      <div class="wl-row">
        <span class="wl-tag">${esc(payload.tool || "")}</span>
        <span class="wl-main" title="${esc(payload.detail || "")}">${esc(payload.detail || "")}</span>
        <span class="wl-num${payload.status === "error" ? " is-error" : ""}">${status}${payload.durationMs ? ` · ${formatDuration(payload.durationMs)}` : ""}</span>
      </div>
      ${payload.error ? `<div class="wl-error">${esc(payload.error)}</div>` : ""}
      ${payload.result ? `<details class="wl-result"><summary>结果</summary><pre>${esc(payload.result)}</pre></details>` : ""}
    </div>`);
    starts.delete(payload.toolCallId);
  }
  for (const start of starts.values()) {
    const payload = start.payload || {};
    rows.push(`<div class="wl-row">
      <span class="wl-tag">${esc(payload.tool || "")}</span>
      <span class="wl-main">${esc(payload.detail || "")}</span>
      <span class="wl-num">未完成</span>
    </div>`);
  }
  return rows.join("");
}

function logJudgmentHTML(run) {
  const log = run.judgment;
  if (!log) return "";
  const payload = log.payload || {};
  const evidence = (payload.evidence || []).map((item, index) => citationHTML(item, index)).filter(Boolean);
  return `<div class="wl-judgment">
    <div class="wl-judgment-head">
      <span class="watch-sev ${payload.material ? "warning" : "info"}">${payload.material ? "有发现" : "无重大变化"}</span>
      <span class="wl-num">${esc(payload.confidence ? `置信度 ${CONFIDENCE_LABEL[payload.confidence] || payload.confidence}` : "")}</span>
    </div>
    ${payload.headline ? `<div class="wl-judgment-title">${esc(payload.headline)}</div>` : ""}
    ${payload.summary ? `<div class="wl-judgment-text">${mdToHtml(payload.summary)}</div>` : ""}
    ${payload.materialReason ? `<div class="wl-judgment-text"><b>判断依据：</b>${esc(payload.materialReason)}</div>` : ""}
    ${Array.isArray(payload.checked) && payload.checked.length ? `<div class="wl-checks">${payload.checked.map((item) => `<div class="wl-check">${esc(item)}</div>`).join("")}</div>` : ""}
    ${payload.affected?.length ? `<div class="watch-chips" style="margin-top:6px">${affectedChips(payload.affected)}</div>` : ""}
    ${payload.impact ? impactHTML(payload.impact) : ""}
    ${evidence.length ? `<div class="watch-links" style="margin-top:6px">${evidence.join("")}</div>` : ""}
    ${payload.suggestedAction ? `<div class="wl-judgment-note">建议：${esc(payload.suggestedAction)}</div>` : ""}
  </div>`;
}

function renderLogs() {
  const overlayEl = $("#watchLogOverlay");
  if (!overlayEl) return;
  if (!ui.logs.open) {
    overlayEl.hidden = true;
    overlayEl.innerHTML = "";
    return;
  }
  overlayEl.hidden = false;
  const runs = groupLogs(ui.logs.logs || []);
  const body = ui.logs.loading
    ? `<div class="wl-empty">正在读取日志…</div>`
    : ui.logs.error
      ? `<div class="wl-empty is-error">${esc(ui.logs.error)}</div>`
      : runs.length
        ? runs.map((run, index) => {
            const status = run.end?.payload?.status || "running";
            const label = RUN_STATUS_LABEL[status] || (run.end ? status : "运行中");
            const tone = RUN_STATUS_TONE[status] || "";
            const sourceCount = run.sources.length;
            const candidateCount = Number(run.start?.payload?.candidates ?? run.candidates.length) || 0;
            const toolCount = run.logs.filter((log) => log.kind === "tool_end").length;
            const duration = run.end?.payload?.durationMs;
            const assistant = run.logs.find((log) => log.kind === "assistant");
            return `<details class="watch-log-run"${index === 0 ? " open" : ""}>
              <summary>
                <span class="wl-dot ${tone}"></span>
                <span class="wl-time">${esc(timeLabel(run.startedAt))}</span>
                <span class="wl-kind">${esc(RUN_KIND_LABEL[run.runKind] || run.runKind || "运行")}</span>
                <span class="wl-status ${tone}">${esc(label)}</span>
                <span class="wl-meta">${sourceCount ? `${sourceCount} 来源 · ` : ""}${candidateCount} 候选${toolCount ? ` · ${toolCount} 工具` : ""}${duration ? ` · ${formatDuration(duration)}` : ""}</span>
              </summary>
              <div class="wl-body">
                ${run.sources.length ? `<div class="wl-sec"><h4>来源</h4>${run.sources.map(logSourceHTML).join("")}</div>` : ""}
                ${run.candidates.length ? `<div class="wl-sec"><h4>候选</h4>${run.candidates.map(logCandidateHTML).join("")}</div>` : ""}
                ${run.tools.length ? `<div class="wl-sec"><h4>模型调用</h4>${logToolsHTML(run)}</div>` : ""}
                ${run.judgment ? `<div class="wl-sec"><h4>判断</h4>${logJudgmentHTML(run)}</div>` : ""}
                ${assistant?.payload?.text ? `<details class="wl-sec wl-assistant"><summary>模型回复</summary><pre>${esc(assistant.payload.text)}</pre></details>` : ""}
                ${run.errors.map((log) => `<div class="wl-error">${esc(log.payload?.message || "")}</div>`).join("")}
                ${run.end?.payload?.errors?.length ? `<div class="wl-error">${esc(run.end.payload.errors.join("；"))}</div>` : ""}
              </div>
            </details>`;
          }).join("")
        : `<div class="wl-empty">还没有日志。下一次扫描或检查后会出现。</div>`;
  overlayEl.innerHTML = `<div class="dialog watch-log-dialog" role="dialog" aria-modal="true" aria-labelledby="watchLogTitle">
    <div class="watch-log-head">
      <div class="watch-log-title">
        <h2 id="watchLogTitle">盯盘日志</h2>
        <p>${ui.logs.loading ? "正在读取…" : `${runs.length} 次运行 · 含无发现的扫描`}</p>
      </div>
      <div style="display:flex;gap:2px">
        <button class="icon-btn" data-watch-logs-refresh aria-label="刷新日志" title="刷新日志">${icon("refresh", 15)}</button>
        <button class="icon-btn" data-watch-logs-close aria-label="关闭">${icon("x", 16)}</button>
      </div>
    </div>
    <div class="watch-log-body">${body}</div>
  </div>`;
}

async function openLogs() {
  if (!ui.watch) return;
  ui.logs.open = true;
  ui.logs.loading = true;
  ui.logs.error = "";
  renderLogs();
  try {
    const data = await api(`/api/watch/${encodeURIComponent(ui.watch.id)}/logs?limit=600`);
    ui.logs.logs = Array.isArray(data.logs) ? data.logs : [];
  } catch (error) {
    ui.logs.error = error.message || "读取日志失败";
  } finally {
    ui.logs.loading = false;
    renderLogs();
  }
}

function closeLogs() {
  ui.logs.open = false;
  ui.logs.loading = false;
  ui.logs.error = "";
  ui.logs.logs = [];
  const overlayEl = $("#watchLogOverlay");
  if (overlayEl) {
    overlayEl.hidden = true;
    overlayEl.innerHTML = "";
  }
}

/* ---------- actions ---------- */

async function startWatch() {
  if (ui.submitting) return;
  ui.submitting = true;
  renderThread();
  try {
    const data = await api("/api/watch", { method: "POST", body: {} });
    ui.watch = data.watch;
    ui.messages = data.messages || [];
    ui.checks = data.checks || [];
    ui.detection = null;
    toast("已开始盯住");
    if (state.panelTab !== "watch") setPanelTab("watch");
    renderPanel();
  } catch (error) {
    toast(error.message || "开始盯盘失败");
  } finally {
    ui.submitting = false;
    renderThread();
  }
}

async function runCheck(deep = false) {
  if (!ui.watch) return;
  try {
    await api(`/api/watch/${encodeURIComponent(ui.watch.id)}/check`, {
      method: "POST",
      body: deep ? { deep: true } : {},
    });
    toast(deep ? "已开始深度复核" : "已开始检查");
    ui.watch = { ...ui.watch, status: "checking" };
    renderStatus();
  } catch (error) {
    toast(error.message || "启动检查失败");
  }
}

async function saveSettings() {
  if (!ui.watch) return;
  try {
    const body = {
      enabled: $("#watchEnabledEdit") ? $("#watchEnabledEdit").checked : ui.watch.enabled,
    };
    const data = await api(`/api/watch/${encodeURIComponent(ui.watch.id)}`, { method: "PATCH", body });
    ui.watch = data.watch;
    ui.settings = false;
    renderPanel();
    toast("设置已保存");
  } catch (error) {
    toast(error.message || "保存失败");
  }
}

async function rebuildBrief() {
  if (!ui.watch) return;
  try {
    const data = await api(`/api/watch/${encodeURIComponent(ui.watch.id)}/refresh`, { method: "POST" });
    ui.watch = data.watch;
    renderPanel();
    toast("关注点已按最新报告重建");
  } catch (error) {
    toast(error.message || "重建失败");
  }
}

async function deleteWatch() {
  if (!ui.watch) return;
  if (!window.confirm("删除盯盘？会同时清空这里的对话和检查记录。")) return;
  try {
    await api(`/api/watch/${encodeURIComponent(ui.watch.id)}`, { method: "DELETE" });
    resetWatch();
    await loadWatch();
    toast("已删除盯盘");
  } catch (error) {
    toast(error.message || "删除失败");
  }
}

async function markRead() {
  if (!ui.watch || ui.markingRead) return;
  if (!Number(ui.watch.counts?.unread)) return;
  ui.markingRead = true;
  try {
    await api(`/api/watch/${encodeURIComponent(ui.watch.id)}/read`, { method: "POST" });
  } catch {
    /* read state is best-effort */
  } finally {
    ui.markingRead = false;
  }
}

async function sendQuestion(text) {
  const question = String(text || "").trim();
  if (!question || !ui.watch || ui.typing) return;
  try {
    await api(`/api/watch/${encodeURIComponent(ui.watch.id)}/messages`, {
      method: "POST",
      body: { text: question },
    });
    ui.typing = true;
    renderThread();
  } catch (error) {
    toast(error.message || "发送失败");
  }
}

/* ---------- wiring ---------- */

function autosize() {
  const input = $("#watchInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(104, Math.max(34, input.scrollHeight))}px`;
}

function syncComposer() {
  const input = $("#watchInput");
  const button = $("#watchSend");
  if (!input || !button) return;
  button.disabled = !ui.watch || ui.typing || !input.value.trim();
  input.disabled = !ui.watch || ui.typing;
}

function setPanelTab(tab) {
  state.panelTab = tab === "watch" ? "watch" : "files";
  $$("#panelTabs .rp-tab").forEach((button) => {
    const active = button.dataset.panel === state.panelTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderPanel();
}

function wire() {
  if (ui.wired) return;
  ui.wired = true;

  $("#panelTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-panel]");
    if (!tab) return;
    setPanelTab(tab.dataset.panel);
  });

  const root = watchRoot();
  root?.addEventListener("click", (event) => {
    if (event.target.closest("[data-watch-logs]")) {
      void openLogs();
      return;
    }
    const focusToggle = event.target.closest("[data-watch-focus]");
    if (focusToggle) {
      const panel = document.getElementById(focusToggle.dataset.watchFocus);
      if (panel) {
        panel.hidden = !panel.hidden;
        focusToggle.setAttribute("aria-expanded", String(!panel.hidden));
      }
      return;
    }
    if (event.target.closest("[data-watch-start]")) {
      void startWatch();
      return;
    }
    if (event.target.closest("[data-watch-retry]")) {
      ui.loaded = false;
      ui.watch = null;
      void loadWatch();
      return;
    }
    if (event.target.closest("[data-watch-check]")) {
      void runCheck(false);
      return;
    }
    if (event.target.closest("[data-watch-settings]")) {
      ui.settings = !ui.settings;
      renderThread();
      return;
    }
    if (event.target.closest("[data-watch-close-settings]")) {
      ui.settings = false;
      renderThread();
      return;
    }
    if (event.target.closest("[data-watch-save]")) {
      void saveSettings();
      return;
    }
    if (event.target.closest("[data-watch-refresh]")) {
      void rebuildBrief();
      return;
    }
    if (event.target.closest("[data-watch-delete]")) {
      void deleteWatch();
      return;
    }
    if (event.target.closest("[data-watch-report]")) {
      if (ui.watch?.reportPath) openMaterial(ui.watch.reportPath);
      return;
    }
    const ask = event.target.closest("[data-watch-ask]");
    if (ask) {
      const question = ask.dataset.watchAsk || "";
      const input = $("#watchInput");
      if (!input) return;
      input.value = question;
      autosize();
      syncComposer();
      input.focus();
      void sendQuestion(question);
      return;
    }
    const file = event.target.closest("[data-watch-file]");
    if (file) {
      openMaterial(file.dataset.watchFile);
      return;
    }
  });

  $("#watchLogOverlay")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget || event.target.closest("[data-watch-logs-close]")) {
      closeLogs();
      return;
    }
    if (event.target.closest("[data-watch-logs-refresh]")) {
      void openLogs();
      return;
    }
    const file = event.target.closest("[data-watch-file]");
    if (file) {
      closeLogs();
      openMaterial(file.dataset.watchFile);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.logs.open) {
      event.preventDefault();
      closeLogs();
    }
  });

  $("#watchComposer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#watchInput");
    const text = input?.value.trim();
    if (!text) return;
    input.value = "";
    autosize();
    syncComposer();
    void sendQuestion(text);
  });
  $("#watchInput")?.addEventListener("input", () => {
    autosize();
    syncComposer();
  });
  $("#watchInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("#watchComposer")?.requestSubmit();
    }
  });
}

export function initWatch() {
  wire();
  return loadWatch();
}

export function resetWatch() {
  ui.watch = null;
  ui.messages = [];
  ui.checks = [];
  ui.detection = null;
  ui.error = "";
  ui.loaded = false;
  ui.typing = false;
  ui.settings = false;
  ui.submitting = false;
  ui.markingRead = false;
  ui.scrollTarget = null;
  ui.scrollBottom = true;
  ui.logs = { open: false, loading: false, error: "", logs: [] };
  closeLogs();
}

/** SSE: watch.updated */
export function upsertWatch(watch) {
  if (!watch) return;
  const same = ui.watch?.id === watch.id;
  ui.watch = watch;
  if (!same) {
    ui.messages = [];
    ui.detection = null;
  }
  renderPanel();
}

/** SSE: watch.message */
export function pushWatchMessage(message) {
  if (!message) return;
  if (ui.messages.some((item) => item.id === message.id)) return;
  ui.messages.push(message);
  if (message.role === "assistant" || message.kind === "error") ui.typing = false;
  if (message.role === "user") ui.typing = true;
  if (message.kind === "finding") ui.scrollTarget = message.id;
  if (ui.watch) {
    const findings = ui.messages.filter((item) => item.kind === "finding").length;
    ui.watch = {
      ...ui.watch,
      counts: { ...(ui.watch.counts || {}), findings },
    };
  }
  renderPanel();
}

/** SSE: watch.deleted */
export function removeWatch() {
  resetWatch();
  renderPanel();
}

Object.assign(window, {
  Watch: {
    init: initWatch,
    load: loadWatch,
    reset: resetWatch,
    upsert: upsertWatch,
    push: pushWatchMessage,
    remove: removeWatch,
    renderPanel,
    setPanelTab,
    isOpen: () => state.panelTab === "watch",
  },
});
