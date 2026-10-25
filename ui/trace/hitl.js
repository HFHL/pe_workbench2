/**
 * Chat-side HITL for the model trace: one judgment, then one confirmation.
 *
 * The card is mounted inside the conversation, right after the last answer, so
 * it reads as a follow-up question instead of a modal covering the chat. It
 * always names the number being judged (current target price, market price and
 * scenario band when the analysis state carries them).
 */

import { esc, icon, threadEl } from "../shared/dom.js";
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
const SCENARIO_LABEL = { base: "基准", bull: "乐观", bear: "悲观" };

let selected = null;
let note = "";
let focusId = null;
let busy = false;
let adoptionPromptOpen = false;
let lastMessage = "";

/* The card lives in the thread, which re-renders on every message update. Keep
   one node and re-mount it instead of rebuilding it, so a half-typed note
   survives a streaming re-render. */
let host = null;
let lastHTML = null;

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

function fmtNum(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toLocaleString("zh-CN", { maximumFractionDigits: digits });
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

/* ---------- valuation: the number the judgment is about ---------- */

function valuationHTML(view, entry) {
  const current = view?.current || null;
  const target = current?.target;
  const targetNumber = target != null && Number.isFinite(Number(target)) ? Number(target) : null;
  const isProposal = entry?.kind === "proposed";
  const previous = current?.previousTarget != null && Number.isFinite(Number(current.previousTarget))
    ? Number(current.previousTarget)
    : null;
  const market = current?.market || null;
  const upside = Number(current?.upsidePct);
  const scenarios = Array.isArray(current?.scenarios) ? current.scenarios : [];
  const delta = String(current?.delta || "");

  if (targetNumber == null) {
    // No valuation on file: fall back to the change chips, which still carry
    // numbers when the model moved a target price.
    const fallback = Array.isArray(entry?.changes) ? entry.changes.find((item) => /\d/.test(String(item))) : "";
    if (!fallback) return "";
    return `<div class="trh-val is-soft">
      <div>
        <span class="trh-val-label">${isProposal ? "提案估值（尚未写入）" : "本次变化"}</span>
        <span class="trh-val-num">${esc(fallback)}</span>
      </div>
    </div>`;
  }

  const side = market && market.price
    ? `<span class="trh-val-market">现价 ${fmtNum(market.price)} 元</span>
       ${Number.isFinite(upside) ? `<span class="trh-val-gap ${upside >= 0 ? "up" : "down"}">${upside >= 0 ? "空间 +" : "空间 "}${upside.toFixed(1)}%</span>` : ""}`
    : previous != null && previous
      ? `<span class="trh-val-market">上次 ${fmtNum(previous)} 元</span>
         ${delta ? `<span class="trh-val-gap ${delta.startsWith("-") ? "down" : "up"}">${esc(delta)}</span>` : ""}`
      : "";

  const foot = [];
  if (scenarios.length >= 2) {
    const low = scenarios[0];
    const high = scenarios[scenarios.length - 1];
    foot.push(`情景 ${fmtNum(low.value)}（${esc(SCENARIO_LABEL[low.scenario] || low.scenario || "低")}）– ${fmtNum(high.value)}（${esc(SCENARIO_LABEL[high.scenario] || high.scenario || "高")}）`);
  } else if (previous != null && previous) {
    foot.push(`上次估值 ${fmtNum(previous)} 元${delta ? `（${esc(delta)}）` : ""}`);
  }
  if (current?.valuationDate) foot.push(`估值日 ${esc(String(current.valuationDate).slice(0, 10))}`);
  if (current?.rating) foot.push(esc(current.rating));
  if (isProposal) foot.push("提案未写入主模型");

  return `<div class="trh-val">
    <div class="trh-val-main">
      <span class="trh-val-label">${isProposal ? "当前模型估值（提案未采纳）" : "当前模型估值"}</span>
      <span class="trh-val-num">¥${fmtNum(targetNumber)}<small>${esc(current?.unit || "元/股")}</small></span>
    </div>
    <div class="trh-val-side">${side}</div>
  </div>${foot.length ? `<div class="trh-val-foot">${foot.map((item) => `<span>${item}</span>`).join("")}</div>` : ""}`;
}

/* ---------- cards ---------- */

function judgeHTML(entry, view) {
  const title = String(entry.title || "").replace(/\s+/g, "");
  // Drop chips the title already spells out; keep the ones that add a method
  // or scope the title does not mention.
  const changes = (Array.isArray(entry.changes) ? entry.changes : []).filter((change) => {
    const text = String(change || "").replace(/\s+/g, "");
    return text && !title.includes(text);
  });
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
  return `<div class="trh-msg">
    <span class="trh-avatar" aria-hidden="true">${icon("spark", 14)}</span>
    <div class="trh-main" id="traceHitlCard">
      <div class="trh-head"><span class="trh-kicker">模型追踪 · 第 ${esc(entry.seq)} 次变化</span><span class="trh-when">${esc(fmtTime(entry.at))}</span></div>
      <div class="trh-title">${isProposal ? "这次估值调整提案，你怎么判断？" : "这次估值，你怎么判断？"}</div>
      <div class="trh-change">${esc(entry.title)}</div>
      ${valuationHTML(view, entry)}
      ${changes.length ? `<div class="trh-changes">${changes.map((change) => `<span>${esc(change)}</span>`).join("")}</div>` : ""}
      <div class="trh-options">${optionsHTML()}</div>
      <textarea id="traceNote" rows="2" maxlength="200" placeholder="补一句理由（可选）"></textarea>
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
    </div>
  </div>`;
}

function confirmHTML(pending, view) {
  const label = VERDICT_LABEL[pending.verdict] || pending.verdict;
  const entry = pending.entry;
  return `<div class="trh-msg">
    <span class="trh-avatar" aria-hidden="true">${icon("spark", 14)}</span>
    <div class="trh-main is-confirm" id="traceHitlCard">
      <div class="trh-head"><span class="trh-kicker">待确认${entry ? ` · 第 ${esc(entry.seq)} 次变化` : ""}</span><span class="trh-when">再确认一次</span></div>
      <div class="trh-title">你判断这次估值${esc(label)}</div>
      ${pending.note ? `<div class="trh-note">“${esc(pending.note)}”</div>` : ""}
      ${entry ? valuationHTML(view, entry) : ""}
      <div class="trh-sub">确认后，Workbench 会按“${esc(label)}”方向复核并调整估值模型、报告和目标价；不会修改 inputs/ 里的原始资料。</div>
      <div class="trh-actions">
        <button type="button" class="trh-btn primary" data-trace-confirm="adjust" ${busy ? "disabled" : ""}>${busy ? "处理中…" : "确认调整"}</button>
        <button type="button" class="trh-btn" data-trace-confirm="cancel" ${busy ? "disabled" : ""}>先不改</button>
      </div>
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

/* ---------- mounting into the conversation ---------- */

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "traceHitl";
  host.className = "trace-hitl-slot";
  host.hidden = true;
  host.addEventListener("click", onClick);
  host.addEventListener("input", onInput);
  return host;
}

function paint(html) {
  const el = ensureHost();
  if (html === lastHTML) return el;
  const active = document.activeElement;
  const typing = Boolean(active && active.id === "traceNote" && el.contains(active));
  const caret = typing ? active.selectionStart : null;
  el.innerHTML = html;
  lastHTML = html;
  const area = el.querySelector("#traceNote");
  if (area) area.value = note;
  if (typing && area) {
    area.focus();
    const position = caret == null ? area.value.length : Math.min(caret, area.value.length);
    try {
      area.setSelectionRange(position, position);
    } catch { /* textarea may already be detached */ }
  }
  return el;
}

function mount(el, { reveal = false } = {}) {
  const thread = threadEl;
  if (!thread) return;
  const wasShown = el.isConnected && !el.hidden;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
  let inner = thread.querySelector(".thread-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.className = "thread-inner";
    thread.appendChild(inner);
  }
  const empty = thread.querySelector(".thread-empty");
  if (empty) empty.hidden = true;
  el.hidden = false;
  if (el.parentElement !== inner || inner.lastElementChild !== el) inner.appendChild(el);
  // Follow the number, not the scrollbar: only pull the view down when the
  // reader is already at the end of the conversation (or on first load).
  if (reveal || !wasShown && (nearBottom || thread.scrollTop <= 0)) {
    thread.scrollTop = thread.scrollHeight;
  }
}

function hide() {
  lastHTML = null;
  if (host) {
    host.hidden = true;
    host.innerHTML = "";
    host.remove();
  }
  const empty = threadEl?.querySelector(".thread-empty");
  if (empty) empty.hidden = false;
}

export function renderTraceHitl(options = {}) {
  const data = getTraceData();
  if (!data || !Array.isArray(data.entries) || !data.entries.length) {
    hide();
    return;
  }
  const reveal = options.reveal === true;

  if (data.pendingJudgment) {
    mount(paint(confirmHTML(data.pendingJudgment, data)), { reveal });
    return;
  }

  if (data.focus) {
    syncFocus(data.focus);
    mount(paint(judgeHTML(data.focus, data)), { reveal });
    return;
  }

  if (lastMessage) {
    mount(paint(doneHTML()), { reveal });
    return;
  }

  hide();
}

/* ---------- actions ---------- */

function onClick(event) {
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
  if (event.target.closest("[data-trace-open]")) openTrace();
}

function onInput(event) {
  if (event.target?.id === "traceNote") note = event.target.value;
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
    lastMessage = result.message || "已记录你的判断";
    setTraceData(result);
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
    lastMessage = result.message || (action === "adjust" ? "已确认调整" : "已保留你的判断");
    setTraceData(result);
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
  hide();
}

export function initTraceHitl() {
  window.addEventListener("trace:updated", renderTraceHitl);
  window.addEventListener("trace:reset", resetTraceHitl);
  const reveal = { reveal: true };
  if (getTraceData()) renderTraceHitl(reveal);
  else loadTrace().then(() => renderTraceHitl(reveal)).catch(() => {});
}
