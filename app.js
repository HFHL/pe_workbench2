/* Workbench — project / session / chat / inputs / outputs / versions / plans.
   No dependencies: one static page, all data in memory. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const win = $('#window');
const overlay = $('#overlay');
const taskOverlay = $('#taskOverlay');
const projectOverlay = $('#projectOverlay');
const threadEl = $('#thread');
const fileListEl = $('#fileList');
const attachmentsEl = $('#attachments');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const fileInput = $('#fileInput');

const icon = (name, size = 16) =>
  `<svg class="i" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HERO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 740">
<rect width="1200" height="740" fill="#F4F1EA"/>
<rect x="72" y="56" width="96" height="12" rx="6" fill="#DCD6C9"/>
<rect x="72" y="112" width="520" height="44" rx="8" fill="#E2DCCE"/>
<rect x="72" y="170" width="360" height="14" rx="7" fill="#DCD6C9"/>
<rect x="72" y="198" width="286" height="14" rx="7" fill="#E5E0D4"/>
<rect x="72" y="254" width="124" height="40" rx="6" fill="#1B1B19"/>
<rect x="208" y="254" width="124" height="40" rx="6" fill="none" stroke="#CBC4B4" stroke-width="1.5"/>
<rect x="748" y="96" width="380" height="318" rx="10" fill="#E9E3D6"/>
<circle cx="938" cy="255" r="86" fill="#F4F1EA"/>
<path d="M756 470h364M756 500h248" stroke="#DCD6C9" stroke-width="10" stroke-linecap="round"/>
<rect x="72" y="396" width="1056" height="1" fill="#D9D3C5"/>
<g fill="#E9E3D6">
  <rect x="72" y="444" width="330" height="218" rx="8"/>
  <rect x="426" y="444" width="330" height="218" rx="8"/>
  <rect x="780" y="444" width="348" height="218" rx="8"/>
</g>
<g fill="#F4F1EA">
  <rect x="96" y="470" width="52" height="52" rx="8"/>
  <rect x="450" y="470" width="52" height="52" rx="8"/>
  <rect x="804" y="470" width="52" height="52" rx="8"/>
  <rect x="96" y="548" width="220" height="12" rx="6"/>
  <rect x="450" y="548" width="220" height="12" rx="6"/>
  <rect x="804" y="548" width="236" height="12" rx="6"/>
  <rect x="96" y="574" width="150" height="12" rx="6"/>
  <rect x="450" y="574" width="150" height="12" rx="6"/>
  <rect x="804" y="574" width="168" height="12" rx="6"/>
</g>
</svg>`;
const HERO_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(HERO);

const KINDS = {
  md:   { icon: 'file-text',  tint: 'blue',   label: 'Markdown' },
  markdown: { icon: 'file-text', tint: 'blue', label: 'Markdown' },
  html: { icon: 'code',       tint: 'yellow', label: 'HTML' },
  txt:  { icon: 'file-text',  tint: 'blue',   label: '文本' },
  pdf:  { icon: 'file-text',  tint: 'red',    label: 'PDF' },
  doc:  { icon: 'file-text',  tint: 'blue',   label: 'Word' },
  docx: { icon: 'file-text',  tint: 'blue',   label: 'Word' },
  csv:  { icon: 'grid',       tint: 'green',  label: 'CSV' },
  xlsx: { icon: 'grid',       tint: 'green',  label: 'Excel' },
  xlsm: { icon: 'grid',       tint: 'green',  label: 'Excel (宏)' },
  xltx: { icon: 'grid',       tint: 'green',  label: 'Excel 模板' },
  xltm: { icon: 'grid',       tint: 'green',  label: 'Excel 模板' },
  xls:  { icon: 'grid',       tint: 'green',  label: 'Excel (旧版)' },
  json: { icon: 'code',       tint: 'yellow', label: 'JSON' },
  mp3:  { icon: 'audio',      tint: 'violet', label: 'MP3 音频' },
  wav:  { icon: 'audio',      tint: 'violet', label: 'WAV 音频' },
  m4a:  { icon: 'audio',      tint: 'violet', label: 'M4A 音频' },
  aac:  { icon: 'audio',      tint: 'violet', label: 'AAC 音频' },
  flac: { icon: 'audio',      tint: 'violet', label: 'FLAC 音频' },
  ogg:  { icon: 'audio',      tint: 'violet', label: 'OGG 音频' },
  opus: { icon: 'audio',      tint: 'violet', label: 'OPUS 音频' },
  png:  { icon: 'file-image', tint: 'blue',   label: 'PNG 图像' },
  jpg:  { icon: 'file-image', tint: 'blue',   label: 'JPEG 图像' },
  jpeg: { icon: 'file-image', tint: 'blue',   label: 'JPEG 图像' },
  webp: { icon: 'file-image', tint: 'blue',   label: 'WebP 图像' },
  svg:  { icon: 'file-image', tint: 'blue',   label: 'SVG' },
};
const KIND_FALLBACK = { icon: 'file-text', tint: 'yellow', label: '文件' };
const kindOf = name => KINDS[(name.split('.').pop() || '').toLowerCase()] || KIND_FALLBACK;
const extOf = name => (name.split('.').pop() || '').toLowerCase();

const AUDIO_PREVIEW = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);
const RICH_PREVIEW = new Set([
  'md', 'markdown', 'xlsx', 'xlsm', 'xltx', 'xltm', 'pdf',
  ...AUDIO_PREVIEW,
]);
const EXCEL_PREVIEW = new Set(['xlsx', 'xlsm', 'xltx', 'xltm']);
const MAX_XLSX_FREEZE_ROWS = 8;
const MAX_XLSX_FREEZE_COLS = 8;
const XLSX_ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

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

const STATUS = {
  final:  { label: '已定稿', tone: 'ok' },
  live:   { label: '更新中', tone: 'live' },
  draft:  { label: '草稿',   tone: 'warn' },
  synced: { label: '已同步', tone: 'ok' },
  stale:  { label: '待同步', tone: 'warn' },
};

const SOURCE = {
  upload: '本地上传',
  agent: 'Workbench',
  task: '计划任务',
  import: '导入',
};

const state = {
  projects: [],
  project: { id: 'product-eng', name: 'Product Eng', note: '个人项目', accent: 'slate' },
  activeSession: 's1',
  filter: 'all',
  pending: [],
  picked: new Set(),
  filesOpen: true,
  typing: false,
  openFileId: null,
  selectedVersion: null,
  openTaskId: null,
  files: [],
  tasks: [],
  sessions: [],
  notifications: [],

};

Object.assign(state, {
  activeSession: null,
  sessions: [],
  messages: [],
  streaming: false,
  live: { text: '', tools: [], startedAt: 0 },
  es: null,
  modelId: 'deepseek-v4-pro',
  uploading: false,
  uploadTotal: 0,
  uploadIndex: 0,
});

let uid = 0;
const nextId = () => `f${Date.now().toString(36)}${(uid++).toString(36)}`;
const nowHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const formatSize = bytes => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const shortTime = at => (at.includes(' ') ? at.split(' ').pop() : at);
const activeSession = () => state.sessions.find(s => s.id === state.activeSession) || null;
const fileById = id => state.files.find(f => f.id === id);
const taskById = id => state.tasks.find(t => t.id === id);
const latest = f => f.versions[0];

/* Every project-data request carries its project id, so tabs and running
   agents in different projects can never read each other's state. */
function withProject(url) {
  const id = state.project && state.project.id;
  if (!id) return url;
  return `${url}${url.includes('?') ? '&' : '?'}project=${encodeURIComponent(id)}`;
}

/* ---------- chat ---------- */

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

function fileInline(id) {
  const f = fileById(id);
  if (!f) return '';
  const k = kindOf(f.name);
  return `<button class="file-inline" data-file="${f.id}" aria-label="查看 ${esc(f.name)}">
      ${icon(k.icon, 14)}<span>${esc(f.name)}</span><span class="ver ver-inline">v${latest(f).v}</span></button>`;
}

function mdInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function mdToHtml(md = '') {
  const lines = esc(md).split('\n');
  let html = '';
  let inCode = false;
  let code = [];
  let buffer = [];
  let list = null;
  const flushP = () => { if (buffer.length) { html += `<p>${buffer.join('<br>')}</p>`; buffer = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushP(); closeList();
      if (inCode) {
        html += `<pre class="code-block"><code>${code.join('\n')}</code></pre>`;
        code = []; inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushP(); closeList();
      html += `<p class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</p>`;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushP();
      if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul class="md-list">'; }
      html += `<li>${mdInline(bullet[1])}</li>`;
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushP();
      if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol class="md-list">'; }
      html += `<li>${mdInline(ordered[1])}</li>`;
      continue;
    }
    if (!line.trim()) { flushP(); closeList(); continue; }
    closeList();
    buffer.push(mdInline(line));
  }
  flushP(); closeList();
  if (inCode) html += `<pre class="code-block"><code>${code.join('\n')}</code></pre>`;
  return html;
}

const TOOL_LABELS = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  grep: '检索资料',
  find: '查找文件',
  ls: '查看目录',
  workbook_query: '查询模型',
  westock_query: '查询行情',
  anysearch_search: '搜索网络',
  web_fetch: '读取网页',
  bash: '执行命令',
};

const RUNNING_LABELS = {
  read: '正在读取文件',
  write: '正在撰写报告',
  edit: '正在修改报告',
  grep: '正在检索资料',
  find: '正在查找文件',
  ls: '正在查看目录',
  workbook_query: '正在读取模型',
  westock_query: '正在查询行情',
  anysearch_search: '正在搜索网络',
  web_fetch: '正在读取网页',
  bash: '正在执行命令',
};

const THINKING_LABELS = ['正在思考', '正在分析问题', '正在梳理资料', '正在核对数据', '正在组织结论', '正在撰写报告'];

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

function toolRunningLabel(name) {
  return RUNNING_LABELS[name] || '正在调用工具';
}

function liveStatusText() {
  const tools = state.live.tools || [];
  const running = tools.filter(tool => tool.status === 'running');
  if (running.length) return toolRunningLabel(running[running.length - 1].name);
  if (tools.length) return state.live.text ? '正在整理结论' : '正在核对资料';
  const started = state.live.startedAt || Date.now();
  return THINKING_LABELS[Math.floor((Date.now() - started) / 5000) % THINKING_LABELS.length];
}

function updateLiveStatus() {
  const el = $('#liveStatus');
  if (!el) return;
  const text = liveStatusText();
  if (el.textContent !== text) el.textContent = text;
}

let liveTicker = null;
function syncLiveTicker() {
  if (state.streaming && !liveTicker) liveTicker = setInterval(updateLiveStatus, 3500);
  if (!state.streaming && liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
}

const mdCache = new Map();
function renderMarkdownHTML(text, relPath = '') {
  const src = String(text || '');
  if (!src) return '';
  const key = `${window.marked ? 'm' : 'f'}\u0000${relPath}\u0000${src}`;
  if (mdCache.has(key)) return mdCache.get(key);
  let html;
  if (window.marked) {
    try {
      html = sanitizeMarkdown(window.marked.parse(src, { gfm: true, breaks: false }), { relPath });
    } catch {
      html = mdToHtml(src);
    }
  } else {
    html = mdToHtml(src);
  }
  if (mdCache.size > 160) mdCache.clear();
  mdCache.set(key, html);
  return html;
}

function toolRowHTML(tool) {
  const status = tool.status === 'running' ? '运行中' : tool.status === 'error' ? '失败' : '完成';
  const glyph = tool.status === 'running' ? 'refresh' : tool.status === 'error' ? 'x' : 'check';
  return `<div class="tool-row ${tool.status || 'done'}">
      ${icon(glyph, 12)}
      <span class="tool-name">${esc(toolLabel(tool.name))}</span>
      ${tool.detail ? `<span class="tool-detail">${esc(tool.detail)}</span>` : ''}
      <span class="tool-status">${status}</span>
    </div>`;
}

function toolGroupHTML(tools = [], { live = false, processText = '' } = {}) {
  if (!tools.length && !processText) return '';
  const errors = tools.filter(tool => tool.status === 'error').length;
  const label = live ? liveStatusText() : (tools.length ? `过程 · ${tools.length} 个工具调用` : '过程');
  const meta = live ? (tools.length ? `第 ${tools.length} 步` : '') : (errors ? `${errors} 个失败` : '已完成');
  const status = live ? ' id="liveStatus" aria-live="polite"' : '';
  return `<details class="tool-group">
      <summary class="tool-summary">
        ${icon('chevron-right', 12)}
        <span class="tool-summary-label"${status}>${esc(label)}</span>
        ${meta ? `<span class="tool-summary-meta">${esc(meta)}</span>` : ''}
      </summary>
      ${processText ? `<div class="process-text">${renderMarkdownHTML(processText, '')}</div>` : ''}
      ${tools.length ? `<div class="tool-list">${tools.map(toolRowHTML).join('')}</div>` : ''}
    </details>`;
}

function reportPathsFor(m) {
  const paths = [];
  for (const tool of m.tools || []) {
    if (tool.name !== 'write' && tool.name !== 'edit') continue;
    if (tool.status === 'error') continue;
    const path = String(tool.detail || '').trim();
    if (!path || !/\.(md|markdown)$/i.test(path)) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

function reportKey(path) {
  const file = state.files.find(item => item.relPath === path);
  const version = file && latest(file) ? latest(file).v : '';
  return `${state.project.id}|${path}#${version || ''}`;
}

function reportCardHTML(path) {
  const name = path.split('/').pop();
  const key = reportKey(path);
  const cached = reportCache.get(key);
  const body = cached != null
    ? `<div class="md-preview report-md">${renderMarkdownHTML(cached, path)}</div>`
    : `<div class="report-loading">正在加载报告…</div>`;
  return `<details class="msg-report" open data-report-path="${esc(path)}">
      <summary class="report-summary">
        ${icon('file-text', 13)}
        <span class="report-title">完整报告</span>
        <span class="report-name">${esc(name)}</span>
        ${icon('chevron-right', 12)}
      </summary>
      <div class="report-body" data-report-body${cached != null ? ` data-report-key="${esc(key)}"` : ''}>${body}</div>
    </details>`;
}

const reportCache = new Map();
async function hydrateReports(root = threadEl) {
  const nodes = $$('[data-report-path]', root);
  for (const node of nodes) {
    const path = node.dataset.reportPath;
    const body = $('[data-report-body]', node);
    if (!path || !body) continue;
    const key = reportKey(path);
    if (body.dataset.reportKey === key) continue;
    try {
      let text = reportCache.get(key);
      if (text == null) {
        const res = await fetch(withProject(`/api/file?path=${encodeURIComponent(path)}`));
        if (res.status === 404) throw new Error("报告文件已不存在（可能来自已清理的测试会话）");
        if (!res.ok) throw new Error(`读取失败（${res.status}）`);
        text = await res.text();
        reportCache.set(key, text);
      }
      body.innerHTML = `<div class="md-preview report-md">${renderMarkdownHTML(text, path)}</div>`;
      body.dataset.reportKey = key;
      body.querySelectorAll('a[href]').forEach(link => {
        if (/^https?:/i.test(link.getAttribute('href') || '')) {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        }
      });
    } catch (error) {
      body.innerHTML = `<div class="report-error">无法加载报告：${esc(error.message || String(error))}</div>`;
    }
  }
}

function messageHTML(m) {
  const isUser = m.role === 'user';
  const body = isUser
    ? esc(m.text).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
    : renderMarkdownHTML(m.text || '', '');
  const group = isUser ? '' : toolGroupHTML(m.tools || [], { processText: m.processText || '' });
  const reports = isUser ? '' : reportPathsFor(m).map(reportCardHTML).join('');
  return `<article class="msg ${isUser ? 'user' : 'assistant'}">
      <span class="msg-avatar">${isUser ? '林' : icon('spark', 15)}</span>
      <div>
        <div class="msg-head"><span class="msg-name">${isUser ? '林默' : 'Workbench'}</span><span class="msg-time">${esc(m.time || '')}</span></div>
        <div class="msg-body${isUser ? '' : ' md-preview'}">${body}</div>
        ${group}
        ${reports}
      </div>
    </article>`;
}

let renderScheduled = false;
let liveArticle = null;
function scheduleThread(scroll = true) {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; renderThread(scroll); });
}

function liveMessageHTML() {
  const live = state.live;
  const hasContent = Boolean(live.text || live.tools.length);
  const status = esc(liveStatusText());
  const inlineStatus = live.tools.length
    ? ''
    : `<div class="live-status" id="liveStatusHost"><span class="live-dot"></span><span id="liveStatus" aria-live="polite">${status}</span>${hasContent ? '' : '<span class="typing"><i></i><i></i><i></i></span>'}</div>`;
  return `<article class="msg assistant" id="liveMsg">
      <span class="msg-avatar">${icon('spark', 15)}</span>
      <div>
        <div class="msg-head"><span class="msg-name">Workbench</span><span class="msg-time">正在输出</span></div>
        <div class="msg-body md-preview" id="liveBody"${live.text ? '' : ' hidden'}>${live.text ? renderMarkdownHTML(live.text, '') : ''}</div>
        ${inlineStatus}
        <div id="liveTools">${live.tools.length ? toolGroupHTML(live.tools, { live: true }) : ''}</div>
      </div>
    </article>`;
}

function updateLiveMessage() {
  if (!liveArticle) return;
  const live = state.live;
  const hasContent = Boolean(live.text || live.tools.length);

  const body = liveArticle.querySelector('#liveBody');
  if (body) {
    if (live.text) {
      const html = renderMarkdownHTML(live.text, '');
      if (body.innerHTML !== html) body.innerHTML = html;
      body.hidden = false;
    } else {
      if (body.innerHTML) body.innerHTML = '';
      body.hidden = true;
    }
  }

  let statusHost = liveArticle.querySelector('#liveStatusHost');
  if (live.tools.length) {
    statusHost?.remove();
  } else {
    if (!statusHost) {
      statusHost = document.createElement('div');
      statusHost.className = 'live-status';
      statusHost.id = 'liveStatusHost';
      statusHost.innerHTML = '<span class="live-dot"></span><span id="liveStatus" aria-live="polite"></span>';
      const toolsHost = liveArticle.querySelector('#liveTools');
      if (toolsHost) toolsHost.before(statusHost);
    }
    const statusEl = statusHost.querySelector('#liveStatus');
    const text = liveStatusText();
    if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
    const typing = statusHost.querySelector('.typing');
    if (hasContent && typing) typing.remove();
    if (!hasContent && !typing) statusHost.insertAdjacentHTML('beforeend', '<span class="typing"><i></i><i></i><i></i></span>');
  }

  const toolsHost = liveArticle.querySelector('#liveTools');
  if (toolsHost) {
    const signature = live.tools.map(tool => `${tool.id}:${tool.status}:${String(tool.output || '').length}`).join('|');
    if (toolsHost.dataset.signature !== signature) {
      const wasOpen = Boolean(toolsHost.querySelector('details')?.open);
      toolsHost.innerHTML = live.tools.length ? toolGroupHTML(live.tools, { live: true }) : '';
      toolsHost.dataset.signature = signature;
      const details = toolsHost.querySelector('details');
      if (wasOpen && details) details.open = true;
    } else {
      const label = toolsHost.querySelector('#liveStatus');
      const text = liveStatusText();
      if (label && label.textContent !== text) label.textContent = text;
    }
  }
}

function renderThread(scroll = false) {
  const messages = state.messages;
  if (!messages.length && !state.streaming) {
    threadEl.innerHTML = `<div class="thread-empty">
        <div><div class="empty-mark">${icon('spark', 17)}</div><p class="empty-title">还没有消息</p></div>
      </div>`;
    liveArticle = null;
    return;
  }
  if (state.streaming) {
    if (!liveArticle || !threadEl.contains(liveArticle)) {
      threadEl.innerHTML = `<div class="thread-inner">${messages.map(messageHTML).join('')}${liveMessageHTML()}</div>`;
      liveArticle = threadEl.querySelector('#liveMsg');
      void hydrateReports(threadEl);
    } else {
      updateLiveMessage();
    }
    if (scroll) threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }
  threadEl.innerHTML = `<div class="thread-inner">${messages.map(messageHTML).join('')}</div>`;
  liveArticle = null;
  void hydrateReports(threadEl);
  if (scroll) threadEl.scrollTop = threadEl.scrollHeight;
}

/* ---------- right panel: inputs / outputs / plans ---------- */

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

const formatInt = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');

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
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

/* ---------- chat actions ---------- */

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


async function send() {
  if (state.uploading) return;
  const text = inputEl.value.trim();
  const attached = state.pending.slice();
  if (!text && !attached.length) return;

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
  state.streaming = true;
  state.live = { text: '', tools: [], startedAt: Date.now() };
  liveArticle = null;
  syncStop();
  window.NextActions?.refresh?.();
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
  sendBtn.disabled = state.uploading || (!hasText && state.pending.length === 0);
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

const isNarrow = () => window.matchMedia('(max-width: 980px)').matches;

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

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(withProject(pathname), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'request failed');
  return data;
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', withProject('/api/upload'));
    xhr.timeout = 15 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    let lastPct = -1;
    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable || !event.total) return;
      const fraction = event.loaded / event.total;
      const pct = Math.round(fraction * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      onProgress?.(fraction);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败（HTTP ${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传中断')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}

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

async function loadProjects() {
  const items = await api('/api/projects');
  state.projects = Array.isArray(items) ? items : [];
  const stored = localStorage.getItem('workbench.project');
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
  state.project = project;
  localStorage.setItem('workbench.project', project.id);

  // Everything below belongs to the previous project: drop it before loading.
  closeFile(false);
  closeTask(false);
  reportCache.clear();
  mdCache.clear();
  window.Tracking?.reset?.();
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.activeSession = null;
  state.sessions = [];
  state.messages = [];
  state.files = [];
  state.tasks = [];
  state.pending = [];
  state.picked = new Set();
  state.streaming = false;
  state.live = { text: '', tools: [], startedAt: 0 };
  state.notifications = [];
  renderNotifications();
  state.filter = 'all';
  state.openFileId = null;
  state.selectedVersion = null;
  state.openTaskId = null;
  state.typing = false;
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

  try {
    await loadSessions();
    await loadFoundation();
    await window.Tracking?.reload?.();
    renderPanel();
  } catch (error) {
    toast(error.message || '加载项目失败');
  }
  window.NextActions?.refresh?.();
}

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

function connectGlobalEvents() {
  const es = new EventSource(withProject('/api/events'));
  es.onmessage = (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === 'material.updated') upsertMaterial(payload.material);
    if (payload.type === 'material.deleted') {
      state.files = state.files.filter(item => item.id !== payload.id);
      if (state.openFileId === payload.id) closeFile(false);
      renderPanel();
    }
    if (payload.type === 'plan.updated') upsertPlan(payload.plan);
    if (payload.type === 'tracking.updated') window.Tracking?.upsert?.(payload.tracking);
    if (payload.type === 'tracking.deleted') window.Tracking?.remove?.(payload.id);
    if (payload.type === 'notification.created') {
      void loadNotifications();
      Promise.resolve(window.Tracking?.reload?.()).catch(() => {});
    }
    if (payload.type === 'monitor.updated') {
      Promise.resolve(window.Tracking?.reload?.()).catch(() => {});
    }
  };
}

async function boot() {
  try {
    const health = await api('/api/health');
    if (health.model) {
      state.modelId = health.model;
      $('#modelName').textContent = health.model;
    }
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
  try {
    await loadSessions();
  } catch (error) {
    toast(error.message || '加载会话失败');
  }
  await loadFoundation();
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
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  const es = new EventSource(withProject(`/api/sessions/${id}/events`));
  state.es = es;
  es.onmessage = (event) => {
    if (state.activeSession !== id) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    handleServerEvent(payload);
  };
}

function updateSessionItem(id, patch) {
  const index = state.sessions.findIndex(item => item.id === id);
  if (index < 0) return;
  Object.assign(state.sessions[index], patch);
  state.sessions[index] = decorateSession(state.sessions[index]);
}

function handleServerEvent(ev) {
  switch (ev.type) {
    case 'snapshot':
      state.messages = ev.messages || [];
      state.streaming = !!ev.streaming;
      state.live = { text: '', tools: [], startedAt: ev.streaming ? Date.now() : 0 };
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
      liveArticle = null;
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
      } else {
        state.live.tools.push({ id: ev.id, name: ev.name, detail: ev.detail, status: ev.status, output: ev.output || '' });
      }
      scheduleThread();
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

async function refreshSnapshot() {
  const id = state.activeSession;
  if (!id) return;
  try {
    const snap = await api(`/api/sessions/${id}/state`);
    if (state.activeSession !== id) return;
    state.messages = snap.messages || [];
    state.streaming = !!snap.streaming;
    state.live = { text: '', tools: [], startedAt: snap.streaming ? Date.now() : 0 };
    updateSessionItem(id, { title: snap.title });
    syncStop();
    renderSessions();
    renderAllChrome();
    liveArticle = null;
    renderThread(true);
  } catch {
    liveArticle = null;
    scheduleThread();
  }
}

function syncStop() {
  $('#stopBtn').hidden = !state.streaming;
  syncLiveTicker();
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

init().catch(error => {
  console.error(error);
  toast('初始化失败，请检查本地服务');
});
