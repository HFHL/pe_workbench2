/* Workbench — project / session / chat / inputs / outputs / versions / plans.
   Native ES module. Domain modules live under ui/; this file is the entry and
   compatibility surface while the remaining controllers are extracted. */

import {
  approvalCardHTML,
  renderToolPresentation,
} from './tool-renderers/registry.js';
import { api, uploadFile, withProject } from './api/client.js';
import {
  approvalsShelfHTML, decideApproval, loadApprovals, upsertApproval,
} from './approvals/approvals.js';
import { toast } from './shared/toast.js';
import {
  openFile, closeFile, openTask, closeTask, renderFileDialog, renderTaskDialog, toggleTask, runTask,
  renderPreview, sanitizeMarkdown, loadMarked, selectVersion, restoreVersion,
  deleteOpenFile, downloadOpenFile, copyPath, onPreviewClick, onPreviewScroll,
  onPreviewPointerDown, onPreviewDoubleClick, onPreviewKeyDown, onPreviewWheel,
} from './previews/previews.js';
import { runtime } from './runtime.js';
import './dashboard/panel.js';
import { initTrace, resetTraceView, loadTrace } from './trace/panel.js';
import { initTraceHitl } from './trace/hitl.js';
import { closeStreams, openAgentStream, openGlobalStream } from './events/streams.js';
import {
  renderThread, scheduleThread, syncLiveTicker, resetLive, clearCaches, mdToHtml,
} from './chat/renderer.js';
import {
  renderAttachments, syncReferenceButton, syncComposer, autosize, addFiles, send,
} from './chat/composer.js';
import {
  renderPanel, refreshFileCards, upsertMaterial, upsertPlan, loadFoundation,
  setFilter, setFilesOpen, closeDrawers, renderNotifications, loadNotifications,
  openNotification, togglePickAll, clearPicks, referencePicked, referenceMaterials,
  togglePick,
} from './materials/materials.js';


import {
  $, $$, esc, icon, win, overlay, taskOverlay, projectOverlay, threadEl,
  fileListEl, attachmentsEl, inputEl, sendBtn, fileInput,
  KINDS, KIND_FALLBACK, kindOf, extOf, AUDIO_PREVIEW, RICH_PREVIEW, EXCEL_PREVIEW,
  MAX_XLSX_FREEZE_ROWS, MAX_XLSX_FREEZE_COLS, XLSX_ZOOM_STEPS,
  STATUS, SOURCE, nextId, nowHM, formatSize, shortTime, formatInt, isNarrow,
} from './shared/dom.js';
import {
  state, getState, update, subscribe, selectors, resetForProject,
} from './state/store.js';

const activeSession = () => selectors.activeSession();
const fileById = (id) => selectors.fileById(id);
const taskById = (id) => selectors.taskById(id);
const latest = (file) => selectors.latest(file);

function renderSessions() {
  const groups = ['今天', '本周', '更早'];
  let html = '';
  for (const group of groups) {
    const items = state.sessions.filter(s => s.group === group);
    if (!items.length) continue;
    html += `<div class="sess-group">${group}</div>`;
    html += items.map(s => `
      <button class="sess${s.id === state.activeSession ? ' is-active' : ''}" data-session="${s.id}">
        <span class="sess-title">${esc(s.title)}</span>
        <span class="sess-time">${esc(s.time)}</span>
      </button>`).join('');
  }
  $('#sessionList').innerHTML = html || `<div class="sess-empty">还没有会话</div>`;
}

function renderProjectMenu() {
  const list = $('#projectMenuList');
  if (!list) return;
  list.innerHTML = state.projects.length
    ? state.projects.map(p => `
      <button class="menu-item proj-item${p.id === state.project.id ? ' is-on' : ''}" data-project="${esc(p.id)}" data-accent="${esc(p.accent || 'slate')}" role="menuitem">
        <span class="proj-mark" aria-hidden="true">${esc((p.name || '项').trim().slice(0, 1))}</span>
        <span class="proj-text"><span class="proj-name">${esc(p.name)}</span><span class="proj-note">${esc(p.note || '项目')}</span></span>
        <span class="proj-check" aria-hidden="true">${icon('check', 12)}</span>
      </button>`).join('')
    : `<div class="sess-empty">还没有项目</div>`;
}

function renderAllChrome() {
  const title = activeSession()?.title || 'Workbench';
  $('#chatTitle').textContent = title;
  $('#docTitle').textContent = title;
  $('#docSpace').textContent = state.project.name;
  $('#wsName').textContent = state.project.name;
  $('#wsSub').textContent = state.project.note || '项目';
  document.title = `${title} · ${state.project.name} — Workbench`;
  renderProjectMenu();
}


function toggleMenu(menu, btn, force) {
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

/* ---------- dialogs: shared keys ---------- */

function activeDialog() {
  if (!projectOverlay.hidden) return $('#projectDialog');
  if (!taskOverlay.hidden) return $('#taskDialog');
  if (!overlay.hidden) return $('#dialog');
  return null;
}

function trapFocus(e) {
  const dialog = activeDialog();
  if (!dialog) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!projectOverlay.hidden) closeProjectDialog();
    else if (!taskOverlay.hidden) closeTask();
    else closeFile();
    return;
  }
  if (e.key !== 'Tab') return;
  const nodes = $$('button, [href], input, [tabindex]:not([tabindex="-1"])', dialog).filter(n => !n.disabled);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (active === dialog) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}


/* ---------- real backend ---------- */

function decorateSession(item) {
  const updated = new Date(item.updatedAt || Date.now());
  const now = new Date();
  const sameDay = updated.toDateString() === now.toDateString();
  const diffDays = (now - updated) / 86400000;
  const group = sameDay ? '今天' : diffDays < 7 ? '本周' : '更早';
  const time = sameDay
    ? `${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`
    : diffDays < 7
      ? `周${'日一二三四五六'[updated.getDay()]}`
      : `${updated.getMonth() + 1}/${updated.getDate()}`;
  return { ...item, group, time };
}

/* Focus to restore when the project dialog closes. Declared here (not in
   materials.js) because open/closeProjectDialog own the focus lifecycle. */
let projectLastFocus = null;

async function loadProjects() {
  const items = await api('/api/projects');
  state.projects = Array.isArray(items) ? items : [];
  const requested = new URLSearchParams(location.search).get('project');
  const stored = requested || localStorage.getItem('workbench.project');
  let id = state.project.id;
  if (stored && state.projects.some(p => p.id === stored)) id = stored;
  if (!state.projects.some(p => p.id === id)) id = state.projects[0]?.id || id;
  const match = state.projects.find(p => p.id === id);
  if (match) state.project = match;
  renderProjectMenu();
}

function openProjectDialog() {
  toggleMenu($('#wsMenu'), $('#workspaceBtn'), false);
  projectLastFocus = document.activeElement;
  $('#projectName').value = '';
  $('#projectNote').value = '';
  $('#projectError').textContent = '';
  projectOverlay.hidden = false;
  $('#projectDialog').focus();
  requestAnimationFrame(() => $('#projectName').focus());
}

function closeProjectDialog(restoreFocus = true) {
  if (projectOverlay.hidden) return;
  projectOverlay.hidden = true;
  if (restoreFocus && projectLastFocus) {
    projectLastFocus.focus();
    projectLastFocus = null;
  }
}

async function submitProjectDialog(event) {
  event.preventDefault();
  const name = $('#projectName').value.trim();
  const note = $('#projectNote').value.trim();
  const errorEl = $('#projectError');
  if (!name) {
    errorEl.textContent = '请填写项目名称';
    $('#projectName').focus();
    return;
  }
  const button = $('#projectCreate');
  button.disabled = true;
  button.textContent = '创建中…';
  try {
    const created = await api('/api/projects', { method: 'POST', body: { name, note } });
    state.projects.push(created);
    closeProjectDialog(false);
    await switchProject(created.id);
    toast(`已创建项目「${created.name}」`);
  } catch (error) {
    errorEl.textContent = error.message || '创建项目失败';
  } finally {
    button.disabled = false;
    button.textContent = '创建项目';
  }
}

async function switchProject(id) {
  const project = state.projects.find(item => item.id === id);
  if (!project) return;
  toggleMenu($('#wsMenu'), $('#workspaceBtn'), false);
  if (project.id === state.project.id) {
    renderAllChrome();
    return;
  }
  // Everything below belongs to the previous project: close its UI and
  // transports, then clear project-scoped state through one action.
  closeFile(false);
  closeTask(false);
  runtime.clearCaches?.();
  runtime.pilot?.resetForProject?.();
  window.Tracking?.reset?.();
  closeStreams();
  resetForProject(project);
  localStorage.setItem('workbench.project', project.id);
  renderNotifications();
  $$('#fileFilters .filter').forEach(btn => {
    const on = btn.dataset.filter === 'all';
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });

  renderAllChrome();
  renderSessions();
  renderThread();
  renderPanel();
  renderAttachments();
  syncComposer();
  syncStop();
  connectGlobalEvents();
  void loadNotifications();
  void loadApprovals();

  try {
    await loadSessions();
    await loadFoundation();
    await window.Tracking?.reload?.();
    resetTraceView();
    void loadTrace();
    renderPanel();
  } catch (error) {
    toast(error.message || '加载项目失败');
  }
  window.NextActions?.refresh?.();
}

function handleGlobalEvent(payload) {
  if (payload.type === 'material.updated') upsertMaterial(payload.material);
  if (payload.type === 'material.deleted') {
    state.files = state.files.filter(item => item.id !== payload.id);
    if (state.openFileId === payload.id) closeFile(false);
    renderPanel();
  }
  if (payload.type === 'plan.updated') upsertPlan(payload.plan);
  if (payload.type === 'trace.updated') void loadTrace();
  if (payload.type === 'tracking.updated') window.Tracking?.upsert?.(payload.tracking);
  if (payload.type === 'tracking.deleted') window.Tracking?.remove?.(payload.id);
  if (payload.type === 'notification.created') {
    void loadNotifications();
    Promise.resolve(window.Tracking?.reload?.()).catch(() => {});
  }
  if (payload.type === 'monitor.updated') {
    Promise.resolve(window.Tracking?.reload?.()).catch(() => {});
  }
  if (payload.type === 'approval.created' || payload.type === 'approval.updated') {
    if (payload.approval) {
      upsertApproval(payload.approval);
      renderThread(false);
    }
    if (payload.tracking) window.Tracking?.upsert?.(payload.tracking);
  }
}

function connectGlobalEvents() {
  openGlobalStream(handleGlobalEvent);
}

async function installPilotIfRequested(health) {
  const requestedByUrl = new URLSearchParams(location.search).get('agentTransport') === 'copilotkit';
  const requestedByEnv = health?.features?.copilotkit === true;
  if (!requestedByUrl && !requestedByEnv) return;
  state.agentTransport = 'copilotkit';
  try {
    const pilot = await import('./copilot-pilot/pilot.bundle.js');
    pilot.install();
  } catch (error) {
    // Fail closed: never silently fall back to the legacy stream after the
    // user selected the pilot for this session.
    state.agentTransport = 'unavailable';
    console.error('[copilot-pilot] bundle failed to load', error);
    toast('CopilotKit 试点 bundle 未构建：请运行 npm run build:copilot-pilot');
  }
}

async function boot() {
  try {
    const health = await api('/api/health');
    if (health.model) {
      state.modelId = health.model;
      $('#modelName').textContent = health.model;
    }
    await installPilotIfRequested(health);
  } catch {
    toast('本地服务未连接');
    return;
  }
  try {
    await loadProjects();
  } catch (error) {
    toast(error.message || '加载项目失败');
  }
  connectGlobalEvents();
  void loadNotifications();
  void loadApprovals();
  try {
    await loadSessions();
  } catch (error) {
    toast(error.message || '加载会话失败');
  }
  await loadFoundation();
  await initTrace();
  initTraceHitl();
}

async function loadSessions() {
  const items = await api('/api/sessions');
  state.sessions = items.map(decorateSession);
  if (!state.sessions.length) {
    await createSession();
    return;
  }
  if (!state.sessions.some(s => s.id === state.activeSession)) state.activeSession = state.sessions[0].id;
  renderSessions();
  renderAllChrome();
  renderThread();
  connectSession(state.activeSession);
}

async function createSession() {
  const created = await api('/api/sessions', { method: 'POST' });
  const item = decorateSession({ ...created, updatedAt: created.updatedAt || new Date().toISOString() });
  state.sessions.unshift(item);
  state.activeSession = item.id;
  state.messages = [];
  state.streaming = false;
  state.live = { text: '', tools: [], startedAt: 0 };
  syncStop();
  renderSessions();
  renderAllChrome();
  renderThread();
  connectSession(item.id);
  window.NextActions?.refresh?.();
  inputEl.focus();
  win.classList.remove('side-open');
  return item;
}

function openSession(id) {
  state.activeSession = id;
  state.messages = [];
  state.streaming = false;
  state.live = { text: '', tools: [], startedAt: 0 };
  syncStop();
  renderAllChrome();
  renderSessions();
  renderThread();
  connectSession(id);
  window.NextActions?.refresh?.();
  win.classList.remove('side-open');
}

function connectSession(id) {
  if (state.agentTransport !== 'legacy') {
    if (state.agentTransport === 'copilotkit' && runtime.pilot) {
      void runtime.pilot.connect(id).catch((error) => {
        toast(error.message || 'CopilotKit 连接失败');
      });
    }
    return;
  }
  openAgentStream(id, handleServerEvent);
}

function updateSessionItem(id, patch) {
  const index = state.sessions.findIndex(item => item.id === id);
  if (index < 0) return;
  Object.assign(state.sessions[index], patch);
  state.sessions[index] = decorateSession(state.sessions[index]);
}

let snapshotPollTimer = null;

function scheduleSnapshotPoll(delay = 500) {
  clearTimeout(snapshotPollTimer);
  snapshotPollTimer = setTimeout(async () => {
    snapshotPollTimer = null;
    await refreshSnapshot();
    if (state.streaming) scheduleSnapshotPoll(700);
  }, delay);
}

function handleServerEvent(ev) {
  switch (ev.type) {
    case 'snapshot':
      state.messages = ev.messages || [];
      if (Array.isArray(ev.approvals) && ev.approvals.length) {
        for (const approval of ev.approvals) {
          if (!state.approvals.some((item) => item.id === approval.id)) state.approvals.push(approval);
        }
      }
      state.streaming = !!ev.streaming;
      state.live = { text: '', tools: [], startedAt: ev.streaming ? Date.now() : 0 };
      // A reconnecting SSE may receive a snapshot from just before the final
      // message append. One deferred re-read makes recovery deterministic.
      scheduleSnapshotPoll(800);
      updateSessionItem(ev.sessionId, {
        title: ev.title,
        updatedAt: new Date().toISOString(),
      });
      if (ev.model) {
        state.modelId = ev.model;
        $('#modelName').textContent = ev.model;
      }
      syncStop();
      renderSessions();
      renderAllChrome();
      runtime.resetLive?.();
      renderThread(true);
      window.NextActions?.refresh?.();
      break;
    case 'run.started':
      if (!state.streaming) state.live = { text: '', tools: [], startedAt: Date.now() };
      state.streaming = true;
      syncStop();
      window.NextActions?.refresh?.();
      renderThread(true);
      break;
    case 'assistant.delta':
      state.live.text += ev.delta || '';
      scheduleThread();
      break;
    case 'tool.started':
      state.live.tools.push({ id: ev.id, name: ev.name, detail: ev.detail, status: 'running', output: '' });
      scheduleThread();
      break;
    case 'tool.completed': {
      const tool = state.live.tools.find(item => item.id === ev.id);
      if (tool) {
        tool.status = ev.status;
        tool.detail = ev.detail || tool.detail;
        tool.output = ev.output || '';
        if (ev.presentation) tool.presentation = ev.presentation;
        if (ev.presentationError) tool.presentationError = ev.presentationError;
      } else {
        state.live.tools.push({
          id: ev.id, name: ev.name, detail: ev.detail, status: ev.status, output: ev.output || '',
          ...(ev.presentation ? { presentation: ev.presentation } : {}),
          ...(ev.presentationError ? { presentationError: ev.presentationError } : {}),
        });
      }
      scheduleThread();
      break;
    }
    case 'approval.created':
    case 'approval.updated': {
      if (!ev.approval) break;
      upsertApproval(ev.approval);
      renderThread(false);
      break;
    }
    case 'run.settled':
      state.streaming = false;
      syncStop();
      window.NextActions?.refresh?.();
      // 保留当前实时内容，等 snapshot 一次性替换为最终消息，避免结束瞬间闪一下。
      void refreshSnapshot();
      break;
    case 'session.updated':
      updateSessionItem(ev.id, {
        title: ev.title,
        updatedAt: ev.updatedAt || new Date().toISOString(),
      });
      renderSessions();
      renderAllChrome();
      break;
    case 'material.updated':
      upsertMaterial(ev.material);
      break;
    case 'run.error':
      state.streaming = false;
      syncStop();
      scheduleThread();
      toast(ev.message || '运行失败');
      break;
  }
}

async function refreshSnapshot({
  watch = true,
  forceStopped = false,
  preserveLive = Boolean(state.streaming),
  guard = null,
  throwOnError = false,
} = {}) {
  const id = state.activeSession;
  if (!id) return null;
  try {
    const snap = await api(`/api/sessions/${id}/state`);
    if (state.activeSession !== id) return null;
    if (guard && !guard()) return null;
    state.messages = snap.messages || [];
    if (Array.isArray(snap.approvals)) {
      const ids = new Set(snap.approvals.map((item) => item.id));
      state.approvals = [...snap.approvals, ...state.approvals.filter((item) => !ids.has(item.id))];
    }
    state.streaming = forceStopped ? false : !!snap.streaming;
    if (!preserveLive) {
      state.live = {
        text: '',
        tools: [],
        startedAt: snap.streaming && !forceStopped ? Date.now() : 0,
      };
    }
    if (!forceStopped && snap.streaming && watch) scheduleSnapshotPoll(700);
    else if (!snap.streaming || !watch || forceStopped) {
      clearTimeout(snapshotPollTimer);
      snapshotPollTimer = null;
    }
    updateSessionItem(id, { title: snap.title });
    syncStop();
    renderSessions();
    renderAllChrome();
    runtime.resetLive?.();
    renderThread(true);
    return snap;
  } catch (error) {
    runtime.resetLive?.();
    scheduleThread();
    if (throwOnError) throw error;
    return null;
  }
}

function syncStop() {
  $('#stopBtn').hidden = !state.streaming;
  runtime.syncLiveTicker?.();
}

/* ---------- wiring ---------- */

async function init() {
  renderAllChrome();
  renderSessions();
  renderThread();
  renderPanel();
  renderAttachments();
  syncComposer();
  setFilesOpen(!isNarrow());
  loadMarked().then(() => renderThread()).catch(() => {});

  $('#sessionList').addEventListener('click', e => {
    const btn = e.target.closest('[data-session]');
    if (!btn) return;
    openSession(btn.dataset.session);
  });

  $('#newSession').addEventListener('click', () => {
    void createSession().catch(error => toast(error.message || '新建会话失败'));
  });

  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    send();
  });
  inputEl.addEventListener('input', () => { autosize(); syncComposer(); });
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#stopBtn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    if (state.agentTransport === 'copilotkit' && runtime.pilot) {
      try {
        await runtime.pilot.stop();
      } catch { /* the snapshot reconciles the UI */ }
      return;
    }
    try {
      await api(`/api/sessions/${state.activeSession}/abort`, { method: 'POST' });
    } catch { /* ignore */ }
  });

  fileListEl.addEventListener('click', e => {
    const file = e.target.closest('[data-file]');
    if (file) { openFile(file.dataset.file); return; }
    const task = e.target.closest('[data-task]');
    if (task) openTask(task.dataset.task);
  });
  fileListEl.addEventListener('change', e => {
    const box = e.target.closest('[data-pick]');
    if (box) togglePick(box.dataset.pick, box.checked);
  });
  $('#pickAllBtn').addEventListener('click', togglePickAll);
  $('#pickClear').addEventListener('click', clearPicks);
  $('#pickReference').addEventListener('click', referencePicked);
  $('#referenceFile').addEventListener('click', () => {
    const f = fileById(state.openFileId);
    if (f) referenceMaterials([f], { closeDialog: true });
  });
  threadEl.addEventListener('click', e => {
    const approvalAction = e.target.closest('[data-approval-action]');
    if (approvalAction) {
      const id = approvalAction.dataset.approvalId;
      const reason = document.querySelector(`[data-approval-reason="${CSS.escape(id)}"]`)?.value || '';
      void decideApproval(id, approvalAction.dataset.approvalAction, reason);
      return;
    }
    const link = e.target.closest('[data-file]');
    if (link) openFile(link.dataset.file);
  });
  $('#fileFilters').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (btn) setFilter(btn.dataset.filter);
  });
  $('#filesToggle').addEventListener('click', () => setFilesOpen(!state.filesOpen));
  $('#filesClose').addEventListener('click', () => {
    if (isNarrow()) closeDrawers();
    else setFilesOpen(false);
  });
  $('#sideToggle').addEventListener('click', () => {
    win.classList.toggle('side-open');
  });
  $('#drawerScrim').addEventListener('click', closeDrawers);

  // file dialog
  $('#dClose').addEventListener('click', () => closeFile());
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFile(); });
  $('#dVersions').addEventListener('click', e => {
    const row = e.target.closest('[data-ver]');
    if (row) selectVersion(Number(row.dataset.ver));
  });
  $('#dLineage').addEventListener('click', e => {
    const chip = e.target.closest('[data-file]');
    if (chip) openFile(chip.dataset.file);
  });
  $('#dTrack').addEventListener('click', () => {
    const taskId = $('#dTrack').dataset.task;
    if (taskId) { openTask(taskId); return; }
    const trackId = $('#dTrack').dataset.track;
    if (trackId && window.Tracking) { window.Tracking.openDetail(trackId); return; }
    if (window.Tracking && state.openFileId) window.Tracking.openSetup(state.openFileId);
  });
  $('#restoreVersion').addEventListener('click', restoreVersion);
  $('#deleteFile').addEventListener('click', deleteOpenFile);
  $('#downloadFile').addEventListener('click', downloadOpenFile);
  $('#copyPath').addEventListener('click', copyPath);

  const previewEl = $('#dPreview');
  previewEl.addEventListener('click', onPreviewClick);
  previewEl.addEventListener('scroll', onPreviewScroll, true);
  previewEl.addEventListener('pointerdown', onPreviewPointerDown);
  previewEl.addEventListener('dblclick', onPreviewDoubleClick);
  previewEl.addEventListener('keydown', onPreviewKeyDown);
  previewEl.addEventListener('wheel', onPreviewWheel, { passive: false });

  // task dialog
  $('#tClose').addEventListener('click', () => closeTask());
  taskOverlay.addEventListener('click', e => { if (e.target === taskOverlay) closeTask(); });
  $('#taskToggle').addEventListener('click', toggleTask);
  $('#taskRun').addEventListener('click', runTask);
  $('#tLinks').addEventListener('click', e => {
    const chip = e.target.closest('[data-file]');
    if (chip) openFile(chip.dataset.file);
  });

  // upload
  $('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });
  attachmentsEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn || state.uploading) return;
    const id = btn.dataset.remove;
    state.pending = state.pending.filter(f => f.id !== id);
    renderAttachments();
    syncComposer();
    refreshFileCards();
  });

  const dropZone = $('#dropZone');
  let dragDepth = 0;
  ['dragenter', 'dragover'].forEach(type => {
    dropZone.addEventListener(type, e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      if (type === 'dragenter') dragDepth++;
      dropZone.classList.add('is-drag');
    });
  });
  dropZone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('is-drag');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('is-drag');
    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // project switcher
  $('#workspaceBtn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu($('#wsMenu'), $('#workspaceBtn'));
  });
  $('#wsMenu').addEventListener('click', e => {
    const item = e.target.closest('[data-project]');
    if (!item) return;
    void switchProject(item.dataset.project).catch(error => toast(error.message || '切换项目失败'));
  });
  $('#newProjectBtn').addEventListener('click', () => openProjectDialog());
  $('#projectClose').addEventListener('click', () => closeProjectDialog());
  $('#projectCancel').addEventListener('click', () => closeProjectDialog());
  projectOverlay.addEventListener('click', e => { if (e.target === projectOverlay) closeProjectDialog(); });
  $('#projectDialog').addEventListener('submit', submitProjectDialog);
  $('#notifyBtn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu($('#notifyMenu'), $('#notifyBtn'));
    if (!$('#notifyMenu').hidden) void loadNotifications();
  });
  $('#notifyList').addEventListener('click', e => {
    const item = e.target.closest('[data-notification]');
    if (item) void openNotification(item.dataset.notification);
  });
  $('#modelBtn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu($('#modelMenu'), $('#modelBtn'));
  });
  $('#modelMenu').addEventListener('click', async e => {
    const item = e.target.closest('[data-model]');
    if (!item) return;
    const requested = item.dataset.model;
    if (state.activeSession) {
      try {
        await api(`/api/sessions/${state.activeSession}/model`, { method: 'POST', body: { model: requested } });
      } catch (error) {
        toast(error.message || '切换模型失败');
        return;
      }
    }
    state.modelId = requested;
    $('#modelName').textContent = requested;
    $$('#modelMenu .menu-item').forEach(b => b.classList.toggle('is-on', b === item));
    toggleMenu($('#modelMenu'), $('#modelBtn'), false);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.ws-wrap')) toggleMenu($('#wsMenu'), $('#workspaceBtn'), false);
    if (!e.target.closest('.pop-wrap')) {
      toggleMenu($('#modelMenu'), $('#modelBtn'), false);
      toggleMenu($('#notifyMenu'), $('#notifyBtn'), false);
    }
  });
  document.addEventListener('keydown', e => {
    if (!projectOverlay.hidden || !taskOverlay.hidden || !overlay.hidden) { trapFocus(e); return; }
    if (e.key === 'Escape') {
      toggleMenu($('#wsMenu'), $('#workspaceBtn'), false);
      toggleMenu($('#modelMenu'), $('#modelBtn'), false);
      toggleMenu($('#notifyMenu'), $('#notifyBtn'), false);
      closeDrawers();
    }
  });

  window.addEventListener('resize', () => {
    if (isNarrow()) {
      win.classList.remove('files-collapsed');
      win.classList.toggle('files-open', state.filesOpen);
    } else {
      win.classList.remove('files-open');
      win.classList.toggle('files-collapsed', !state.filesOpen);
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      inputEl.focus();
    }
  });

  await boot();
  try {
    await window.Tracking?.init?.();
  } catch {
    /* the tracking panel reports its own error */
  }
  window.NextActions?.init?.();

  // deep links: #file=<id>, #task=<id>
  const heavy = location.hash.match(/^#(file|task)=(.+)$/);
  if (heavy) {
    const id = decodeURIComponent(heavy[2]);
    if (heavy[1] === 'file' && fileById(id)) openFile(id);
    if (heavy[1] === 'task' && taskById(id)) openTask(id);
  }
}

Object.assign(runtime, {
  renderThread,
  scheduleThread,
  toast,
  loadApprovals,
  upsertMaterial,
  upsertPlan,
  refreshSnapshot,
  renderPanel,
  openFile,
  closeFile,
  openTask,
  closeTask,
  renderTaskDialog,
  renderFileDialog,
  toggleMenu,
  renderAttachments,
  syncReferenceButton,
  mdToHtml,
  loadFoundation,
  syncLiveTicker,
  syncStop,
  resetLive,
  clearCaches,
  createSession,
  connectSession,
});

// Classic companion scripts (tracking.js, suggestions.js) run before this
// module and read the shared workbench state during init. Expose a narrow
// compatibility surface here; new UI modules import the store instead.
Object.assign(window, {
  state,
  withProject,
  toast,
  autosize,
  syncComposer,
  renderPanel,
  openFile,
  closeFile,
  closeTask,
  syncReferenceButton,
  latest,
});
window.__peRenderPanel = renderPanel;
window.__peConnectSession = connectSession;

export { init };

export async function startWorkbench() {
  try {
    await init();
  } catch (error) {
    console.error(error);
    toast('初始化失败，请检查本地服务');
  }
}
