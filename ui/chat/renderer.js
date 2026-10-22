/** Chat transcript, live run, composer and attachments/upload. */

import {
  $, $$, esc, icon, threadEl, attachmentsEl, inputEl, sendBtn, fileInput,
  HERO_URL, kindOf, extOf, AUDIO_PREVIEW, nextId, nowHM,
} from "../shared/dom.js";
import { state, selectors } from "../state/store.js";
import { api, uploadFile, withProject } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { approvalsShelfHTML } from "../approvals/approvals.js";
import { renderToolPresentation } from "../tool-renderers/registry.js";
import { sanitizeMarkdown } from "../previews/previews.js";
import { runtime } from "../runtime.js";

const fileById = (id) => selectors.fileById(id);
const latest = (file) => selectors.latest(file);
const refreshFileCards = () => runtime.refreshFileCards?.();
const upsertMaterial = (material) => runtime.upsertMaterial?.(material);
const syncStop = () => runtime.syncStop?.();
const createSession = () => runtime.createSession?.();
const renderPanel = () => runtime.renderPanel?.();


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
  const card = renderToolPresentation(tool);
  return `<div class="tool-row ${tool.status || 'done'}">
      ${icon(glyph, 12)}
      <span class="tool-name">${esc(toolLabel(tool.name))}</span>
      ${tool.detail ? `<span class="tool-detail">${esc(tool.detail)}</span>` : ''}
      <span class="tool-status">${status}</span>
    </div>${card ? `<div class="tool-card-slot">${card}</div>` : ''}`;
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
    const shelf = approvalsShelfHTML();
    threadEl.innerHTML = shelf
      ? `<div class="thread-inner">${shelf}</div>`
      : `<div class="thread-empty">
        <div><div class="empty-mark">${icon('spark', 17)}</div><p class="empty-title">还没有消息</p></div>
      </div>`;
    liveArticle = null;
    void hydrateReports(threadEl);
    return;
  }
  if (state.streaming) {
    if (!liveArticle || !threadEl.contains(liveArticle)) {
      threadEl.innerHTML = `<div class="thread-inner">${approvalsShelfHTML()}${messages.map(messageHTML).join('')}${liveMessageHTML()}</div>`;
      liveArticle = threadEl.querySelector('#liveMsg');
      void hydrateReports(threadEl);
    } else {
      updateLiveMessage();
    }
    if (scroll) threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }
  threadEl.innerHTML = `<div class="thread-inner">${approvalsShelfHTML()}${messages.map(messageHTML).join('')}</div>`;
  liveArticle = null;
  void hydrateReports(threadEl);
  if (scroll) threadEl.scrollTop = threadEl.scrollHeight;
}

/* ---------- right panel: inputs / outputs / plans ---------- */


export function resetLive() {
  liveArticle = null;
}

export function clearCaches() {
  reportCache.clear();
  mdCache.clear();
}

export {
  fileInline, mdInline, mdToHtml, toolLabel, renderMarkdownHTML, toolRowHTML,
  toolGroupHTML, messageHTML, renderThread, scheduleThread, liveMessageHTML,
  updateLiveMessage, syncLiveTicker,
};
