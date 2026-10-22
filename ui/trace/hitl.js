/** Chat-side HITL for the model trace: one judgment, then one confirmation. */

import { $, esc, icon } from "../shared/dom.js";
import { state } from "../state/store.js";
import { api } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";
import { getTraceData, loadTrace, setTraceData } from "./panel.js";

const VERDICT_LABEL = { high: "偏高", fair: "合理", low: "偏低" };
const VERDICT_HINT = {
  high: "模型给高了",
  fair: "基本合理",
  low: "模型给低了",
};

let selected = null;
let note = "";
let focusId = null;
let busy = false;
let adoptionPromptOpen = false;
let lastMessage = "";

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

function syncFocus(entry) {
  if ((entry?.id || null) !== focusId) {
    focusId = entry?.id || null;
    selected = null;
    note = "";
    adoptionPromptOpen = false;
  }
}

function optionsHTML() {
  return ["high", "fair", "low"].map((verdict) => `<button type="button" class="trh-option${selected === verdict ? " is-active" : ""}" data-trace-verdict="${verdict}">
    <b>${VERDICT_LABEL[verdict]}</b><small>${VERDICT_HINT[verdict]}</small>
  </button>`).join("");
}

function judgeHTML(entry) {
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  const isProposal = entry.kind === "proposed";
  const hint = adoptionPromptOpen
    ? "确认后会把提案写入主报告和模型"
    : selected === "fair"
      ? (isProposal ? "合理：先认可提案，采纳需再确认" : "合理：只记录，不调整模型")
      : selected
        ? "下一步会再确认一次"
        : "选一个判断";
  const submitLabel = adoptionPromptOpen
    ? "确认采纳"
    : isProposal && selected === "fair"
      ? "认可提案"
      : "记录判断";
  return `<div class="trh-card" id="traceHitlCard">
    <div class="trh-head"><span class="trh-kicker">模型追踪 · 第 ${esc(entry.seq)} 次变化</span><span class="trh-when">${esc(fmtTime(entry.at))}</span></div>
    <div class="trh-title">${isProposal ? "这次估值调整提案，你怎么判断？" : "这次估值，你怎么判断？"}</div>
    <div class="trh-change">${esc(entry.title)}</div>
    ${changes.length ? `<div class="trh-changes">${changes.map((change) => `<span>${esc(change)}</span>`).join("")}</div>` : ""}
    <div class="trh-options">${optionsHTML()}</div>
    <textarea id="traceNote" rows="2" maxlength="200" placeholder="补一句理由（可选）">${esc(note)}</textarea>
    ${adoptionPromptOpen ? `<div class="trh-adopt">
      <div>确认把这份提案写入主投资框架报告、估值模型和 analysis-state.json？</div>
      <div class="trh-adopt-actions">
        <button type="button" class="trh-btn primary" data-trace-adopt="yes" ${busy ? "disabled" : ""}>${busy ? "处理中…" : "确认采纳"}</button>
        <button type="button" class="trh-btn" data-trace-adopt="no" ${busy ? "disabled" : ""}>只记录判断</button>
        <button type="button" class="trh-link" data-trace-adopt="cancel" ${busy ? "disabled" : ""}>返回</button>
      </div>
    </div>` : `<div class="trh-foot">
      <span class="trh-hint">${esc(hint)}</span>
      <button type="button" class="trh-btn primary" data-trace-submit ${selected && !busy ? "" : "disabled"}>${busy ? "记录中…" : submitLabel}</button>
    </div>`}
  </div>`;
}

function confirmHTML(pending) {
  const label = VERDICT_LABEL[pending.verdict] || pending.verdict;
  const entry = pending.entry;
  return `<div class="trh-card is-confirm" id="traceHitlCard">
    <div class="trh-head"><span class="trh-kicker">待确认${entry ? ` · 第 ${esc(entry.seq)} 次变化` : ""}</span><span class="trh-when">再确认一次</span></div>
    <div class="trh-title">你判断这次估值${esc(label)}</div>
    ${pending.note ? `<div class="trh-note">“${esc(pending.note)}”</div>` : ""}
    <div class="trh-sub">确认后，Workbench 会按“${esc(label)}”方向复核并调整估值模型、报告和目标价；不会修改 inputs/ 里的原始资料。</div>
    <div class="trh-actions">
      <button type="button" class="trh-btn primary" data-trace-confirm="adjust" ${busy ? "disabled" : ""}>${busy ? "处理中…" : "确认调整"}</button>
      <button type="button" class="trh-btn" data-trace-confirm="cancel" ${busy ? "disabled" : ""}>先不改</button>
    </div>
  </div>`;
}

function doneHTML() {
  return `<div class="trh-done" id="traceHitlCard">
    ${icon("check", 12)}
    <span>${esc(lastMessage)}</span>
    <button type="button" class="trh-link" data-trace-open>查看追踪</button>
  </div>`;
}

export function renderTraceHitl() {
  const slot = $("#traceHitl");
  if (!slot) return;
  const data = getTraceData();
  if (!data || !Array.isArray(data.entries) || !data.entries.length) {
    slot.hidden = true;
    slot.innerHTML = "";
    return;
  }

  if (data.pendingJudgment) {
    slot.innerHTML = confirmHTML(data.pendingJudgment);
    slot.hidden = false;
    return;
  }

  if (data.focus) {
    syncFocus(data.focus);
    slot.innerHTML = judgeHTML(data.focus);
    slot.hidden = false;
    return;
  }

  if (lastMessage) {
    slot.innerHTML = doneHTML();
    slot.hidden = false;
    return;
  }

  slot.hidden = true;
  slot.innerHTML = "";
}

async function submitJudgment({ adopt = false, force = false } = {}) {
  const data = getTraceData();
  const entry = data?.focus;
  if (!entry || !selected || busy) return;
  if (!force && entry.kind === "proposed" && selected === "fair" && !adopt) {
    adoptionPromptOpen = true;
    renderTraceHitl();
    return;
  }
  busy = true;
  renderTraceHitl();
  try {
    const result = await api(`/api/trace/entries/${encodeURIComponent(entry.id)}/judge`, {
      method: "POST",
      body: { verdict: selected, note, adopt: Boolean(adopt) },
    });
    setTraceData(result);
    lastMessage = result.message || "已记录你的判断";
    if (result.adoption?.prompt) {
      try {
        await sendAdjustment(result.adoption.prompt);
        lastMessage = "已采纳提案，正在让 Workbench 写入主报告和模型…";
      } catch (error) {
        lastMessage = "已采纳提案；自动发送失败，可在对话里再发一次";
        toast(error.message || "写入请求未发出", "warn");
      }
    }
    adoptionPromptOpen = false;
    toast(lastMessage, "ok");
  } catch (error) {
    toast(error.message || "记录判断失败", "warn");
  } finally {
    busy = false;
    renderTraceHitl();
  }
}

async function sendAdjustment(prompt) {
  if (!prompt) return;
  if (state.agentTransport === "copilotkit" && runtime.pilot?.send) {
    await runtime.pilot.send({ text: prompt, attachments: [] });
    return;
  }
  let sessionId = state.activeSession;
  if (!sessionId && typeof runtime.createSession === "function") {
    const created = await runtime.createSession();
    sessionId = created?.id || state.activeSession;
  }
  if (!sessionId) throw new Error("没有可用会话");
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: { text: prompt },
  });
}

async function decideConfirmation(action) {
  const data = getTraceData();
  const pending = data?.pendingJudgment;
  if (!pending || busy) return;
  busy = true;
  renderTraceHitl();
  try {
    const result = await api(`/api/trace/judgments/${encodeURIComponent(pending.id)}/confirm`, {
      method: "POST",
      body: { action },
    });
    setTraceData(result);
    lastMessage = result.message || (action === "adjust" ? "已确认调整" : "已保留你的判断");
    if (action === "adjust" && result.adjustment?.prompt) {
      try {
        await sendAdjustment(result.adjustment.prompt);
        lastMessage = "已确认调整，正在让 Workbench 复核估值…";
      } catch (error) {
        lastMessage = "已确认调整；自动发送失败，可在对话里再发一次";
        toast(error.message || "调整请求未发出", "warn");
      }
    }
    toast(lastMessage, "ok");
  } catch (error) {
    toast(error.message || "确认失败", "warn");
  } finally {
    busy = false;
    renderTraceHitl();
  }
}

function openTrace() {
  const win = document.getElementById("window");
  const toggle = document.getElementById("filesToggle");
  if (win) {
    const narrow = window.innerWidth <= 980;
    if (narrow && !win.classList.contains("files-open")) toggle?.click();
    else if (!narrow && win.classList.contains("files-collapsed")) toggle?.click();
  }
  const tab = document.querySelector('#fileFilters [data-filter="trace"]');
  if (tab) tab.click();
  else toast("追踪面板尚未就绪", "warn");
}

export function resetTraceHitl() {
  selected = null;
  note = "";
  focusId = null;
  busy = false;
  adoptionPromptOpen = false;
  lastMessage = "";
  const slot = $("#traceHitl");
  if (slot) {
    slot.hidden = true;
    slot.innerHTML = "";
  }
}

export function initTraceHitl() {
  const slot = $("#traceHitl");
  if (!slot) return;
  slot.addEventListener("click", (event) => {
    const verdict = event.target.closest("[data-trace-verdict]");
    if (verdict) {
      selected = verdict.dataset.traceVerdict;
      adoptionPromptOpen = false;
      renderTraceHitl();
      return;
    }
    if (event.target.closest("[data-trace-submit]")) {
      void submitJudgment();
      return;
    }
    const adopt = event.target.closest("[data-trace-adopt]");
    if (adopt) {
      const action = adopt.dataset.traceAdopt;
      if (action === "cancel") {
        adoptionPromptOpen = false;
        renderTraceHitl();
        return;
      }
      void submitJudgment({ adopt: action === "yes", force: true });
      return;
    }
    const confirm = event.target.closest("[data-trace-confirm]");
    if (confirm) {
      void decideConfirmation(confirm.dataset.traceConfirm);
      return;
    }
    if (event.target.closest("[data-trace-open]")) {
      openTrace();
    }
  });
  slot.addEventListener("input", (event) => {
    if (event.target?.id === "traceNote") note = event.target.value;
  });
  window.addEventListener("trace:updated", renderTraceHitl);
  window.addEventListener("trace:reset", resetTraceHitl);
  if (getTraceData()) renderTraceHitl();
  else loadTrace().then(renderTraceHitl).catch(() => {});
}
