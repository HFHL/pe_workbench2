/** Right-hand materials panel, versions cards, tasks, filters and notifications. */

import {
  $, $$, esc, icon, win, threadEl, fileListEl, attachmentsEl, inputEl,
  kindOf, extOf, formatSize, shortTime, isNarrow, STATUS, SOURCE,
} from "../shared/dom.js";
import { state, selectors } from "../state/store.js";
import { api } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";
import { asrFileLine } from "../previews/previews.js";

const activeSession = () => selectors.activeSession();
const fileById = (id) => selectors.fileById(id);
const taskById = (id) => selectors.taskById(id);
const latest = (file) => selectors.latest(file);
const openFile = (id, version) => runtime.openFile?.(id, version);
const openTask = (id) => runtime.openTask?.(id);
const renderThread = (...args) => runtime.renderThread?.(...args);
const scheduleThread = (...args) => runtime.scheduleThread?.(...args);
const renderAttachments = (...args) => runtime.renderAttachments?.(...args);
const syncComposer = (...args) => runtime.syncComposer?.(...args);

function visibleFiles() {
  return state.files.filter(f => state.filter === 'all' || f.kind === state.filter);
}

function renderPanel() {
  const tasks = state.filter === 'tasks';
  const tracking = state.filter === 'tracking';
  $('#panelTitle').textContent = tracking ? '跟踪' : tasks ? '计划' : '资料';
  const newTrack = $('#newTrackBtn');
  if (newTrack) newTrack.hidden = !tracking;
  $('#fileHint').hidden = tracking || tasks || state.files.length === 0;
  if (tracking || tasks) $('#filePickbar').hidden = true;
  if (tracking) {
    $('#fileCount').textContent = String(window.Tracking?.count?.() ?? 0);
    window.Tracking?.renderPanel?.();
    return;
  }
  if (tasks) {
    $('#fileCount').textContent = String(state.tasks.length);
    renderTasks();
  } else {
    const visible = visibleFiles();
    $('#fileCount').textContent = String(visible.length);
    renderFiles(visible);
  }
  syncPickbar();
}
window.__peRenderPanel = renderPanel;

function renderFiles(visible) {
  const order = ['今天', '昨天', '更早'];
  let html = '';
  order.forEach(day => {
    const items = visible.filter(f => f.day === day);
    if (!items.length) return;
    html += `<div class="group-label">${day}</div>`;
    html += items.map(fileCard).join('');
  });
  fileListEl.innerHTML = html || `<div class="rp-empty">没有资料</div>`;
  state.files.forEach(f => { delete f.flash; });
  syncPickbar(visible);
}

function refreshFileCards() {
  if (state.filter === 'tasks' || state.filter === 'tracking') return;
  const top = fileListEl.scrollTop;
  renderFiles(visibleFiles());
  fileListEl.scrollTop = top;
}

function fileCard(f) {
  const k = kindOf(f.name);
  const v = latest(f);
  const st = STATUS[f.status] || STATUS.draft;
  const task = f.taskId ? taskById(f.taskId) : null;
  const localTrack = window.Tracking?.getByFile?.(f) || null;
  const verb = f.kind === 'input' ? '同步' : '追踪';
  const picked = state.picked.has(f.id);
  const inInput = state.pending.some(p => p.id === f.id);
  const trackLine = task
    ? `<span class="fl-track">${icon('refresh', 11)}${verb} · ${esc(task.scheduleShort)}</span>`
    : localTrack
      ? `<span class="fl-track">${icon('clock', 11)}${localTrack.enabled ? '跟踪中' : '已暂停'} · ${esc(localTrack.scheduleShort)}${localTrack.enabled ? ` · 下次 ${esc((localTrack.nextRunLabel || '—').replace(/（[^）]*）/g, ' ').replace(/\s+/g, ' ').trim())}` : ''}</span>`
      : '';
  return `<div class="file-card has-pick${f.flash ? ' is-flash' : ''}${picked ? ' is-picked' : ''}${inInput ? ' is-referenced' : ''}" data-card="${esc(f.id)}">
      <label class="pick" title="勾选后引用到输入框">
        <input type="checkbox" data-pick="${esc(f.id)}" aria-label="选择 ${esc(f.name)}，引用到输入框"${picked ? ' checked' : ''}>
        <span class="pick-box" aria-hidden="true">${icon('check', 10)}</span>
      </label>
      <button type="button" class="fc-open" data-file="${esc(f.id)}" aria-label="查看 ${esc(f.name)}">
        <span class="file-icon tint-${k.tint}">${icon(k.icon)}</span>
        <span class="fl-body">
          <span class="fl-top">
            <span class="fl-title">${esc(f.name)}</span>
            ${inInput ? `<span class="ref-badge">${icon('check', 10)}已引用</span>` : ''}
            <span class="ver">v${v.v}</span>
          </span>
          <span class="fl-meta">
            <span class="status-dot ${st.tone}"></span>${st.label}
            <span class="mid">·</span>${formatSize(v.size)}
            <span class="mid">·</span>${esc(f.day === '更早' ? f.time : shortTime(v.at))}
            <span class="badge ${f.kind}">${f.kind === 'input' ? '输入' : '产出'}</span>
          </span>
          ${asrFileLine(f)}
          ${trackLine}
        </span>
      </button>
    </div>`;
}

function syncPickbar(visible = visibleFiles()) {
  const valid = [...state.picked].filter(id => fileById(id));
  if (valid.length !== state.picked.size) state.picked = new Set(valid);
  const filesView = state.filter !== 'tasks' && state.filter !== 'tracking';
  const count = state.picked.size;
  const bar = $('#filePickbar');
  if (bar) bar.hidden = !filesView || count === 0;
  const pickCount = $('#pickCount');
  if (pickCount) pickCount.textContent = String(count);
  const all = visible.length > 0 && visible.every(f => state.picked.has(f.id));
  const pickAll = $('#pickAllBtn');
  if (pickAll) {
    pickAll.textContent = all ? '取消全选' : '全选';
    pickAll.disabled = visible.length === 0;
  }
}

function togglePickAll() {
  const visible = visibleFiles();
  const all = visible.length > 0 && visible.every(f => state.picked.has(f.id));
  visible.forEach(f => { if (all) state.picked.delete(f.id); else state.picked.add(f.id); });
  renderFiles(visible);
}

function clearPicks() {
  if (!state.picked.size) return;
  state.picked.clear();
  renderFiles(visibleFiles());
}

function togglePick(id, on) {
  if (on) state.picked.add(id);
  else state.picked.delete(id);
  const card = fileListEl.querySelector(`[data-card="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('is-picked', on);
  syncPickbar();
}

/* ---------- reference materials into the composer ---------- */

function pulseComposer() {
  const wrap = $('#dropZone');
  if (!wrap) return;
  wrap.classList.remove('is-receive');
  void wrap.offsetWidth;
  wrap.classList.add('is-receive');
  clearTimeout(pulseComposer.timer);
  pulseComposer.timer = setTimeout(() => wrap.classList.remove('is-receive'), 1400);
}

function referenceMaterials(materials, { closeDialog = false } = {}) {
  const list = materials.filter(Boolean);
  if (!list.length) return;
  const added = [];
  for (const f of list) {
    if (state.pending.some(p => p.id === f.id)) continue;
    state.pending.push(f);
    added.push(f);
  }
  state.picked.clear();
  renderAttachments();
  syncComposer();
  refreshFileCards();
  if (closeDialog) closeFile(false);
  if (added.length) {
    pulseComposer();
    toast(`已引用 ${added.length} 份资料到输入框`);
    if (isNarrow()) closeDrawers();
    else inputEl.focus();
  } else {
    toast('所选资料已在输入框中');
  }
}

function referencePicked() {
  referenceMaterials([...state.picked].map(fileById).filter(Boolean));
}

function renderTasks() {
  if (!state.tasks.length) {
    fileListEl.innerHTML = `<div class="rp-empty">没有计划</div>`;
    return;
  }
  fileListEl.innerHTML = state.tasks.map(t => {
    const badge = t.running
      ? `<span class="badge running">运行中</span>`
      : t.enabled ? `<span class="badge on">已启用</span>` : `<span class="badge off">已暂停</span>`;
    return `<button class="file-card task-card${t.running ? ' is-running' : ''}" data-task="${t.id}">
        <span class="file-icon">${icon('refresh')}</span>
        <span class="fl-body">
          <span class="fl-top"><span class="fl-title">${esc(t.name)}</span>${badge}</span>
          <span class="fl-meta">${esc(t.schedule)}<span class="mid">·</span>下次 ${esc(t.nextRun)}</span>
          <span class="fl-track">${icon('history', 11)}上次 ${esc(t.lastRun.at)} ${t.lastRun.ok ? '成功' : '失败'}${t.lastRun.version ? ` · v${t.lastRun.version}` : ''}</span>
        </span>
      </button>`;
  }).join('');
}

/* ---------- file dialog ---------- */

let lastFocus = null;

/* ---------- preview: shared helpers ---------- */


/* ---------- chat actions ---------- */

function setFilter(filter) {
  state.filter = filter;
  $$('#fileFilters .filter').forEach(b => {
    const on = b.dataset.filter === filter;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderPanel();
}

/* ---------- panel / menus ---------- */


function setFilesOpen(open) {
  state.filesOpen = open;
  const narrow = isNarrow();
  if (narrow) {
    win.classList.remove('files-collapsed');
    win.classList.toggle('files-open', open);
  } else {
    win.classList.remove('files-open');
    win.classList.toggle('files-collapsed', !open);
  }
  $('#filesToggle').setAttribute('aria-expanded', String(open));
}

function closeDrawers() {
  win.classList.remove('files-open', 'side-open');
  if (isNarrow()) state.filesOpen = false;
  $('#filesToggle').setAttribute('aria-expanded', 'false');
}

function notificationTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return hm;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

function renderNotifications() {
  const items = Array.isArray(state.notifications) ? state.notifications : [];
  const unread = items.filter(item => !item.readAt).length;
  const badge = $('#notifyBadge');
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = String(Math.min(99, unread));
  }
  const list = $('#notifyList');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<p class="notify-empty">暂无通知</p>';
    return;
  }
  list.innerHTML = items.slice(0, 12).map(item => `
    <button class="notify-entry${item.readAt ? '' : ' is-unread'}" data-notification="${esc(item.id)}" data-tracking="${esc(item.trackingId || '')}">
      <span class="notify-dot" style="${item.readAt ? 'visibility:hidden' : ''}"></span>
      <span class="notify-entry-main">
        <span class="notify-entry-title">${esc(item.title || '')}</span>
        <span class="notify-entry-body">${esc(item.body || '').slice(0, 140)}</span>
      </span>
      <span class="notify-entry-time">${esc(notificationTime(item.createdAt))}</span>
    </button>`).join('');
}

async function loadNotifications() {
  try {
    const items = await api('/api/notifications?limit=20');
    state.notifications = Array.isArray(items) ? items : [];
    renderNotifications();
  } catch {
    /* notifications are best-effort; the rest of the app keeps working */
  }
}

async function openNotification(id) {
  const item = (state.notifications || []).find(entry => entry.id === id);
  if (!item) return;
  if (!item.readAt) {
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
      item.readAt = new Date().toISOString();
      renderNotifications();
    } catch {
      /* ignore */
    }
  }
  toggleMenu($('#notifyMenu'), $('#notifyBtn'), false);
  if (item.trackingId && window.Tracking?.openDetail) {
    window.Tracking.openDetail(item.trackingId);
  }
}

async function loadFoundation() {
  try {
    const [materials, plans] = await Promise.all([api('/api/materials'), api('/api/plans')]);
    state.files = materials;
    state.tasks = plans;
    renderPanel();
    window.NextActions?.refresh?.();
  } catch (error) {
    toast(error.message || '加载资料失败');
  }
}

/* ---------- projects ---------- */

let projectLastFocus = null;

function upsertMaterial(material) {
  if (!material) return;
  const index = state.files.findIndex(item => item.id === material.id);
  const previous = index >= 0 ? state.files[index] : null;
  const changed = !previous || previous.versions[0]?.v !== material.versions[0]?.v;
  const next = { ...material, flash: changed };
  if (index >= 0) state.files[index] = next;
  else state.files.unshift(next);

  if (state.openFileId === material.id) {
    if (!material.versions.some(version => version.v === state.selectedVersion)) {
      state.selectedVersion = material.versions[0]?.v ?? null;
    }
    renderFileDialog();
  }
  renderPanel();
  window.NextActions?.refresh?.();
  if (material.relPath && /\.(md|markdown)$/i.test(material.relPath)) {
    const referenced = state.messages.some(message =>
      (message.tools || []).some(tool => tool.detail === material.relPath && (tool.name === 'write' || tool.name === 'edit')),
    );
    if (referenced) scheduleThread(false);
  }
}

function upsertPlan(plan) {
  if (!plan) return;
  const index = state.tasks.findIndex(item => item.id === plan.id);
  if (index >= 0) state.tasks[index] = plan;
  else state.tasks.push(plan);
  if (state.openTaskId === plan.id) renderTaskDialog();
  renderPanel();
}


export {
  visibleFiles, renderPanel, renderFiles, refreshFileCards, fileCard, syncPickbar,
  togglePickAll, clearPicks, togglePick, pulseComposer, referenceMaterials,
  referencePicked, renderTasks, setFilter, setFilesOpen, closeDrawers,
  notificationTime, renderNotifications, loadNotifications, openNotification,
  loadFoundation, upsertMaterial, upsertPlan,
};
