/** Right-side model trace: an ordered, read-only history of model changes. */

import { state } from "../state/store.js";
import { $, esc, icon } from "../shared/dom.js";
import { api } from "../api/client.js";
import { toast } from "../shared/toast.js";

const VERDICT_LABEL = { high: "偏高", fair: "合理", low: "偏低" };
const KIND_LABEL = {
  generated: "生成",
  revised: "修订",
  updated: "更新",
  branch: "分支",
  checkpoint: "检查点",
  proposed: "提案",
  adjustment: "人工确认",
};
const JUDGMENT_LABEL = {
  recorded: "已记录",
  pending_confirmation: "待确认",
  confirmed: "已确认调整",
  cancelled: "暂不调整",
  adopted: "已采纳",
};

let data = null;
let loading = false;
const expanded = new Set();

function fmtNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : String(value ?? "");
}

function fmtTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function fmtDate(value) {
  const full = fmtTime(value);
  return full.slice(0, 10);
}

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || "变化";
}

function headerHTML(view) {
  const current = view.current;
  const target = current?.target;
  return `<div class="trp-head">
    <div class="trp-eyebrow">模型追踪</div>
    <div class="trp-title">${esc(view.subject || "本项目")}</div>
    ${view.question ? `<div class="trp-sub">${esc(view.question)}</div>` : ""}
    ${target != null ? `<div class="trp-now">
      <div class="trp-now-main"><span class="trp-now-label">当前目标价</span><span class="trp-now-value">¥${fmtNumber(target)}</span></div>
      <div class="trp-now-side">${current.delta ? `<span class="trp-delta">${esc(current.delta)}</span>` : ""}${current.rating ? `<span class="trp-rating">${esc(current.rating)}</span>` : ""}</div>
    </div>` : ""}
    <div class="trp-meta">${view.summary.total} 次变化${view.summary.firstAt ? ` · 从 ${esc(fmtDate(view.summary.firstAt))} 开始` : ""}</div>
  </div>`;
}

function filesHTML(files) {
  if (!Array.isArray(files) || !files.length) return "";
  return `<div class="trp-files"><span class="trp-files-label">改动文件</span>${files.map((file) => {
    const label = file.label || file.name || "文件";
    const version = file.version ? `<small>v${esc(file.version)}</small>` : "";
    const title = file.path || file.name || label;
    return file.materialId
      ? `<button type="button" class="trp-file" data-trace-file="${esc(file.materialId)}" title="${esc(title)}">${icon("file-text", 11)}${esc(label)}${version}</button>`
      : `<span class="trp-file is-static" title="${esc(title)}">${icon("file-text", 11)}${esc(label)}${version}</span>`;
  }).join("")}</div>`;
}

function judgmentHTML(judgment) {
  if (!judgment) return "";
  const label = VERDICT_LABEL[judgment.verdict] || judgment.verdict;
  const status = JUDGMENT_LABEL[judgment.status] || "";
  return `<div class="trp-judgment ${esc(judgment.status)}">
    ${icon("check", 11)}
    <span>你的判断：<b>${esc(label)}</b>${judgment.note ? ` · ${esc(judgment.note)}` : ""}</span>
    <small>${esc(status)}</small>
  </div>`;
}

function entryHTML(entry, isLast) {
  const reason = String(entry.reason || "").trim();
  const open = expanded.has(entry.id);
  const collapsible = reason.length > 180 || reason.includes("\n");
  return `<div class="trp-entry">
    <div class="trp-rail"><span class="trp-dot ${esc(entry.kind)}"></span></div>
    <div class="trp-card${isLast ? " is-last" : ""}">
      <div class="trp-meta-row">
        <span class="trp-seq">#${esc(entry.seq)}</span>
        <span class="trp-time">${esc(fmtTime(entry.at))}</span>
        <span class="trp-kind ${esc(entry.kind)}">${esc(kindLabel(entry.kind))}</span>
      </div>
      <div class="trp-entry-title">${esc(entry.title)}</div>
      ${entry.summary ? `<div class="trp-entry-summary">${esc(entry.summary)}</div>` : ""}
      ${Array.isArray(entry.changes) && entry.changes.length
        ? `<div class="trp-changes">${entry.changes.map((change) => `<span>${esc(change)}</span>`).join("")}</div>`
        : ""}
      ${reason ? `<div class="trp-reason${open ? " is-open" : ""}">
        <div class="trp-reason-label">为什么变</div>
        <div class="trp-reason-text">${esc(reason)}</div>
        ${collapsible ? `<button type="button" class="trp-link" data-trace-expand="${esc(entry.id)}">${open ? "收起" : "展开全文"}</button>` : ""}
      </div>` : ""}
      ${filesHTML(entry.files)}
      ${judgmentHTML(entry.judgment)}
    </div>
  </div>`;
}

export function renderTracePanel() {
  if (state.filter !== "trace") return;
  const el = $("#fileList");
  if (!el) return;
  if (!data) {
    el.innerHTML = '<div class="rp-empty">加载追踪…</div>';
    if (!loading) void loadTrace();
    return;
  }
  if (!Array.isArray(data.entries) || !data.entries.length) {
    el.innerHTML = `<div class="trp-empty">
      <div class="trp-eyebrow">模型追踪</div>
      <div class="trp-empty-title">还没有模型变更记录</div>
      <p>这个项目的估值模型生成后，这里会从第一次生成开始，按顺序记录每一次变化、原因和改动的文件。</p>
      <button type="button" class="trp-link" data-trace-reload>重新读取 ${icon("refresh", 11)}</button>
    </div>`;
    return;
  }
  const top = el.scrollTop;
  el.innerHTML = `<div class="trp-panel">
    ${headerHTML(data)}
    <div class="trp-list">${data.entries.map((entry, index) => entryHTML(entry, index === data.entries.length - 1)).join("")}</div>
    <div class="trp-foot">只追加，不覆盖历史。人工判断和建议调整都会留在这条时间线上。</div>
  </div>`;
  el.scrollTop = top;
}

export function setTraceData(next) {
  data = next;
  renderTracePanel();
  window.dispatchEvent(new CustomEvent("trace:updated", { detail: data }));
}

export function getTraceData() {
  return data;
}

export function resetTraceView() {
  data = null;
  expanded.clear();
  window.dispatchEvent(new CustomEvent("trace:reset"));
}

export async function loadTrace() {
  if (loading) return data;
  loading = true;
  try {
    data = await api("/api/trace/current");
    renderTracePanel();
    window.dispatchEvent(new CustomEvent("trace:updated", { detail: data }));
    return data;
  } catch (error) {
    const el = $("#fileList");
    if (el && state.filter === "trace") {
      el.innerHTML = `<div class="rp-empty">追踪加载失败：${esc(error.message)}<br><button type="button" class="trp-link" data-trace-reload>重试</button></div>`;
    }
    return null;
  } finally {
    loading = false;
  }
}

export function initTrace() {
  document.addEventListener("click", (event) => {
    if (state.filter !== "trace") return;
    const expand = event.target.closest("[data-trace-expand]");
    if (expand) {
      const id = expand.dataset.traceExpand;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTracePanel();
      return;
    }
    const file = event.target.closest("[data-trace-file]");
    if (file) {
      if (typeof window.openFile === "function") window.openFile(file.dataset.traceFile);
      else toast("资料面板尚未就绪", "warn");
      return;
    }
    if (event.target.closest("[data-trace-reload]")) {
      void loadTrace();
    }
  });
  window.Trace = {
    renderPanel: renderTracePanel,
    reload: loadTrace,
    reset: resetTraceView,
    count: () => (Array.isArray(data?.entries) ? data.entries.length : 0),
  };
  return loadTrace();
}
