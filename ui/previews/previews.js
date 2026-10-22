/**
 * File, Markdown, PDF, Excel and audio previews.
 *
 * Pure rendering/interaction for the right-hand file dialog. Domain actions it
 * needs from other modules (panel refresh, material upsert) are late-bound via
 * the UI runtime to keep the module graph acyclic.
 */

import {
  $, $$, esc, icon, overlay, fileInput,
  AUDIO_PREVIEW, RICH_PREVIEW, EXCEL_PREVIEW, STATUS, SOURCE,
  MAX_XLSX_FREEZE_ROWS, MAX_XLSX_FREEZE_COLS, XLSX_ZOOM_STEPS,
  kindOf, extOf, formatSize, shortTime, formatInt,
} from "../shared/dom.js";
import { state, selectors } from "../state/store.js";
import { api, withProject } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";

const activeSession = () => selectors.activeSession();
const fileById = (id) => selectors.fileById(id);
const taskById = (id) => selectors.taskById(id);
const latest = (file) => selectors.latest(file);
const renderPanel = () => runtime.renderPanel?.();
const renderThread = (...args) => runtime.renderThread?.(...args);
const scheduleThread = (...args) => runtime.scheduleThread?.(...args);
const upsertMaterial = (material) => runtime.upsertMaterial?.(material);

const previewState = {
  token: 0,
  key: null,
  kind: null,
  md: null,
  xlsx: null,
  pdf: null,
  audio: null,
  scrollFrame: 0,
};

function versionFileUrl(f, v, download = false) {
  return withProject(`/api/materials/${encodeURIComponent(f.id)}/versions/${v.v}/file${download ? '?download=1' : ''}`);
}

function versionWorkbookUrl(f, v, sheetName = null) {
  const base = `/api/materials/${encodeURIComponent(f.id)}/versions/${v.v}/workbook`;
  return withProject(sheetName ? `${base}/sheets/${encodeURIComponent(sheetName)}` : base);
}

function versionPdfUrl(f, v, { page = '', query = '' } = {}) {
  const params = new URLSearchParams();
  if (page) params.set('page', page);
  if (query) params.set('query', query);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return withProject(`/api/materials/${encodeURIComponent(f.id)}/versions/${v.v}/pdf${suffix}`);
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || '加载失败');
  return data;
}

function previewLoading(label) {
  return `<div class="pv"><div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>${esc(label)}</span></div></div>`;
}

function previewFailure(error, hint = '') {
  return `<div class="pv"><div class="prev-state is-error">
      ${icon('x', 18)}
      <strong>预览加载失败</strong>
      <span>${esc(error && error.message ? error.message : String(error || '未知错误'))}</span>
      ${hint ? `<span class="prev-hint">${esc(hint)}</span>` : ''}
      <span class="prev-actions">
        <button class="btn small" data-preview-retry>重试</button>
        <button class="btn small" data-preview-download>下载原文件</button>
      </span>
    </div></div>`;
}

function previewHTML(f, v) {
  if (v.preview.type === 'text') return `<pre class="prev-text">${esc(v.preview.text)}</pre>`;
  if (v.preview.type === 'image') {
    return `<img class="prev-image" src="${esc(versionFileUrl(f, v))}" alt="${esc(f.name)}">`;
  }
  return `<div class="prev-none">${icon('file-text', 20)}<span>此类型暂不支持预览</span><button class="btn small" data-preview-download>下载原文件</button></div>`;
}

function resetPreview() {
  previewState.token += 1;
  previewState.key = null;
  previewState.kind = null;
  previewState.md = null;
  previewState.xlsx = null;
  previewState.pdf = null;
  stopAudioPreview();
  if (previewState.scrollFrame) {
    cancelAnimationFrame(previewState.scrollFrame);
    previewState.scrollFrame = 0;
  }
  const box = $('#dPreview');
  if (box) box.innerHTML = '';
  const dialog = $('#dialog');
  if (dialog) dialog.classList.remove('is-rich', 'is-expanded');
}

async function renderPreview(f, v) {
  const ext = extOf(f.name);
  const key = `${f.id}:${v.v}`;
  const box = $('#dPreview');

  // ASR status arrives through SSE while the dialog is open. Do not rebuild the
  // audio element (that would interrupt playback); just refresh the text pane.
  if (previewState.key === key && previewState.kind === 'audio' && AUDIO_PREVIEW.has(ext)) {
    syncAudioAsr(f, v);
    return;
  }

  const token = ++previewState.token;
  if (previewState.scrollFrame) {
    cancelAnimationFrame(previewState.scrollFrame);
    previewState.scrollFrame = 0;
  }
  previewState.md = null;
  previewState.xlsx = null;
  previewState.pdf = null;
  stopAudioPreview();
  previewState.key = key;
  previewState.kind = AUDIO_PREVIEW.has(ext) ? 'audio' : 'other';
  box.className = 'd-preview';

  try {
    if (ext === 'md' || ext === 'markdown') return await mountMarkdown(f, v, token);
    if (EXCEL_PREVIEW.has(ext)) return await mountExcel(f, v, token);
    if (ext === 'pdf') return await mountPdf(f, v, token);
    if (AUDIO_PREVIEW.has(ext)) return await mountAudio(f, v, token);
    box.innerHTML = previewHTML(f, v);
  } catch (error) {
    if (token === previewState.token) box.innerHTML = previewFailure(error);
  }
}

/* ---------- preview: pdf ---------- */

async function mountPdf(f, v, token) {
  const box = $('#dPreview');
  box.innerHTML = `<div class="pv pv-pdf">
      <div class="pv-bar">
        <div class="pv-seg" role="group" aria-label="查看方式">
          <button type="button" data-pdf-view="original" class="is-on">原文</button>
          <button type="button" data-pdf-view="text">文本</button>
        </div>
        <span class="pv-divider" aria-hidden="true"></span>
        <span class="pv-kind">${icon('file-text', 13)} PDF</span>
        <span class="pv-stat">${esc(f.name)}</span>
        <span class="pv-spacer"></span>
        <a class="pv-btn" href="${esc(versionFileUrl(f, v))}" target="_blank" rel="noreferrer">${icon('external', 13)} 新标签打开</a>
        <button class="pv-btn" data-preview-expand title="放大预览">${icon('maximize', 13)}</button>
      </div>
      <div class="pdf-stage">
        <iframe id="pdfFrame" class="pdf-frame" src="${esc(versionFileUrl(f, v))}#toolbar=1&navpanes=0&view=FitH" title="${esc(f.name)}"></iframe>
        <div id="pdfText" class="pdf-text" hidden></div>
      </div>
    </div>`;
  previewState.pdf = {
    f,
    v,
    token,
    summary: null,
    page: 0,
    cache: new Map(),
    view: 'original',
    query: '',
  };
}

async function switchPdfView(view) {
  const p = previewState.pdf;
  if (!p) return;
  p.view = view;
  $$('#dPreview [data-pdf-view]').forEach(button => {
    button.classList.toggle('is-on', button.dataset.pdfView === view);
  });
  const frame = $('#pdfFrame');
  const text = $('#pdfText');
  if (frame) frame.hidden = view !== 'original';
  if (text) text.hidden = view !== 'text';
  if (view === 'text') await ensurePdfText();
}

async function ensurePdfText() {
  const p = previewState.pdf;
  if (!p) return;
  const token = p.token;
  const pane = $('#pdfText');
  if (!pane) return;
  if (p.summary) return;
  pane.innerHTML = `<div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>正在提取 PDF 文本…首次打开约需 1 秒</span></div>`;
  try {
    p.summary = await fetchJson(versionPdfUrl(p.f, p.v));
  } catch (error) {
    if (token === previewState.token) {
      pane.innerHTML = `<div class="prev-state is-error">
          ${icon('x', 18)}<strong>文本提取失败</strong><span>${esc(error.message)}</span>
          <span class="prev-hint">需要 Python 3 + pdfplumber；扫描版 PDF 只能看到图片。</span>
          <span class="prev-actions"><button class="btn small" data-preview-retry>重试</button><button class="btn small" data-preview-download>下载原文件</button></span>
        </div>`;
    }
    return;
  }
  if (token !== previewState.token) return;
  renderPdfTextShell();
  const first = (p.summary.pageStats || []).find(item => !item.scanned) || (p.summary.pageStats || [])[0];
  const kept = (p.summary.pageStats || []).find(item => item.page === p.page);
  if (kept || first) await loadPdfPage((kept || first).page);
}

function renderPdfTextShell() {
  const p = previewState.pdf;
  const pane = $('#pdfText');
  if (!p || !pane || !p.summary) return;
  const summary = p.summary;
  const pages = summary.pageStats || [];
  const nav = pages.map(item => `<button type="button" class="pdf-page-btn${item.scanned ? ' is-scan' : ''}${item.page === p.page ? ' is-on' : ''}"
      data-pdf-page="${item.page}" title="p.${item.page}${item.scanned ? ' · 无文字页' : ` · ${formatInt(item.chars)} 字`}">${item.page}</button>`).join('');
  const scanned = (summary.scannedPages || []).length;
  pane.innerHTML = `<div class="pdf-text-bar">
      <label class="pdf-search-box">${icon('search', 13)}
        <input id="pdfSearch" type="search" placeholder="在 PDF 中检索，回车" autocomplete="off" spellcheck="false" value="${esc(p.query)}">
      </label>
      <button type="button" class="pv-btn" data-pdf-search>检索</button>
      <span class="pdf-text-meta">${summary.pages} 页 · ${formatInt(summary.chars)} 字${scanned ? ` · ${scanned} 页无文字` : ''}</span>
      <span class="pv-spacer"></span>
      <span class="pdf-text-hint" title="文本由服务端 pdfplumber 提取，与 Agent 读取内容一致">${icon('info', 12)} 解析文本</span>
    </div>
    <div class="pdf-text-body">
      <aside class="pdf-pages" aria-label="页码">${nav}</aside>
      <div class="pdf-page-pane" id="pdfPagePane"><div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>正在加载…</span></div></div>
    </div>`;
}

async function loadPdfPage(number, { query = '' } = {}) {
  const p = previewState.pdf;
  if (!p) return;
  const token = p.token;
  const pane = $('#pdfPagePane');
  if (!pane) return;
  p.page = Number(number);
  $$('#pdfText [data-pdf-page]').forEach(button => {
    button.classList.toggle('is-on', Number(button.dataset.pdfPage) === p.page);
  });
  pane.innerHTML = `<div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>正在加载 p.${p.page}…</span></div>`;
  let payload = p.cache.get(p.page);
  if (!payload) {
    try {
      payload = await fetchJson(versionPdfUrl(p.f, p.v, { page: String(p.page) }));
      p.cache.set(p.page, payload);
    } catch (error) {
      if (token === previewState.token) {
        pane.innerHTML = `<div class="prev-state is-error">${icon('x', 18)}<strong>p.${p.page} 加载失败</strong><span>${esc(error.message)}</span></div>`;
      }
      return;
    }
  }
  if (token !== previewState.token) return;
  const block = (payload.blocks || [])[0];
  if (!block) {
    pane.innerHTML = `<div class="prev-state">这一页没有内容。</div>`;
    return;
  }
  const head = `<div class="pdf-page-head">
      <span class="pdf-page-no">p.${block.page}</span>
      <span class="pdf-page-meta">${block.scanned ? '无文字页' : `${formatInt(block.chars)} 字`}</span>
      ${block.scanned ? `<span class="pdf-page-warn">${icon('info', 11)} 图片/扫描页，需要 OCR</span>` : ''}
    </div>`;
  if (block.scanned) {
    pane.innerHTML = `${head}<div class="pdf-scan-note">这一页没有可提取的文字${block.images ? `（含 ${block.images} 张图片）` : ''}。原文视图仍可查看，但 Agent 读不到正文；如需分析需先做 OCR。</div>`;
    return;
  }
  const body = (block.paragraphs || [])
    .map(text => `<p class="pdf-para">${highlightText(text, query)}</p>`)
    .join('');
  pane.innerHTML = `${head}<div class="pdf-page-text">${body}</div>`;
  pane.scrollTop = 0;
}

async function runPdfSearch() {
  const p = previewState.pdf;
  if (!p) return;
  const input = $('#pdfSearch');
  const query = input ? input.value.trim() : '';
  p.query = query;
  if (!query) {
    if (p.page) await loadPdfPage(p.page);
    return;
  }
  const pane = $('#pdfPagePane');
  if (!pane) return;
  const token = p.token;
  pane.innerHTML = `<div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>正在检索「${esc(query)}」…</span></div>`;
  let payload;
  try {
    payload = await fetchJson(versionPdfUrl(p.f, p.v, { query }));
  } catch (error) {
    if (token === previewState.token) {
      pane.innerHTML = `<div class="prev-state is-error">${icon('x', 18)}<strong>检索失败</strong><span>${esc(error.message)}</span></div>`;
    }
    return;
  }
  if (token !== previewState.token) return;
  if (!payload.hits || !payload.hits.length) {
    pane.innerHTML = `<div class="pdf-search-title">「${esc(query)}」没有匹配的段落</div><div class="pdf-search-empty">可以换同义词、缩短关键词，或直接翻页阅读。</div>`;
    return;
  }
  const hits = payload.hits.map(hit => `<button type="button" class="pdf-hit" data-pdf-goto="${hit.page}" data-pdf-query="${esc(query)}">
      <span class="pdf-hit-page">p.${hit.page}</span>
      <span class="pdf-hit-text">${highlightText(hit.snippet, query)}</span>
    </button>`).join('');
  pane.innerHTML = `<div class="pdf-search-title">「${esc(query)}」命中 ${payload.hits.length} 段 · ${payload.pages.map(page => `p.${page}`).join('、')}</div>${hits}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text, query) {
  const raw = String(text || '');
  const needle = String(query || '').trim();
  if (!needle) return esc(raw);
  const terms = [...new Set([needle, ...needle.split(/\s+/).filter(Boolean)])]
    .filter(term => term.length >= 1)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (!terms.length) return esc(raw);
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  return raw.split(re).map((part, index) => (index % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

/* ---------- preview: audio + ASR ---------- */

const ASR_FALLBACK = {
  idle: { label: '未转写', tone: 'neutral', progress: 0, active: false },
  queued: { label: '排队中', tone: 'live', progress: 8, active: true },
  preparing: { label: '准备中', tone: 'live', progress: 14, active: true },
  uploading: { label: '上传音频', tone: 'live', progress: 28, active: true },
  submitting: { label: '提交任务', tone: 'live', progress: 44, active: true },
  waiting: { label: '等待处理', tone: 'live', progress: 55, active: true },
  processing: { label: '转写中', tone: 'live', progress: 72, active: true },
  done: { label: '已转写', tone: 'ok', progress: 100, active: false },
  failed: { label: '转写失败', tone: 'bad', progress: 100, active: false },
  unconfigured: { label: '未配置密钥', tone: 'warn', progress: 0, active: false },
  paused: { label: '已暂停', tone: 'warn', progress: 0, active: false },
  unsupported: { label: '不支持转写', tone: 'neutral', progress: 0, active: false },
  disabled: { label: '转写未启用', tone: 'neutral', progress: 0, active: false },
};

function asrStateOf(asr) {
  const status = asr?.status || 'idle';
  const fallback = ASR_FALLBACK[status] || ASR_FALLBACK.idle;
  return {
    ...fallback,
    ...(asr || {}),
    status,
    label: asr?.label || fallback.label,
    tone: asr?.tone || fallback.tone,
    progress: Number.isFinite(asr?.progress) ? asr.progress : fallback.progress,
    active: asr?.active ?? fallback.active,
    chars: Number(asr?.chars) || 0,
    hasContent: !!asr?.hasContent,
    hasSrt: !!asr?.hasSrt,
  };
}

const formatChars = value => {
  const count = Number(value) || 0;
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${count.toLocaleString('en-US')} 字`;
};

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function versionAsrUrl(f, v) {
  return withProject(`/api/materials/${encodeURIComponent(f.id)}/versions/${v.v}/asr`);
}

function versionAsrContentUrl(f, v, format = 'txt') {
  return withProject(`/api/materials/${encodeURIComponent(f.id)}/versions/${v.v}/asr/content?format=${encodeURIComponent(format)}`);
}

function asrChip(asr, { dot = true } = {}) {
  if (!asr) return `<span class="asr-chip tone-neutral">转写未启用</span>`;
  const state = asrStateOf(asr);
  return `<span class="asr-chip tone-${esc(state.tone)}">${dot ? `<span class="status-dot ${esc(state.tone)}"></span>` : ''}${esc(state.label)}</span>`;
}

function asrInline(asr) {
  if (!asr) {
    return `<span class="asr-inline tone-neutral"><span class="status-dot neutral"></span>转写未启用</span>`;
  }
  const state = asrStateOf(asr);
  const extra = state.status === 'done'
    ? (state.hasContent ? ` · ${formatChars(state.chars)}` : ' · 无文字')
    : state.active
      ? ` · ${state.progress}%`
      : '';
  return `<span class="asr-inline tone-${esc(state.tone)}"><span class="status-dot ${esc(state.tone)}"></span>${esc(state.label)}${extra}</span>`;
}

function asrFileLine(f) {
  const ext = extOf(f.name);
  if (!AUDIO_PREVIEW.has(ext)) return '';
  const state = f.asr
    ? asrStateOf(f.asr)
    : { label: '转写未启用', tone: 'neutral', active: false, progress: 0, status: 'disabled' };
  const detail = state.status === 'done'
    ? (state.hasContent ? formatChars(state.chars) : '无文字')
    : state.active
      ? `${state.progress}%`
      : state.status === 'failed'
        ? '打开可重试'
        : '';
  return `<span class="fl-asr tone-${esc(state.tone)}">
      <span class="fl-asr-top">${icon('audio', 11)}<span>${esc(state.label)}</span>${detail ? `<span class="fl-asr-detail">${esc(detail)}</span>` : ''}</span>
      ${state.active ? `<span class="fl-asr-bar"><i style="width:${Math.max(4, Math.min(100, state.progress))}%"></i></span>` : ''}
    </span>`;
}

function stopAudioPoll() {
  const a = previewState.audio;
  if (a?.timer) {
    clearTimeout(a.timer);
    a.timer = 0;
  }
}

function stopAudioPreview() {
  stopAudioPoll();
  const player = $('#audioPlayer');
  if (player) {
    try {
      player.pause();
      player.removeAttribute('src');
      player.load();
    } catch {
      /* element may already be gone */
    }
  }
  previewState.audio = null;
}

function scheduleAudioPoll() {
  const a = previewState.audio;
  if (!a || !a.asr?.active) return;
  if (a.timer) clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a.timer = 0;
    if (previewState.audio !== a) return;
    void loadAudioAsr();
  }, 4000);
}

async function mountAudio(f, v, token) {
  const box = $('#dPreview');
  box.innerHTML = `<div class="pv pv-audio">
      <div class="pv-bar">
        <span class="pv-kind">${icon('audio', 13)} 音频</span>
        <span class="pv-stat">${esc(f.name)}</span>
        <span class="pv-spacer"></span>
        <a class="pv-btn" href="${esc(versionFileUrl(f, v))}" target="_blank" rel="noreferrer">${icon('external', 13)} 新标签打开</a>
        <button type="button" class="pv-btn pv-icon" data-preview-expand title="放大预览">${icon('maximize', 13)}</button>
      </div>
      <div class="audio-stage">
        <section class="audio-hero">
          <div class="audio-hero-top">
            <span class="audio-glyph">${icon('audio', 22)}</span>
            <span class="audio-copy">
              <strong>${esc(f.name)}</strong>
              <span id="audioMeta">正在读取音频信息…</span>
            </span>
            <span class="audio-asr-slot" id="audioAsrChip">${asrChip(f.asr)}</span>
          </div>
          <audio id="audioPlayer" class="audio-player" controls preload="metadata" src="${esc(versionFileUrl(f, v))}"></audio>
        </section>
        <section class="asr-pane" id="asrPane" aria-live="polite"></section>
      </div>
    </div>`;

  previewState.audio = {
    f,
    v,
    token,
    key: `${f.id}:${v.v}`,
    asr: null,
    summary: f.asr || null,
    mode: 'text',
    timer: 0,
  };

  const player = $('#audioPlayer');
  if (player) {
    player.addEventListener('loadedmetadata', () => {
      const meta = $('#audioMeta');
      if (!meta || previewState.audio?.key !== `${f.id}:${v.v}`) return;
      meta.textContent = `${formatDuration(player.duration)} · ${formatSize(v.size)} · ${esc(extOf(f.name).toUpperCase())}`;
    });
    player.addEventListener('error', () => {
      const meta = $('#audioMeta');
      if (meta) meta.textContent = `${formatSize(v.size)} · 浏览器无法播放该编码，可下载后用本地播放器打开`;
    });
  }

  renderAudioAsrPane();
  await loadAudioAsr();
}

function renderAudioAsrPane() {
  const a = previewState.audio;
  const pane = $('#asrPane');
  if (!a || !pane) return;
  const summary = a.asr || a.summary;
  const state = asrStateOf(summary);
  const chip = $('#audioAsrChip');
  if (chip) chip.innerHTML = asrChip(summary);

  if (a.loading && !a.asr) {
    pane.innerHTML = `<div class="asr-head"><span class="asr-title">${icon('audio', 12)} 转写文本</span><span class="pv-spacer"></span><span class="asr-chip tone-live"><span class="status-dot live"></span>读取中</span></div>
      <div class="asr-body"><div class="prev-state"><span class="prev-spinner" aria-hidden="true"></span><span>正在读取转写状态…</span></div></div>`;
    return;
  }

  if (a.error && !a.asr) {
    pane.innerHTML = `<div class="asr-head"><span class="asr-title">${icon('audio', 12)} 转写文本</span><span class="pv-spacer"></span></div>
      <div class="asr-body"><div class="prev-state is-error">
        ${icon('x', 18)}<strong>转写状态读取失败</strong><span>${esc(a.error.message || a.error)}</span>
        <span class="prev-actions"><button class="btn small" data-asr-refresh>重试</button></span>
      </div></div>`;
    return;
  }

  if (!summary) {
    pane.innerHTML = `<div class="asr-head"><span class="asr-title">${icon('audio', 12)} 转写文本</span></div>
      <div class="asr-body"><div class="prev-state">没有转写信息。</div></div>`;
    return;
  }

  const done = state.status === 'done';
  const active = !!state.active;
  const canStart = !!summary.canStart;
  const actions = [];
  if (done) {
    if (summary.hasSrt) {
      actions.push(`<span class="pv-seg asr-seg" role="group" aria-label="转写内容格式">
        <button type="button" data-asr-mode="text" class="${a.mode !== 'srt' ? 'is-on' : ''}">文本</button>
        <button type="button" data-asr-mode="srt" class="${a.mode === 'srt' ? 'is-on' : ''}">SRT</button>
      </span>`);
    }
    actions.push(`<button type="button" class="pv-btn" data-asr-copy>${icon('copy', 12)} 复制</button>`);
    actions.push(`<button type="button" class="pv-btn" data-asr-download="txt">${icon('download', 12)} TXT</button>`);
    if (summary.hasSrt) actions.push(`<button type="button" class="pv-btn" data-asr-download="srt">${icon('download', 12)} SRT</button>`);
    actions.push(`<button type="button" class="pv-btn" data-asr-start="force">${icon('refresh', 12)} 重新转写</button>`);
  } else if (active) {
    actions.push(`<button type="button" class="pv-btn" data-asr-refresh>${icon('refresh', 12)} 刷新</button>`);
  } else if (canStart) {
    actions.push(`<button type="button" class="pv-btn is-primary" data-asr-start="start">${icon('play', 12)} ${state.status === 'failed' ? '重试转写' : state.status === 'paused' ? '恢复转写' : '开始转写'}</button>`);
  }

  let body = '';
  if (state.status === 'unsupported') {
    body = `<div class="asr-note">${icon('info', 15)}<div><strong>这个格式不支持转写</strong><span>ASR 接口只支持 MP3 / WAV。原音频仍可播放；如需转写，请先转成 MP3 再上传。</span></div></div>`;
  } else if (state.status === 'unconfigured') {
    body = `<div class="asr-note is-warn">${icon('info', 15)}<div><strong>还没有配置转写密钥</strong><span>把智凌 API 密钥写入 <code>.env.local</code> 的 <code>ASR_API_KEY</code>，重启服务后点“开始转写”。</span></div></div>`;
  } else if (state.status === 'failed') {
    body = `<div class="asr-note is-error">${icon('x', 15)}<div><strong>转写失败</strong><span>${esc(summary.error || '远程服务返回失败。')}</span><span class="asr-sub">可以重试；重新提交会再次调用接口并计费。</span></div></div>`;
  } else if (active) {
    body = `<div class="asr-wait">
        <div class="asr-progress"><i style="width:${Math.max(4, Math.min(96, state.progress))}%"></i></div>
        <div class="asr-wait-text"><span class="prev-spinner small" aria-hidden="true"></span><strong>${esc(state.label)}</strong><span>${esc(state.hint || '正在识别语音…')}</span></div>
        ${summary.error ? `<div class="asr-sub is-error">${esc(summary.error)}</div>` : ''}
        <div class="asr-sub">后台自动处理，可以关闭这个窗口；完成后状态会同步到文件卡片。</div>
      </div>`;
  } else if (done) {
    if ((a.mode === 'srt') && summary.hasSrt) {
      body = `<pre class="asr-srt">${esc(a.asr?.srt || '')}</pre>`;
    } else if (summary.hasContent) {
      body = `<div class="asr-text">${esc(a.asr?.content || '')}</div>`;
    } else {
      body = `<div class="asr-note">${icon('info', 15)}<div><strong>没有识别到文字</strong><span>音频可能是静音，或语音太轻。可以重新转写试试。</span></div></div>`;
    }
  } else if (canStart) {
    body = `<div class="asr-note">${icon('audio', 15)}<div><strong>还没有转写</strong><span>开始后会在后台处理，完成后这里会显示全文，并可下载 TXT / SRT。</span></div></div>`;
  } else {
    body = `<div class="asr-note">${icon('info', 15)}<div><strong>${esc(state.label)}</strong><span>${esc(state.hint || '')}</span></div></div>`;
  }

  const count = done && summary.hasContent ? `<span class="asr-count">${formatChars(summary.chars)}</span>` : '';
  pane.innerHTML = `<div class="asr-head">
      <span class="asr-title">${icon('audio', 12)} 转写文本</span>
      ${asrChip(summary)}
      ${count}
      <span class="pv-spacer"></span>
      ${actions.join('')}
    </div>
    <div class="asr-body">${body}</div>`;
}

async function loadAudioAsr() {
  const a = previewState.audio;
  if (!a) return;
  if (a.fetching) return;
  a.fetching = true;
  const token = a.token;
  a.loading = !a.asr;
  renderAudioAsrPane();
  try {
    const data = await fetchJson(versionAsrUrl(a.f, a.v));
    if (previewState.audio !== a || a.token !== token) return;
    a.asr = data;
    a.summary = data;
    a.error = null;
    a.loading = false;
    renderAudioAsrPane();
    if (data.active) scheduleAudioPoll();
    else stopAudioPoll();
  } catch (error) {
    if (previewState.audio !== a || a.token !== token) return;
    if (/未启用|disabled/i.test(error.message || '')) {
      a.asr = {
        status: 'disabled', label: '转写未启用', tone: 'neutral', progress: 0,
        active: false, configured: false, supported: true, canStart: false,
        chars: 0, hasContent: false, hasSrt: false,
        hint: '服务端关闭了语音转写（ASR=0）。',
      };
      a.summary = a.asr;
      a.error = null;
      a.loading = false;
      renderAudioAsrPane();
      stopAudioPoll();
      return;
    }
    a.error = error;
    a.loading = false;
    renderAudioAsrPane();
    stopAudioPoll();
  } finally {
    a.fetching = false;
  }
}

function syncAudioAsr(f, v) {
  const a = previewState.audio;
  if (!a) return;
  a.f = f;
  a.v = v;
  a.summary = f.asr || a.summary;
  const next = asrStateOf(f.asr || a.summary);
  const previous = asrStateOf(a.asr || a.summary);
  if (next.status !== previous.status || (next.status === 'done' && next.hasContent !== previous.hasContent)) {
    if (next.status === 'done') {
      void loadAudioAsr();
      return;
    }
    if (a.asr) a.asr = { ...a.asr, ...(f.asr || {}), status: next.status };
    renderAudioAsrPane();
    if (next.active) scheduleAudioPoll();
    else stopAudioPoll();
  }
}

async function startAudioAsr(force = false) {
  const a = previewState.audio;
  if (!a) return;
  if (force && !window.confirm('重新转写会再次调用接口并按音频时长计费，继续吗？')) return;
  try {
    const data = await api(`/api/materials/${encodeURIComponent(a.f.id)}/asr`, {
      method: 'POST',
      body: { version: a.v.v, force },
    });
    if (previewState.audio !== a) return;
    a.asr = data.asr;
    a.summary = data.asr;
    a.error = null;
    renderAudioAsrPane();
    if (data.asr?.active) scheduleAudioPoll();
    toast(force ? '已重新提交转写' : '已开始转写');
  } catch (error) {
    toast(error.message || '转写启动失败');
  }
}

function copyAudioTranscript() {
  const a = previewState.audio;
  const text = a?.asr?.content;
  if (!text) {
    toast('还没有可复制的转写文本');
    return;
  }
  const done = () => toast('已复制转写文本');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => toast('复制失败'));
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    toast('复制失败');
  }
  area.remove();
}

function downloadAudioTranscript(format = 'txt') {
  const a = previewState.audio;
  if (!a) return;
  if (format === 'srt' && !a.asr?.hasSrt) {
    toast('这次转写没有生成 SRT');
    return;
  }
  window.location.href = versionAsrContentUrl(a.f, a.v, format);
}

/* ---------- preview: markdown ---------- */

let markedLoader = null;

function loadMarked() {
  if (window.marked) return Promise.resolve(window.marked);
  if (!markedLoader) {
    markedLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/marked.umd.js';
      script.onload = () => (window.marked ? resolve(window.marked) : reject(new Error('Markdown 渲染器不可用')));
      script.onerror = () => reject(new Error('无法加载 Markdown 渲染器'));
      document.head.appendChild(script);
    });
  }
  return markedLoader;
}

function resolvePreviewAsset(value, f) {
  const src = String(value || '').trim();
  if (!src) return null;
  if (/^(?:https?:|data:image\/|mailto:|#)/i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  if (src.startsWith('/')) return src;
  const base = (f.relPath || '').split('/').slice(0, -1);
  const parts = [...base, ...src.split('/')];
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  if (!out.length) return null;
  return withProject(`/api/file?path=${encodeURIComponent(out.join('/'))}`);
}

const MD_TAGS = new Set([
  'a', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr',
  'img', 'span', 'sup', 'sub', 'input', 'details', 'summary',
]);
const MD_DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'textarea', 'select',
  'button', 'video', 'audio', 'source', 'link', 'meta', 'base',
]);

function sanitizeMarkdown(html, f) {
  const template = document.createElement('template');
  template.innerHTML = html;

  const clean = node => {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (MD_DROP.has(tag)) {
      node.remove();
      return;
    }
    if (!MD_TAGS.has(tag)) {
      const fragment = document.createDocumentFragment();
      while (node.firstChild) fragment.appendChild(node.firstChild);
      node.replaceWith(fragment);
      return;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ['style', 'id', 'name', 'srcdoc', 'formaction', 'srcset'].includes(name)) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' && tag === 'a') {
        const url = resolvePreviewAsset(attr.value, f);
        if (url && /^(?:https?:|mailto:|#|\/)/i.test(url)) {
          node.setAttribute('href', url);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        } else {
          node.removeAttribute('href');
        }
        continue;
      }
      if (name === 'src' && tag === 'img') {
        const url = resolvePreviewAsset(attr.value, f);
        if (url && /^(?:https?:|data:image\/|\/)/i.test(url)) {
          node.setAttribute('src', url);
          node.setAttribute('loading', 'lazy');
        } else {
          node.removeAttribute('src');
        }
        continue;
      }
      if (tag === 'input') {
        if (name === 'type' && attr.value !== 'checkbox') node.removeAttribute(attr.name);
        if (name === 'checked' || name === 'disabled') continue;
        if (name !== 'type') node.removeAttribute(attr.name);
        continue;
      }
      if ((tag === 'td' || tag === 'th') && ['colspan', 'rowspan', 'align'].includes(name)) continue;
      if (tag === 'ol' && ['start', 'type'].includes(name)) continue;
      if (name === 'class' && /^[a-z0-9 _-]+$/i.test(attr.value)) continue;
      if (name === 'title' || name === 'alt') continue;
      node.removeAttribute(attr.name);
    }
    for (const child of [...node.children]) clean(child);
  };

  for (const child of [...template.content.children]) clean(child);
  return template.innerHTML;
}

async function mountMarkdown(f, v, token) {
  const box = $('#dPreview');
  box.innerHTML = previewLoading('正在读取 Markdown…');
  let text;
  try {
    const res = await fetch(versionFileUrl(f, v));
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    text = await res.text();
  } catch (error) {
    if (token === previewState.token) box.innerHTML = previewFailure(error);
    return;
  }
  if (token !== previewState.token) return;
  if (text.length > 2_000_000) text = `${text.slice(0, 2_000_000)}\n\n…（文件过长，预览已截断）`;
  previewState.md = { text, mode: 'preview', f, v, token };
  box.innerHTML = `<div class="pv pv-md">
      <div class="pv-bar">
        <div class="pv-seg" role="group" aria-label="Markdown 显示模式">
          <button type="button" data-md-mode="preview" class="is-on">预览</button>
          <button type="button" data-md-mode="source">源码</button>
        </div>
        <span class="pv-spacer"></span>
        <span class="pv-stat">${formatInt(text.length)} 字符</span>
        <button type="button" class="pv-btn" data-md-copy title="复制 Markdown 源码">${icon('copy', 13)}</button>
        <button type="button" class="pv-btn" data-preview-expand title="放大预览">${icon('maximize', 13)}</button>
      </div>
      <div class="md-host" id="mdHost"></div>
    </div>`;
  await paintMarkdown();
}

async function paintMarkdown() {
  const state = previewState.md;
  const host = $('#mdHost');
  if (!state || !host) return;
  const token = state.token;
  if (state.mode === 'source') {
    host.className = 'md-host is-source';
    host.innerHTML = `<pre class="prev-text">${esc(state.text)}</pre>`;
    return;
  }
  host.className = 'md-host';
  try {
    const marked = await loadMarked();
    if (token !== previewState.token || previewState.md !== state) return;
    const html = marked.parse(state.text, { gfm: true, breaks: false });
    host.innerHTML = `<div class="md-preview">${sanitizeMarkdown(html, state.f)}</div>`;
  } catch {
    if (token !== previewState.token || previewState.md !== state) return;
    host.innerHTML = `<div class="md-preview">${mdToHtml(state.text)}</div>`;
  }
  host.querySelectorAll('.md-preview a[href]').forEach(link => {
    if (/^https?:/i.test(link.getAttribute('href') || '')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/* ---------- preview: excel ---------- */

async function mountExcel(f, v, token) {
  const box = $('#dPreview');
  box.innerHTML = previewLoading('正在解析工作簿…首次打开大模型约需几秒');
  let manifest;
  try {
    manifest = await fetchJson(versionWorkbookUrl(f, v));
  } catch (error) {
    if (token === previewState.token) {
      box.innerHTML = previewFailure(error, '首次打开需要由 Python/openpyxl 生成预览缓存。');
    }
    return;
  }
  if (token !== previewState.token) return;
  const available = manifest.sheets.filter(sheet => sheet.state !== 'veryHidden');
  const active = available.some(sheet => sheet.name === manifest.activeSheet)
    ? manifest.activeSheet
    : (available.find(sheet => sheet.state === 'visible') || available[0])?.name;
  if (!active) {
    box.innerHTML = previewFailure(new Error('工作簿中没有可显示的工作表'));
    return;
  }

  previewState.xlsx = {
    f,
    v,
    token,
    manifest,
    sheetName: null,
    sheet: null,
    index: null,
    cache: new Map(),
    mode: 'value',
    zoom: 1,
    selection: { r: 1, c: 1 },
    colOverrides: {},
    widthKey: '',
    metrics: null,
  };
  box.innerHTML = excelShell(manifest, f, v);
  await loadXlsxSheet(active, token);
}

function excelShell(manifest, f, v) {
  const tabs = manifest.sheets
    .filter(sheet => sheet.state !== 'veryHidden')
    .map(sheet => `<button type="button" class="xlsx-tab${sheet.state !== 'visible' ? ' is-hidden' : ''}" role="tab" aria-selected="false" data-xlsx-sheet="${esc(sheet.name)}" title="${esc(sheet.name)}${sheet.state !== 'visible' ? '（隐藏工作表）' : ''}">
        ${sheet.state !== 'visible' ? icon('eye-off', 10) : ''}<span>${esc(sheet.name)}</span>
      </button>`)
    .join('');
  const stats = manifest.stats || {};
  const sheetCount = manifest.sheets.filter(sheet => sheet.state !== 'veryHidden').length;
  return `<div class="pv pv-xlsx">
      <div class="pv-bar">
        <div class="pv-seg" role="group" aria-label="显示模式">
          <button type="button" data-xlsx-mode="value" class="is-on">值</button>
          <button type="button" data-xlsx-mode="formula">公式</button>
        </div>
        <span class="pv-divider" aria-hidden="true"></span>
        <button type="button" class="pv-btn pv-icon" data-xlsx-zoom="out" title="缩小">${icon('zoom-out', 14)}</button>
        <button type="button" class="pv-btn pv-zoom" data-xlsx-zoom="reset" title="重置为 100%"><span data-xlsx-zoom-label>100%</span></button>
        <button type="button" class="pv-btn pv-icon" data-xlsx-zoom="in" title="放大">${icon('zoom-in', 14)}</button>
        <span class="pv-spacer"></span>
        <span class="pv-stat">${formatInt(sheetCount)} 个工作表 · ${formatInt(stats.cellCount)} 个单元格</span>
        <a class="pv-btn pv-icon" href="${esc(versionFileUrl(f, v, true))}" title="下载原文件">${icon('download', 14)}</a>
        <button type="button" class="pv-btn pv-icon" data-preview-expand title="放大预览">${icon('maximize', 14)}</button>
      </div>
      <div class="xlsx-formula">
        <input class="xlsx-name" id="xlsxName" value="A1" aria-label="跳转到单元格，例如 B12 或 Consolidated!B12" spellcheck="false" autocomplete="off">
        <span class="xlsx-fx" aria-hidden="true">fx</span>
        <div class="xlsx-fx-val" id="xlsxFx" title=""></div>
      </div>
      <div class="xlsx-scroll" id="xlsxScroll" tabindex="0" role="grid" aria-label="${esc(manifest.fileName || f.name)}">
        <div class="xlsx-sheet" id="xlsxSheet"><div class="xlsx-loading-hint">正在加载工作表…</div></div>
      </div>
      <div class="xlsx-tabs" id="xlsxTabs" role="tablist" aria-label="工作表">${tabs}</div>
      <style id="xlsxStyles">${xlsxStyleCss(manifest.styles)}</style>
    </div>`;
}

function xlsxStyleCss(styles) {
  return (styles || []).map((style, index) => {
    const rules = ['box-sizing:border-box'];
    if (style.b) rules.push('font-weight:600');
    if (style.i) rules.push('font-style:italic');
    if (style.u || style.st) {
      rules.push(`text-decoration:${[style.u ? 'underline' : '', style.st ? 'line-through' : ''].filter(Boolean).join(' ')}`);
    }
    if (style.sz) rules.push(`font-size:calc(${(Number(style.sz) * 1.3333).toFixed(2)}px * var(--xlsx-zoom,1))`);
    if (style.fc) rules.push(`color:#${style.fc}`);
    if (style.bg) rules.push(`background:#${style.bg}`);
    if (style.h === 'center') rules.push('justify-content:center;text-align:center');
    else if (style.h === 'right') rules.push('justify-content:flex-end;text-align:right');
    else if (style.h === 'left' || style.h === 'general') rules.push('justify-content:flex-start;text-align:left');
    if (style.v === 'top') rules.push('align-items:flex-start');
    else if (style.v === 'center') rules.push('align-items:center');
    else if (style.v === 'bottom') rules.push('align-items:flex-end');
    if (style.wrap) rules.push('white-space:pre-wrap;overflow-wrap:anywhere');
    if (style.ind) rules.push(`padding-left:calc(${5 + Number(style.ind) * 10}px * var(--xlsx-zoom,1))`);
    if (style.bd) {
      if (style.bd & 1) rules.push('border-top:1px solid #B9B4A8');
      if (style.bd & 2) rules.push('border-right:1px solid #B9B4A8');
      if (style.bd & 4) rules.push('border-bottom:1px solid #B9B4A8');
      if (style.bd & 8) rules.push('border-left:1px solid #B9B4A8');
    }
    return `.xst-${index}{${rules.join(';')}}`;
  }).join('');
}

async function loadXlsxSheet(sheetName, token) {
  const x = previewState.xlsx;
  if (!x || token !== previewState.token) return;
  const scroll = $('#xlsxScroll');
  const sheetEl = $('#xlsxSheet');
  if (scroll) scroll.setAttribute('aria-busy', 'true');
  $$('#xlsxTabs .xlsx-tab').forEach(tab => {
    const on = tab.dataset.xlsxSheet === sheetName;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
    if (on) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  if (x.sheetName !== sheetName && sheetEl) {
    sheetEl.innerHTML = `<div class="xlsx-loading-hint">正在加载「${esc(sheetName)}」…</div>`;
  }

  let sheet = x.cache.get(sheetName);
  if (!sheet) {
    try {
      sheet = await fetchJson(versionWorkbookUrl(x.f, x.v, sheetName));
      x.cache.set(sheetName, sheet);
    } catch (error) {
      if (token !== previewState.token) return;
      if (sheetEl) {
        sheetEl.innerHTML = `<div class="prev-state is-error">
            ${icon('x', 18)}<strong>工作表加载失败</strong><span>${esc(error.message)}</span>
            <span class="prev-actions"><button class="btn small" data-xlsx-retry="${esc(sheetName)}">重试</button></span>
          </div>`;
      }
      return;
    }
  }
  if (token !== previewState.token) return;
  x.sheet = sheet;
  x.sheetName = sheetName;
  x.index = xlsxIndex(sheet);
  x.selection = { r: 1, c: 1 };
  x.colOverrides = {};
  x.widthKey = '';
  if (scroll) {
    scroll.scrollTop = 0;
    scroll.scrollLeft = 0;
    scroll.setAttribute('aria-busy', 'false');
  }
  renderXlsxGrid({ preserve: false });
  updateXlsxFormulaBar();
}

function xlsxIndex(sheet) {
  const cellMap = new Map();
  for (const row of sheet.cells || []) {
    const [r, c, value, formula, style] = row;
    cellMap.set(`${r}:${c}`, { r, c, v: value, f: formula, s: style });
  }
  const anchors = new Map();
  const covered = new Set();
  for (const [r1, c1, r2, c2] of sheet.merges || []) {
    const key = `${r1}:${c1}`;
    if (!cellMap.has(key)) cellMap.set(key, { r: r1, c: c1, v: null, f: null, s: null });
    anchors.set(key, { r1, c1, r2, c2 });
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
      }
    }
  }
  return { cellMap, anchors, covered };
}

function xlsxColName(index) {
  let n = Math.max(1, Number(index) || 1);
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xlsxColIndex(name) {
  const text = String(name || '').toUpperCase();
  let index = 0;
  for (const char of text) index = index * 26 + (char.charCodeAt(0) - 64);
  return index;
}

function xlsxParseFreeze(value, maxRow, maxCol) {
  if (!value) return { rows: 0, cols: 0, note: '' };
  const match = String(value).replace(/\$/g, '').match(/^([A-Z]{1,3})(\d+)$/i);
  if (!match) return { rows: 0, cols: 0, note: '' };
  const col = xlsxColIndex(match[1]);
  const row = Number(match[2]);
  let cols = Math.max(0, Math.min(maxCol, col - 1));
  let rows = Math.max(0, Math.min(maxRow, row - 1));
  const notes = [];
  if (cols > MAX_XLSX_FREEZE_COLS) {
    notes.push(`冻结列过多（${xlsxColName(col)}），已忽略列冻结`);
    cols = 0;
  }
  if (rows > MAX_XLSX_FREEZE_ROWS) {
    notes.push(`冻结行过多（第 ${row} 行），已忽略行冻结`);
    rows = 0;
  }
  return { rows, cols, note: notes.join(' · ') };
}

function xlsxMetrics(x) {
  const sheet = x.sheet;
  const zoom = x.zoom;
  const maxRow = Math.max(1, sheet.rowCount || 1);
  const maxCol = Math.max(1, sheet.colCount || 1);
  const headH = Math.max(18, Math.round(26 * zoom));
  const rowHeadW = Math.round((maxRow >= 10000 ? 58 : maxRow >= 1000 ? 50 : 44) * zoom);
  const freeze = xlsxParseFreeze(sheet.freeze, maxRow, maxCol);

  const colW = new Array(maxCol + 2).fill(0);
  for (let c = 1; c <= maxCol; c++) {
    const meta = sheet.cols?.[String(c)];
    const hidden = Boolean(meta && meta[1]);
    let logical = meta && meta[0] ? Math.max(28, Math.min(360, Number(meta[0]) * 7 + 5)) : 64;
    if (x.colOverrides[c]) logical = x.colOverrides[c];
    colW[c] = hidden ? 0 : Math.max(18, Math.round(logical * zoom));
  }

  const rowH = new Array(maxRow + 2).fill(0);
  for (let r = 1; r <= maxRow; r++) {
    const meta = sheet.rows?.[String(r)];
    const hidden = Boolean(meta && meta[1]);
    const logical = meta && meta[0] ? Math.max(16, Math.min(140, Number(meta[0]) * (4 / 3))) : 22;
    rowH[r] = hidden ? 0 : Math.max(14, Math.round(logical * zoom));
  }

  const rowTop = new Array(maxRow + 2).fill(0);
  for (let r = 1; r <= maxRow; r++) rowTop[r + 1] = rowTop[r] + rowH[r];
  const colLeft = new Array(maxCol + 2).fill(0);
  colLeft[1] = rowHeadW;
  for (let c = 1; c <= maxCol; c++) colLeft[c + 1] = colLeft[c] + colW[c];

  return {
    maxRow,
    maxCol,
    headH,
    rowHeadW,
    rowH,
    rowTop,
    colW,
    colLeft,
    totalW: colLeft[maxCol + 1],
    totalH: rowTop[maxRow + 1],
    freeze,
    bodyStart: freeze.rows + 1,
    bodyBase: rowTop[freeze.rows + 1] || 0,
  };
}

function xlsxRowAt(rowTop, y) {
  let lo = 1;
  let hi = rowTop.length - 2;
  let answer = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowTop[mid] <= y) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function xlsxColumnAt(colLeft, x, maxCol) {
  let lo = 1;
  let hi = maxCol;
  let answer = maxCol;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (colLeft[mid + 1] > x) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

function xlsxCellDisplay(cell, mode) {
  if (!cell) return '';
  if (mode === 'formula' && cell.f) return cell.f;
  const style = previewState.xlsx?.manifest?.styles?.[cell.s] || null;
  return formatXlsxValue(cell.v, style);
}

function xlsxRowHtml(r, zone, x, metrics, range) {
  const { rowH, colW, colLeft, freeze, rowHeadW } = metrics;
  if (rowH[r] <= 0) return '';

  const cellHtml = c => {
    if (colW[c] <= 0) return '';
    const key = `${r}:${c}`;
    if (x.index.covered.has(key)) return '';
    const cell = x.index.cellMap.get(key) || null;
    const anchor = x.index.anchors.get(key);
    const span = anchor ? Math.max(1, anchor.c2 - anchor.c1 + 1) : 1;
    const styleId = cell && cell.s != null ? cell.s : null;
    const style = styleId != null ? x.manifest.styles[styleId] : null;
    const classes = ['xlsx-c'];
    if (styleId != null) classes.push(`xst-${styleId}`);
    if (c <= freeze.cols) classes.push('is-frozen');
    if (zone === 'frozen') classes.push('is-frozen-row');
    if (x.selection.r === r && x.selection.c === c) classes.push('is-sel');
    if (cell && typeof cell.v === 'number' && !(style && style.h)) classes.push('is-num');
    if (cell && typeof cell.v === 'string' && /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NULL!|NUM!)/.test(cell.v)) {
      classes.push('is-error');
    }
    if (x.mode === 'formula' && cell && cell.f) classes.push('is-formula');
    const content = xlsxCellDisplay(cell, x.mode);
    const title = String(content).length > 28 ? ` title="${esc(content)}"` : '';
    const left = c <= freeze.cols ? `left:${colLeft[c]}px;` : '';
    let width;
    if (span > 1) {
      const vars = [];
      for (let i = 0; i < span; i++) vars.push(`var(--cw-${c + i})`);
      width = `width:calc(${vars.join(' + ')})`;
    } else {
      width = `width:var(--cw-${c})`;
    }
    return `<div class="${classes.join(' ')}" data-r="${r}" data-c="${c}" style="${width};${left}"${title}>${esc(content)}</div>`;
  };

  let frozenHtml = '';
  for (let c = 1; c <= freeze.cols; c++) frozenHtml += cellHtml(c);

  let normalHtml = '';
  if (range.firstNormal <= range.lastNormal) {
    for (let c = range.firstNormal; c <= range.lastNormal; c++) normalHtml += cellHtml(c);
  }
  const leftGap = range.leftGap > 0 ? `<div class="xlsx-gap" style="width:${range.leftGap}px"></div>` : '';
  const rightGap = range.rightGap > 0 ? `<div class="xlsx-gap" style="width:${range.rightGap}px"></div>` : '';
  const rowClass = `xlsx-row${zone === 'frozen' ? ' is-frozen-row' : ''}`;
  return `<div class="${rowClass}" style="height:${rowH[r]}px">` +
    `<div class="xlsx-rh" style="width:${rowHeadW}px">${r}</div>` +
    `${frozenHtml}${leftGap}${normalHtml}${rightGap}</div>`;
}

function renderXlsxGrid({ preserve = true } = {}) {
  const x = previewState.xlsx;
  if (!x || !x.sheet) return;
  const scroll = $('#xlsxScroll');
  const sheetEl = $('#xlsxSheet');
  if (!scroll || !sheetEl) return;

  const oldTop = scroll.scrollTop;
  const oldLeft = scroll.scrollLeft;
  const metrics = xlsxMetrics(x);
  x.metrics = metrics;
  const { maxRow, maxCol, headH, rowHeadW, rowH, rowTop, colW, colLeft, totalW, freeze, bodyStart, bodyBase } = metrics;
  const viewportH = scroll.clientHeight || 480;
  const overscan = Math.round(8 * 22 * x.zoom);
  let first = xlsxRowAt(rowTop, Math.max(0, scroll.scrollTop + bodyBase) - overscan);
  first = Math.max(bodyStart, Math.min(maxRow, first));
  let last = xlsxRowAt(rowTop, scroll.scrollTop + viewportH + bodyBase + overscan);
  last = Math.max(first, Math.min(maxRow, last));
  while (first <= maxRow && rowH[first] === 0) first += 1;
  while (last >= first && rowH[last] === 0) last -= 1;
  if (first > maxRow) first = maxRow;
  if (last < first) last = first;

  const frozenW = Math.max(0, (colLeft[freeze.cols + 1] || rowHeadW) - rowHeadW);
  const viewStart = scroll.scrollLeft + rowHeadW + frozenW;
  const viewEnd = scroll.scrollLeft + scroll.clientWidth;
  const overscanX = Math.round(150 * x.zoom);
  let firstNormal = freeze.cols + 1;
  let lastNormal = freeze.cols;
  if (firstNormal <= maxCol) {
    firstNormal = Math.max(freeze.cols + 1, xlsxColumnAt(colLeft, Math.max(0, viewStart - overscanX), maxCol));
    lastNormal = Math.min(maxCol, xlsxColumnAt(colLeft, viewEnd + overscanX, maxCol));
    while (firstNormal <= maxCol && colW[firstNormal] === 0) firstNormal += 1;
    while (lastNormal >= firstNormal && colW[lastNormal] === 0) lastNormal -= 1;
  }
  const hasNormal = firstNormal <= lastNormal;
  const leftGap = hasNormal
    ? Math.max(0, colLeft[firstNormal] - (rowHeadW + frozenW))
    : Math.max(0, totalW - rowHeadW - frozenW);
  const rightGap = hasNormal ? Math.max(0, totalW - colLeft[lastNormal + 1]) : 0;
  const range = {
    firstNormal: hasNormal ? firstNormal : 1,
    lastNormal: hasNormal ? lastNormal : 0,
    leftGap,
    rightGap,
  };

  const widthKey = `${x.sheetName}:${x.zoom}:${JSON.stringify(x.colOverrides)}`;
  if (x.widthKey !== widthKey) {
    x.widthKey = widthKey;
    sheetEl.style.setProperty('--xlsx-zoom', String(x.zoom));
    sheetEl.style.setProperty('--xlsx-head-h', `${headH}px`);
    sheetEl.style.setProperty('--xlsx-rh-w', `${rowHeadW}px`);
    for (let c = 1; c <= maxCol; c++) sheetEl.style.setProperty(`--cw-${c}`, `${colW[c]}px`);
  }
  sheetEl.style.width = `${totalW}px`;
  sheetEl.dataset.freeze = freeze.note || '';

  let header = `<div class="xlsx-corner" style="width:${rowHeadW}px"></div>`;
  for (let c = 1; c <= freeze.cols; c++) {
    if (colW[c] <= 0) continue;
    header += `<div class="xlsx-ch is-frozen" data-c="${c}" style="width:var(--cw-${c});left:${colLeft[c]}px">${xlsxColName(c)}<span class="xlsx-resize" data-resize="${c}" title="拖动调整列宽"></span></div>`;
  }
  if (leftGap > 0) header += `<div class="xlsx-gap" style="width:${leftGap}px"></div>`;
  for (let c = range.firstNormal; c <= range.lastNormal; c++) {
    if (colW[c] <= 0) continue;
    header += `<div class="xlsx-ch" data-c="${c}" style="width:var(--cw-${c})">${xlsxColName(c)}<span class="xlsx-resize" data-resize="${c}" title="拖动调整列宽"></span></div>`;
  }
  if (rightGap > 0) header += `<div class="xlsx-gap" style="width:${rightGap}px"></div>`;

  let frozenRows = '';
  if (freeze.rows > 0) {
    for (let r = 1; r <= freeze.rows; r++) frozenRows += xlsxRowHtml(r, 'frozen', x, metrics, range);
  }

  let body = '';
  for (let r = first; r <= last; r++) body += xlsxRowHtml(r, 'body', x, metrics, range);
  const padTop = Math.max(0, rowTop[first] - bodyBase);
  const padBottom = Math.max(0, (rowTop[maxRow + 1] - bodyBase) - (rowTop[last + 1] - bodyBase));

  const notes = [
    freeze.note,
    x.sheet.truncated ? '工作表较大，预览已截断至 4000 × 320' : '',
  ].filter(Boolean);
  const note = notes.length
    ? `<div class="xlsx-freeze-note">${icon('info', 12)} ${esc(notes.join(' · '))}</div>`
    : '';
  sheetEl.innerHTML = `<div class="xlsx-chrow" style="height:${headH}px">${header}</div>
    ${note}
    ${frozenRows ? `<div class="xlsx-frozen" style="top:${headH}px">${frozenRows}</div>` : ''}
    <div class="xlsx-body" style="padding-top:${padTop}px;padding-bottom:${padBottom}px">${body}</div>`;

  if (preserve) {
    scroll.scrollTop = oldTop;
    scroll.scrollLeft = oldLeft;
  }
  paintXlsxSelection();
}

function paintXlsxSelection() {
  const x = previewState.xlsx;
  if (!x) return;
  const sheetEl = $('#xlsxSheet');
  if (!sheetEl) return;
  sheetEl.querySelectorAll('.xlsx-c.is-sel').forEach(cell => cell.classList.remove('is-sel'));
  const selected = sheetEl.querySelector(`.xlsx-c[data-r="${x.selection.r}"][data-c="${x.selection.c}"]`);
  if (selected) selected.classList.add('is-sel');
  updateXlsxFormulaBar();
}

function updateXlsxFormulaBar() {
  const x = previewState.xlsx;
  if (!x || !x.index) return;
  const key = `${x.selection.r}:${x.selection.c}`;
  const cell = x.index.cellMap.get(key) || null;
  const style = cell && cell.s != null ? x.manifest.styles[cell.s] : null;
  const name = $('#xlsxName');
  if (name && document.activeElement !== name) {
    name.value = `${xlsxColName(x.selection.c)}${x.selection.r}`;
  }
  const content = cell
    ? (cell.f || formatXlsxValue(cell.v, style) || '')
    : '';
  const fx = $('#xlsxFx');
  if (fx) {
    fx.textContent = content;
    fx.title = content;
    fx.classList.toggle('is-empty', !content);
  }
}

function xlsxScrollToCell(r, c) {
  const x = previewState.xlsx;
  const scroll = $('#xlsxScroll');
  if (!x || !x.metrics || !scroll) return;
  const m = x.metrics;
  if (r > m.freeze.rows) {
    const bodyY = m.rowTop[r] - m.bodyBase;
    const visibleH = Math.max(80, scroll.clientHeight - m.headH - (m.rowTop[m.freeze.rows + 1] || 0));
    if (bodyY < scroll.scrollTop) scroll.scrollTop = bodyY;
    else if (bodyY + m.rowH[r] > scroll.scrollTop + visibleH) {
      scroll.scrollTop = bodyY + m.rowH[r] - visibleH;
    }
  }
  if (c > m.freeze.cols) {
    const frozenW = Math.max(0, (m.colLeft[m.freeze.cols + 1] || m.rowHeadW) - m.rowHeadW);
    const leftEdge = scroll.scrollLeft + m.rowHeadW + frozenW;
    const rightEdge = scroll.scrollLeft + scroll.clientWidth;
    if (m.colLeft[c] < leftEdge) {
      scroll.scrollLeft = Math.max(0, m.colLeft[c] - m.rowHeadW - frozenW);
    } else if (m.colLeft[c] + m.colW[c] > rightEdge) {
      scroll.scrollLeft = m.colLeft[c] + m.colW[c] - scroll.clientWidth;
    }
  }
}

function xlsxVisibleIndex(current, max, sizeOf) {
  if (sizeOf(current) > 0) return current;
  for (let i = current + 1; i <= max; i++) {
    if (sizeOf(i) > 0) return i;
  }
  for (let i = current - 1; i >= 1; i--) {
    if (sizeOf(i) > 0) return i;
  }
  return current;
}

function selectXlsxCell(r, c, { scroll = true } = {}) {
  const x = previewState.xlsx;
  if (!x || !x.sheet) return;
  const maxRow = Math.max(1, x.sheet.rowCount || 1);
  const maxCol = Math.max(1, x.sheet.colCount || 1);
  r = Math.max(1, Math.min(maxRow, Number(r) || 1));
  c = Math.max(1, Math.min(maxCol, Number(c) || 1));
  const anchor = x.index.anchors.get(`${r}:${c}`);
  if (anchor) {
    r = anchor.r1;
    c = anchor.c1;
  }
  if (x.metrics) {
    r = xlsxVisibleIndex(r, maxRow, row => x.metrics.rowH[row]);
    c = xlsxVisibleIndex(c, maxCol, col => x.metrics.colW[col]);
  }
  x.selection = { r, c };
  if (scroll) xlsxScrollToCell(r, c);
  const sheetEl = $('#xlsxSheet');
  const target = sheetEl?.querySelector(`.xlsx-c[data-r="${r}"][data-c="${c}"]`);
  if (!target && scroll) {
    renderXlsxGrid({ preserve: true });
  } else {
    paintXlsxSelection();
  }
}

function gotoXlsxCell(raw) {
  const x = previewState.xlsx;
  if (!x) return;
  const text = String(raw || '').trim();
  const match = text.match(/^(?:(.+?)!)?\$?([A-Z]{1,3})\$?(\d+)$/i);
  if (!match) return;
  const sheetName = match[1] || null;
  const col = xlsxColIndex(match[2]);
  const row = Number(match[3]);
  if (sheetName && sheetName !== x.sheetName) {
    void loadXlsxSheet(sheetName, x.token).then(() => selectXlsxCell(row, col));
    return;
  }
  selectXlsxCell(row, col);
}

function scheduleXlsxScrollRender() {
  if (previewState.scrollFrame) return;
  previewState.scrollFrame = requestAnimationFrame(() => {
    previewState.scrollFrame = 0;
    renderXlsxGrid({ preserve: true });
  });
}

/* ---------- preview: excel number formats ---------- */

function formatXlsxValue(value, style) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatExcelNumber(value, style?.nf);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = String(value);
  if (style?.nf && /[ymdhs]/i.test(style.nf) && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    return formatDateLike(text, style.nf);
  }
  return text;
}

function splitFormatSections(format) {
  const sections = [];
  let current = '';
  let quoted = false;
  for (const char of String(format || '')) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      sections.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  sections.push(current);
  return sections;
}

function parseNumberSection(section) {
  const raw = String(section || '');
  const currencyMatch = raw.match(/\[\$([^\]\-]*)/);
  const currency = currencyMatch ? currencyMatch[1].replace(/["']/g, '') : '';
  let clean = raw
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_.?/g, '')
    .replace(/\*.?/g, '')
    .replace(/\\(.)/g, '$1');
  const percent = clean.includes('%');
  const scientific = /E[+-]/i.test(clean);
  const first = clean.search(/[0#?]/);
  const last = Math.max(clean.lastIndexOf('0'), clean.lastIndexOf('#'), clean.lastIndexOf('?'));
  const prefixRaw = first > 0 ? clean.slice(0, first) : '';
  const suffixRaw = last >= 0 ? clean.slice(last + 1) : '';
  const prefix = `${currency && !prefixRaw.includes(currency) ? currency : ''}${prefixRaw.replace(/["']/g, '').replace(/\s+$/g, '')}`;
  let suffix = suffixRaw.replace(/["']/g, '').trim();
  if (percent && !suffix.includes('%')) suffix += '%';
  const fraction = clean.match(/\.([0#?]+)/);
  const frac = fraction ? fraction[1] : '';
  return {
    prefix,
    suffix,
    percent,
    scientific,
    grouping: /[#0],[#0]/.test(clean),
    maxFrac: frac.length,
    minFrac: (frac.match(/0/g) || []).length,
    parens: /\(.*\)/.test(clean),
  };
}

function generalNumber(value) {
  if (Object.is(value, -0)) value = 0;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e12 || abs < 1e-9)) {
    return value.toExponential(6).replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e');
  }
  return String(Number(value.toPrecision(12)));
}

function formatDateLike(value, format) {
  let year;
  let month;
  let day;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (typeof value === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    year = date.getUTCFullYear();
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
    hours = date.getUTCHours();
    minutes = date.getUTCMinutes();
    seconds = date.getUTCSeconds();
  } else {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return String(value);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hours = Number(match[4] || 0);
    minutes = Number(match[5] || 0);
    seconds = Number(match[6] || 0);
  }
  const pad = n => String(n).padStart(2, '0');
  const lower = String(format).toLowerCase();
  const hasTime = /h/.test(lower) || /s/.test(lower);
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
  let date;
  if (/mmm/.test(lower)) {
    date = `${monthShort} ${day}, ${year}`;
  } else if (lower.indexOf('yyyy') >= 0 && lower.indexOf('dd') >= 0 && lower.indexOf('mm') > lower.indexOf('dd')) {
    date = `${pad(day)}/${pad(month)}/${year}`;
  } else if (lower.indexOf('mm') >= 0 && lower.indexOf('dd') >= 0 && lower.indexOf('mm') < lower.indexOf('dd')) {
    date = `${pad(month)}/${pad(day)}/${year}`;
  } else if (/yy/.test(lower) && !/yyyy/.test(lower)) {
    date = `${pad(month)}/${pad(day)}/${String(year).slice(-2)}`;
  } else {
    date = `${year}-${pad(month)}-${pad(day)}`;
  }
  if (!hasTime) return date;
  const time = /ss/.test(lower) ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}`;
  return `${date} ${time}`;
}

function formatExcelNumber(value, format) {
  if (!format || /^general$/i.test(format)) return generalNumber(value);
  const sections = splitFormatSections(format);
  let section = sections[0] || '';
  if (value < 0 && sections[1]) {
    section = sections[1];
  } else if (value === 0 && sections[2]) {
    section = sections[2];
  }
  if (!section) return generalNumber(value);
  if (/@/.test(section)) return generalNumber(value);
  if (!/[0#?]/.test(section)) {
    const literal = section.replace(/\[[^\]]*\]/g, '').replace(/["']/g, '').replace(/_./g, '').replace(/\*./g, '').trim();
    return literal;
  }
  if (/[ymdhs]/i.test(section) && /^\d{4}-\d{2}-\d{2}/.test(String(value))) {
    return formatDateLike(value, section);
  }

  const parsed = parseNumberSection(section);
  let number = Math.abs(Number(value));
  if (parsed.percent) number *= 100;
  let text;
  if (parsed.scientific) {
    text = number.toExponential(parsed.maxFrac);
  } else {
    try {
      text = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: parsed.minFrac,
        maximumFractionDigits: parsed.maxFrac,
        useGrouping: parsed.grouping,
      }).format(number);
    } catch {
      text = generalNumber(number);
    }
  }
  if (value < 0) {
    if (parsed.parens) text = `(${text})`;
    else if (!/-/.test(parsed.prefix)) text = `-${text}`;
  }
  return `${parsed.prefix}${text}${parsed.suffix}`;
}

/* ---------- preview: interactions ---------- */

function currentPreviewTarget() {
  const f = fileById(state.openFileId);
  if (!f) return null;
  const v = f.versions.find(item => item.v === state.selectedVersion) || latest(f);
  return { f, v };
}

function togglePreviewExpanded(button) {
  const dialog = $('#dialog');
  if (!dialog) return;
  const expanded = dialog.classList.toggle('is-expanded');
  if (button) {
    button.innerHTML = icon(expanded ? 'minimize' : 'maximize', 13);
    button.title = expanded ? '还原预览大小' : '放大预览';
    button.setAttribute('aria-pressed', String(expanded));
  }
  if (previewState.xlsx) {
    requestAnimationFrame(() => renderXlsxGrid({ preserve: true }));
  }
}

function onPreviewClick(event) {
  const target = event.target;

  const asrStart = target.closest('[data-asr-start]');
  if (asrStart) {
    void startAudioAsr(asrStart.dataset.asrStart === 'force');
    return;
  }

  if (target.closest('[data-asr-refresh]')) {
    void loadAudioAsr();
    return;
  }

  if (target.closest('[data-asr-copy]')) {
    copyAudioTranscript();
    return;
  }

  const asrDownload = target.closest('[data-asr-download]');
  if (asrDownload) {
    downloadAudioTranscript(asrDownload.dataset.asrDownload || 'txt');
    return;
  }

  const asrMode = target.closest('[data-asr-mode]');
  if (asrMode) {
    const audio = previewState.audio;
    if (!audio) return;
    audio.mode = asrMode.dataset.asrMode === 'srt' ? 'srt' : 'text';
    renderAudioAsrPane();
    return;
  }

  const pdfView = target.closest('[data-pdf-view]');
  if (pdfView) {
    void switchPdfView(pdfView.dataset.pdfView);
    return;
  }

  if (target.closest('[data-pdf-search]')) {
    void runPdfSearch();
    return;
  }

  const pdfPage = target.closest('[data-pdf-page]');
  if (pdfPage) {
    void loadPdfPage(Number(pdfPage.dataset.pdfPage), { query: previewState.pdf?.query || '' });
    return;
  }

  const pdfHit = target.closest('[data-pdf-goto]');
  if (pdfHit) {
    void loadPdfPage(Number(pdfHit.dataset.pdfGoto), { query: pdfHit.dataset.pdfQuery || '' });
    return;
  }

  const mdMode = target.closest('[data-md-mode]');
  if (mdMode) {
    if (!previewState.md) return;
    previewState.md.mode = mdMode.dataset.mdMode;
    $$('#dPreview [data-md-mode]').forEach(button => {
      button.classList.toggle('is-on', button === mdMode);
    });
    void paintMarkdown();
    return;
  }

  if (target.closest('[data-md-copy]')) {
    if (!previewState.md) return;
    const text = previewState.md.text;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast('已复制 Markdown 源码')).catch(() => toast('复制失败'));
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast('已复制 Markdown 源码'); } catch { toast('复制失败'); }
      area.remove();
    }
    return;
  }

  const x = previewState.xlsx;
  const mode = target.closest('[data-xlsx-mode]');
  if (mode && x) {
    x.mode = mode.dataset.xlsxMode;
    $$('#dPreview [data-xlsx-mode]').forEach(button => {
      button.classList.toggle('is-on', button === mode);
    });
    renderXlsxGrid({ preserve: true });
    return;
  }

  const zoom = target.closest('[data-xlsx-zoom]');
  if (zoom && x) {
    const action = zoom.dataset.xlsxZoom;
    if (action === 'reset') {
      x.zoom = 1;
    } else {
      const current = XLSX_ZOOM_STEPS.findIndex(value => Math.abs(value - x.zoom) < 0.001);
      const next = Math.max(0, Math.min(XLSX_ZOOM_STEPS.length - 1, current + (action === 'in' ? 1 : -1)));
      x.zoom = XLSX_ZOOM_STEPS[next];
    }
    const label = $('#dPreview [data-xlsx-zoom-label]');
    if (label) label.textContent = `${Math.round(x.zoom * 100)}%`;
    renderXlsxGrid({ preserve: true });
    return;
  }

  const tab = target.closest('[data-xlsx-sheet]');
  if (tab && x) {
    const name = tab.dataset.xlsxSheet;
    if (name && name !== x.sheetName) void loadXlsxSheet(name, x.token);
    return;
  }

  const cell = target.closest('.xlsx-c');
  if (cell && x) {
    $('#xlsxScroll')?.focus({ preventScroll: true });
    selectXlsxCell(Number(cell.dataset.r), Number(cell.dataset.c), { scroll: false });
    return;
  }

  const retry = target.closest('[data-preview-retry]');
  if (retry) {
    const current = currentPreviewTarget();
    if (current) void renderPreview(current.f, current.v);
    return;
  }

  const sheetRetry = target.closest('[data-xlsx-retry]');
  if (sheetRetry && x) {
    void loadXlsxSheet(sheetRetry.dataset.xlsxRetry, x.token);
    return;
  }

  if (target.closest('[data-preview-download]')) {
    const current = currentPreviewTarget();
    if (current) window.location.href = versionFileUrl(current.f, current.v, true);
    return;
  }

  if (target.closest('[data-preview-expand]')) {
    togglePreviewExpanded(target.closest('button'));
  }
}

function onPreviewScroll(event) {
  if (event.target && event.target.id === 'xlsxScroll') scheduleXlsxScrollRender();
}

function onPreviewPointerDown(event) {
  const handle = event.target.closest('.xlsx-resize');
  if (!handle) return;
  const x = previewState.xlsx;
  if (!x || !x.metrics) return;
  event.preventDefault();
  event.stopPropagation();
  const col = Number(handle.dataset.resize);
  const sheetEl = $('#xlsxSheet');
  if (!sheetEl) return;
  const startX = event.clientX;
  const startWidth = x.metrics.colW[col];
  const startTotal = x.metrics.totalW;
  document.body.classList.add('is-col-resizing');

  const onMove = moveEvent => {
    const logical = Math.max(28, Math.min(360, (startWidth + moveEvent.clientX - startX) / x.zoom));
    x.colOverrides[col] = logical;
    const width = Math.round(logical * x.zoom);
    sheetEl.style.setProperty(`--cw-${col}`, `${width}px`);
    sheetEl.style.width = `${Math.max(120, startTotal + width - startWidth)}px`;
  };
  const onUp = () => {
    document.body.classList.remove('is-col-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    x.widthKey = '';
    renderXlsxGrid({ preserve: true });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onPreviewDoubleClick(event) {
  const handle = event.target.closest('.xlsx-resize');
  if (!handle) return;
  const x = previewState.xlsx;
  if (!x) return;
  event.preventDefault();
  delete x.colOverrides[Number(handle.dataset.resize)];
  x.widthKey = '';
  renderXlsxGrid({ preserve: true });
}

function onPreviewKeyDown(event) {
  if (event.target && event.target.id === 'pdfSearch') {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runPdfSearch();
      event.target.blur();
    }
    return;
  }
  const x = previewState.xlsx;
  if (event.target && event.target.id === 'xlsxName') {
    if (event.key === 'Enter') {
      event.preventDefault();
      gotoXlsxCell(event.target.value);
      event.target.blur();
    }
    return;
  }
  if (!x || !x.sheet || !event.target.closest('.xlsx-scroll')) return;
  const rowsPerPage = Math.max(1, Math.floor((event.target.clientHeight - 40) / 22));
  const { r, c } = x.selection;
  let nextRow = r;
  let nextCol = c;
  switch (event.key) {
    case 'ArrowUp': nextRow = r - 1; break;
    case 'ArrowDown': nextRow = r + 1; break;
    case 'ArrowLeft': nextCol = c - 1; break;
    case 'ArrowRight': nextCol = c + 1; break;
    case 'PageUp': nextRow = r - rowsPerPage; break;
    case 'PageDown': nextRow = r + rowsPerPage; break;
    case 'Home':
      if (event.metaKey || event.ctrlKey) { nextRow = 1; nextCol = 1; }
      else nextCol = 1;
      break;
    case 'End': nextCol = x.sheet.colCount || 1; break;
    case 'Enter': nextRow = r + 1; break;
    default: return;
  }
  event.preventDefault();
  selectXlsxCell(nextRow, nextCol);
}

function onPreviewWheel(event) {
  const tabs = event.target.closest('.xlsx-tabs');
  if (!tabs || event.shiftKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  tabs.scrollLeft += event.deltaY;
  event.preventDefault();
}




function openFile(id, version) {
  const f = fileById(id);
  if (!f) return;
  const hadFocus = lastFocus;
  if (!taskOverlay.hidden) closeTask(false);
  state.openFileId = id;
  state.selectedVersion = version ?? latest(f).v;
  lastFocus = hadFocus || document.activeElement;
  renderFileDialog();
  overlay.hidden = false;
  $('#dialog').focus();
}

function closeFile(restoreFocus = true) {
  if (overlay.hidden) return;
  overlay.hidden = true;
  state.openFileId = null;
  state.selectedVersion = null;
  const dialog = $('#dialog');
  if (dialog) delete dialog.dataset.key;
  resetPreview();
  if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

function renderFileDialog() {
  const f = fileById(state.openFileId);
  if (!f) return;
  const v = f.versions.find(x => x.v === state.selectedVersion) || latest(f);
  const k = kindOf(f.name);
  const st = STATUS[f.status] || STATUS.draft;

  $('#dIcon').className = `file-icon tint-${k.tint}`;
  $('#dIcon').innerHTML = icon(k.icon, 18);
  $('#dName').textContent = f.name;
  $('#dPath').textContent = f.path;
  const audioAsrRow = AUDIO_PREVIEW.has(extOf(f.name))
    ? `<div><dt>语音转写</dt><dd>${asrInline(f.asr)}</dd></div>`
    : '';
  $('#dMeta').innerHTML = `
    <div><dt>类型</dt><dd>${esc(k.label)}</dd></div>
    <div><dt>大小</dt><dd>${formatSize(v.size)}</dd></div>
    <div><dt>文档状态</dt><dd><span class="status-dot ${st.tone}"></span> ${st.label}</dd></div>
    ${audioAsrRow}
    <div><dt>来源</dt><dd>${esc(SOURCE[f.source] || f.source)}</dd></div>
    <div><dt>版本时间</dt><dd>${esc(v.at)}</dd></div>
    <div><dt>版本</dt><dd>v${v.v} / ${latest(f).v === f.versions.length ? `共 ${f.versions.length} 版` : `保留最近 ${f.versions.length} 版`}</dd></div>
    ${f.session ? `<div class="span2"><dt>关联会话</dt><dd>${esc(f.session)}</dd></div>` : ''}
    ${f.origin ? `<div class="span2"><dt>追踪来源</dt><dd class="dd-mono">${icon('link', 12)} ${esc(f.origin)}</dd></div>` : ''}`;
  $('#dDesc').textContent = f.desc;

  const lineage = $('#dLineage');
  const upstream = (f.derivedFrom || []).map(id => fileById(id)).filter(Boolean);
  if (upstream.length) {
    lineage.hidden = false;
    lineage.innerHTML = `<span class="lineage-label">来自</span>` + upstream.map(u =>
      `<button class="lineage-chip" data-file="${u.id}">${icon(kindOf(u.name).icon, 12)}<span>${esc(u.name)}</span><span class="ver">v${latest(u).v}</span></button>`
    ).join('');
  } else {
    lineage.hidden = true;
    lineage.innerHTML = '';
  }

  const track = $('#dTrack');
  const task = f.taskId ? taskById(f.taskId) : null;
  const localTrack = window.Tracking?.getByFile?.(f) || null;
  delete track.dataset.task;
  delete track.dataset.track;
  track.hidden = false;
  if (task) {
    track.dataset.task = task.id;
    track.innerHTML = `${icon('refresh', 13)}<span class="ts-main">计划任务 · ${esc(task.name)}</span><span class="ts-next">下次 ${esc(task.nextRun)}</span>`;
  } else if (localTrack) {
    track.dataset.track = localTrack.id;
    const nextShort = (localTrack.nextRunLabel || '—').replace(/（[^）]*）/g, ' ').replace(/\s+/g, ' ').trim();
    track.innerHTML = `${icon('clock', 13)}<span class="ts-main">${localTrack.enabled ? '跟踪中' : '已暂停'} · ${esc(localTrack.scheduleShort)}</span><span class="ts-next">${localTrack.enabled ? `下次 ${esc(nextShort)}` : '打开跟踪可启用'}</span>`;
  } else {
    track.innerHTML = `${icon('clock', 13)}<span class="ts-main">加入跟踪</span><span class="ts-next">设时间，自动更新</span>`;
  }

  $('#dVerTitle').textContent = f.kind === 'input' ? '同步记录' : '版本历史';
  const latestVersion = latest(f);
  const checkpoints = f.versions.filter(x => x.visibility !== 'internal');
  const visibleVersions = latestVersion.visibility === 'internal'
    ? [latestVersion, ...checkpoints]
    : checkpoints;
  const internalCount = f.versions.length - checkpoints.length;
  $('#dVerCount').textContent = internalCount
    ? `${checkpoints.length} 个检查点 · ${internalCount} 次自动修订`
    : `共 ${f.versions.length}`;
  $('#dVersions').innerHTML = visibleVersions.map(x => `
    <button class="v-row${x.v === v.v ? ' is-active' : ''}" data-ver="${x.v}">
      <span class="ver">v${x.v}</span>
      <span class="v-main">
        <span class="v-note">${esc(x.note)}${x.visibility === 'internal' ? ' · 自动修订' : ''}</span>
        <span class="v-meta">${esc(x.at)} · ${esc(x.by)} · ${formatSize(x.size)}</span>
      </span>
      ${x.v === latestVersion.v ? '<span class="v-tag">当前</span>' : ''}
    </button>`).join('');

  const rich = RICH_PREVIEW.has(extOf(f.name));
  const dialog = $('#dialog');
  dialog.classList.toggle('is-rich', rich);
  if (!rich) dialog.classList.remove('is-expanded');
  const dialogKey = `${f.id}:${v.v}`;
  if (dialog.dataset.key !== dialogKey) {
    $('#dInfoPane').scrollTop = 0;
    dialog.dataset.key = dialogKey;
  }
  void renderPreview(f, v);

  $('#restoreVersion').hidden = v.v === latest(f).v;
  $('#restoreVersion').textContent = `恢复为 v${latest(f).v + 1}`;
  syncReferenceButton();
}

function selectVersion(v) {
  state.selectedVersion = v;
  renderFileDialog();
}

async function restoreVersion() {
  const f = fileById(state.openFileId);
  if (!f) return;
  const v = f.versions.find(item => item.v === state.selectedVersion);
  if (!v) return;
  try {
    const updated = await api(`/api/materials/${f.id}/versions/${v.v}/restore`, { method: 'POST' });
    state.selectedVersion = updated.versions[0].v;
    upsertMaterial(updated);
    toast(`已恢复为 v${updated.versions[0].v}`);
  } catch (error) {
    toast(error.message || '恢复失败');
  }
}

async function deleteOpenFile() {
  const f = fileById(state.openFileId);
  if (!f) return;
  try {
    await api(`/api/materials/${f.id}`, { method: 'DELETE' });
  } catch (error) {
    toast(error.message || '删除失败');
    return;
  }
  state.files = state.files.filter(item => item.id !== f.id);
  state.pending = state.pending.filter(item => item.id !== f.id);
  closeFile(false);
  renderPanel();
  renderAttachments();
  toast('已删除');
}

function downloadOpenFile() {
  const f = fileById(state.openFileId);
  if (!f || !f.relPath) return;
  const v = f.versions.find(item => item.v === state.selectedVersion) || latest(f);
  window.location.href = versionFileUrl(f, v, true);
}

function copyPath() {
  const f = fileById(state.openFileId);
  if (!f) return;
  const done = () => toast('已复制路径');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(f.path).then(done).catch(done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = f.path;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
    done();
  }
}

/* ---------- task dialog ---------- */

function openTask(id) {
  const t = taskById(id);
  if (!t) return;
  const hadFocus = lastFocus;
  if (!overlay.hidden) closeFile(false);
  state.openTaskId = id;
  lastFocus = hadFocus || document.activeElement;
  renderTaskDialog();
  taskOverlay.hidden = false;
  $('#taskDialog').focus();
}

function closeTask(restoreFocus = true) {
  if (taskOverlay.hidden) return;
  taskOverlay.hidden = true;
  state.openTaskId = null;
  if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

function renderTaskDialog() {
  const t = taskById(state.openTaskId);
  if (!t) return;
  const target = t.targetId ? fileById(t.targetId) : null;
  const inputs = t.inputIds.map(fileById).filter(Boolean);
  $('#tName').textContent = t.name;
  $('#tSchedule').textContent = `${t.schedule} · ${t.enabled ? '已启用' : '已暂停'}`;
  $('#tMeta').innerHTML = `
    <div><dt>频率</dt><dd>${esc(t.schedule)}</dd></div>
    <div><dt>状态</dt><dd><span class="badge ${t.running ? 'running' : t.enabled ? 'on' : 'off'}">${t.running ? '运行中' : t.enabled ? '已启用' : '已暂停'}</span></dd></div>
    <div><dt>下次运行</dt><dd>${esc(t.nextRun)}</dd></div>
    <div><dt>上次运行</dt><dd>${esc(t.lastRun.at)} · ${t.lastRun.ok ? '成功' : '失败'}${t.lastRun.version ? ` · v${t.lastRun.version}` : ''}</dd></div>`;
  $('#tDesc').textContent = t.desc;

  const targetChip = target
    ? `<button class="lineage-chip" data-file="${target.id}">${icon(kindOf(target.name).icon, 12)}<span>${esc(target.name)}</span><span class="ver">v${latest(target).v}</span></button>`
    : `<span class="lineage-chip">已删除</span>`;
  const inputChips = inputs.map(u =>
    `<button class="lineage-chip" data-file="${u.id}">${icon(kindOf(u.name).icon, 12)}<span>${esc(u.name)}</span></button>`
  ).join('');
  $('#tLinks').innerHTML = `
    <div class="link-row"><span class="lineage-label">目标产出</span>${targetChip}</div>
    ${inputs.length ? `<div class="link-row"><span class="lineage-label">监控资料</span>${inputChips}</div>` : ''}`;

  $('#tRunCount').textContent = `共 ${t.history.length} 次`;
  $('#tRuns').innerHTML = t.history.map(h => `
    <div class="run-row">
      <span class="status-dot ${h.ok ? 'ok' : 'warn'}"></span>
      <span class="run-time">${esc(h.at)}</span>
      <span class="run-note">${esc(h.note)}</span>
      <span class="run-out">${h.version ? `v${h.version}` : '—'}</span>
    </div>`).join('');

  $('#taskToggle').textContent = t.enabled ? '暂停计划' : '启用计划';
  $('#taskToggle').disabled = t.running;
  $('#taskRun').disabled = t.running;
  $('#taskRun').textContent = t.running ? '运行中…' : '立即运行';
}

async function toggleTask() {
  const task = taskById(state.openTaskId);
  if (!task || task.running) return;
  try {
    const plan = await api(`/api/plans/${task.id}/toggle`, { method: 'POST' });
    upsertPlan(plan);
    toast(plan.enabled ? '已启用计划' : '已暂停计划');
  } catch (error) {
    toast(error.message || '操作失败');
  }
}

async function runTask() {
  const task = taskById(state.openTaskId);
  if (!task || task.running) return;
  task.running = true;
  renderPanel();
  renderTaskDialog();
  try {
    const result = await api(`/api/plans/${task.id}/run`, { method: 'POST' });
    if (result.plan) upsertPlan(result.plan);
    toast('计划已启动');
  } catch (error) {
    task.running = false;
    renderTaskDialog();
    renderPanel();
    toast(error.message || '启动失败');
  }
}

/* ---------- toast ---------- */

let toastTimer;

export {
  versionFileUrl, versionWorkbookUrl, versionPdfUrl, fetchJson, renderPreview,
  openFile, closeFile, openTask, closeTask, renderTaskDialog, toggleTask, runTask,
  sanitizeMarkdown, loadMarked, selectVersion, restoreVersion, deleteOpenFile,
  downloadOpenFile, copyPath, onPreviewClick, onPreviewScroll, onPreviewPointerDown,
  onPreviewDoubleClick, onPreviewKeyDown, onPreviewWheel, asrFileLine,
};
