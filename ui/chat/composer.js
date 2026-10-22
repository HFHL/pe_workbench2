/** Composer, attachments and upload queue. */

import {
  $, esc, icon, attachmentsEl, inputEl, sendBtn, fileInput,
  AUDIO_PREVIEW, extOf, nextId, nowHM,
} from "../shared/dom.js";
import { state, selectors } from "../state/store.js";
import { api, uploadFile } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";
import {
  renderThread, scheduleThread,
} from "./renderer.js";

const fileById = (id) => selectors.fileById(id);
const latest = (file) => selectors.latest(file);
const refreshFileCards = () => runtime.refreshFileCards?.();
const upsertMaterial = (material) => runtime.upsertMaterial?.(material);
const syncStop = () => runtime.syncStop?.();
const createSession = () => runtime.createSession?.();

async function send() {
  if (state.uploading) return;
  const text = inputEl.value.trim();
  const attached = state.pending.slice();
  if (!text && !attached.length) return;
  if (state.agentTransport === 'copilotkit' && !runtime.pilot) {
    toast('CopilotKit 试点未就绪，请检查构建或关闭试点参数');
    return;
  }
  if (state.agentTransport === 'copilotkit' && state.streaming) {
    toast('当前回复尚未结束');
    return;
  }

  // 文件先留在输入框里，点发送时才真正上传。
  if (attached.some(item => item.staged)) {
    try {
      await uploadPending(attached);
    } catch {
      return; // 上传失败：保留输入内容和附件，方便直接重试
    }
  }

  if (!state.activeSession) {
    try {
      await createSession();
    } catch (error) {
      toast(error.message || '新建会话失败');
      return;
    }
  }
  const sessionId = state.activeSession;

  const paths = attached.map(f => f.uploadedPath || f.relPath).filter(Boolean);
  state.messages.push({ role: 'user', text: text || '看一下这几个文件。', time: nowHM() });
  state.pending = [];
  inputEl.value = '';
  autosize();
  syncComposer();
  renderAttachments();
  refreshFileCards();
  window.NextActions?.refresh?.();
  renderThread(true);

  // Transport is chosen per page. Only one client may send prompts and own
  // run state for this session.
  if (state.agentTransport !== 'legacy') {
    if (state.agentTransport !== 'copilotkit' || !runtime.pilot) {
      state.streaming = false;
      syncStop();
      renderThread(true);
      toast('CopilotKit 试点未就绪，请检查构建或关闭试点参数');
      return;
    }
    try {
      await runtime.pilot.send({ text: text || '看一下这几个文件。', attachments: paths });
    } catch (error) {
      state.streaming = false;
      syncStop();
      renderThread(true);
      toast(error.message || '发送失败');
    }
    return;
  }

  state.streaming = true;
  state.live = { text: '', tools: [], startedAt: Date.now() };
  runtime.resetLive?.();
  syncStop();
  renderThread(true);
  try {
    await api(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { text, attachments: paths },
    });
  } catch (error) {
    state.streaming = false;
    syncStop();
    renderThread(true);
    toast(error.message || '发送失败');
  }
}

async function uploadPending(attached) {
  const staged = attached.filter(item => item.staged && item.file);
  if (!staged.length) return attached;
  state.uploading = true;
  state.uploadTotal = staged.length;
  state.uploadIndex = 0;
  for (const item of staged) {
    item.status = 'queued';
    item.progress = 0;
    delete item.error;
  }
  syncComposer();
  renderAttachments();
  let audioCount = 0;
  let audioUnconfigured = false;
  const failed = [];
  try {
    for (const item of staged) {
      state.uploadIndex += 1;
      item.status = 'uploading';
      item.progress = 0;
      renderAttachments();
      let uploaded;
      try {
        uploaded = await uploadFile(item.file, fraction => {
          item.progress = Math.min(Math.max(fraction, 0), 1);
          updateChipProgress(item);
        });
      } catch (error) {
        item.status = 'error';
        item.progress = 0;
        item.error = error.message || '上传失败';
        failed.push(item);
        renderAttachments();
        continue;
      }
      const material = { ...uploaded.material, uploadedPath: uploaded.path, flash: true };
      try {
        upsertMaterial(material);
      } catch (error) {
        // 单个文件的界面刷新失败不应中断整批上传。
        console.error('[upload] material UI update failed', error);
      }
      if (AUDIO_PREVIEW.has(extOf(item.name))) {
        audioCount += 1;
        if (material.asr?.status === 'unconfigured' || material.asr?.configured === false) {
          audioUnconfigured = true;
        }
      }
      delete item.file;
      Object.assign(item, material, {
        uploadedPath: uploaded.path,
        staged: false,
        status: 'done',
        progress: 1,
      });
      delete item.error;
      renderAttachments();
    }
  } finally {
    state.uploading = false;
    state.uploadTotal = 0;
    state.uploadIndex = 0;
    syncComposer();
    renderAttachments();
  }
  if (failed.length) {
    toast(`${failed.length} 个文件上传失败，再次发送可重试`);
    const error = new Error('upload failed');
    error.failed = failed;
    throw error;
  }
  if (audioCount) {
    toast(audioUnconfigured
      ? '音频已上传；在 .env.local 配置 ASR_API_KEY 后即可转写'
      : `${audioCount} 个音频已上传，正在后台转写`);
  }
  return attached;
}

function updateChipProgress(item) {
  const chip = attachmentsEl.querySelector(`.chip[data-chip-id="${CSS.escape(item.id)}"]`);
  if (!chip) return;
  const pct = Math.round((item.progress || 0) * 100);
  const status = chip.querySelector('.chip-status');
  if (status && item.status === 'uploading') status.textContent = `${pct}%`;
  const bar = chip.querySelector('.chip-bar');
  if (bar) bar.style.width = `${pct}%`;
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

function renderAttachments() {
  const has = state.pending.length > 0;
  attachmentsEl.hidden = !has;
  if (!has) {
    attachmentsEl.innerHTML = '';
    syncReferenceButton();
    window.NextActions?.refresh?.();
    return;
  }
  const stagedCount = state.pending.filter(f => f.staged).length;
  const uploadedCount = state.pending.filter(f => f.uploadedPath && !f.staged).length;
  const label = state.uploading
    ? `上传队列 ${Math.max(state.uploadIndex, 1)}/${state.uploadTotal}`
    : stagedCount
      ? '附件（发送后上传）'
      : uploadedCount
        ? '附件（已上传）'
        : '引用资料';
  const labelIcon = stagedCount || uploadedCount ? 'paperclip' : 'link';
  attachmentsEl.innerHTML = `<span class="attachments-label">${icon(labelIcon, 12)}${label}</span>` + state.pending.map(f => {
    const pct = Math.round((f.progress || 0) * 100);
    let status = '';
    if (f.status === 'error') status = `<span class="chip-status is-error" title="${esc(f.error || '')}">失败</span>`;
    else if (f.status === 'queued') status = `<span class="chip-status is-queued">排队中</span>`;
    else if (f.status === 'uploading') status = `<span class="chip-status is-live">${pct}%</span>`;
    else if (f.staged) status = `<span class="chip-status">待发送</span>`;
    else if (f.uploadedPath) status = `<span class="chip-status is-done">已上传</span>`;
    return `
    <span class="chip${f.staged ? ' is-staged' : ''}${f.status === 'error' ? ' is-error' : ''}" data-chip-id="${esc(f.id)}">
      ${icon(kindOf(f.name).icon, 13)}
      <span class="chip-name">${esc(f.name)}</span>
      ${status}
      ${state.uploading ? '' : `<button type="button" class="chip-x" data-remove="${esc(f.id)}" aria-label="移除 ${esc(f.name)}">${icon('x', 13)}</button>`}
      <span class="chip-bar" style="width:${f.status === 'uploading' ? pct : 0}%"></span>
    </span>`;
  }).join('');
  syncReferenceButton();
  window.NextActions?.refresh?.();
}

function syncReferenceButton() {
  const btn = $('#referenceFile');
  if (!btn) return;
  const f = fileById(state.openFileId);
  const referenced = Boolean(f && state.pending.some(p => p.id === f.id));
  btn.disabled = referenced;
  btn.innerHTML = referenced
    ? `${icon('check', 13)}已在输入框`
    : `${icon('link', 13)}引用到输入框`;
}

function syncComposer() {
  const hasText = inputEl.value.trim().length > 0;
  const pilotBusy = state.agentTransport === 'copilotkit' && state.streaming;
  const pilotUnavailable = state.agentTransport === 'unavailable';
  sendBtn.disabled = state.uploading || pilotBusy || pilotUnavailable
    || (!hasText && state.pending.length === 0);
}

/* ---------- inputs: upload ---------- */

const TEXTUAL = new Set(['md', 'txt', 'csv', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'log', 'sh']);

function addFiles(fileList) {
  if (state.uploading) {
    toast('正在上传，请稍候再添加');
    return;
  }
  const added = [];
  for (const raw of Array.from(fileList)) {
    const name = raw.name || 'file';
    const limit = AUDIO_PREVIEW.has(extOf(name)) ? 120 * 1024 * 1024 : 30 * 1024 * 1024;
    if (raw.size > limit) {
      toast(`「${name}」超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
      continue;
    }
    const duplicate = state.pending.some(item => item.file
      && item.file.name === raw.name
      && item.file.size === raw.size
      && item.file.lastModified === raw.lastModified);
    if (duplicate) continue;
    const item = { id: nextId(), name, size: raw.size, file: raw, staged: true, status: 'staged' };
    state.pending.push(item);
    added.push(item);
  }
  if (!added.length) {
    if (state.pending.length) toast('这些文件已经在输入框中');
    return;
  }
  renderAttachments();
  syncComposer();
  toast(`已添加 ${added.length} 个文件，发送时上传`);
  inputEl.focus();
}

/* ---------- filters / panel ---------- */


export {
  send, uploadPending, updateChipProgress, autosize, renderAttachments,
  syncReferenceButton, syncComposer, addFiles,
};
