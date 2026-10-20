/* Workbench — file tracking / scheduled autonomous updates (mock UI).
   The timer itself is mocked. The interaction contract is the point:
   pick a file -> pick a time -> result first, with reasons for every change. */

(() => {
  const KEY = 'pe.tracking.v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ic = (name, size = 16) =>
    `<svg class="i" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s = '') =>
    String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const detailOverlay = $('#trackOverlay');
  const setupOverlay = $('#trackSetupOverlay');
  const scheduleOverlay = $('#trackScheduleOverlay');

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEKDAY_OPTIONS = [
    [1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日'],
  ];

  const TEMPLATES = {
    framework: {
      label: '投资框架复核',
      icon: 'spark',
      tag: 'Markdown · 原位更新',
      writeMode: 'in_place',
      desc: '读取新财务、行情和同行数据，对比原预测与假设，更新投资结论和失效条件。',
      prompt: `你是投资框架的滚动复核 agent。
1. 读取目标文件与同目录的 analysis-state.json，固定当前版本与上次结论。
2. 拉取截至今天的财务实际值、行情和同行数据；每条数据记录来源与日期。
3. 只比较与原假设相关的变量：实际 vs 原预测、新证据 vs 原判断。
4. 对每个受影响假设，写出旧值、新值、依据、影响链和失效条件。
5. 原位更新 Markdown（写入前备份），并在回复中先给结论，再给调整原因。
6. 没有实质变化时明确说“无重大变化”，不要为了更新而更新。`,
    },
    model: {
      label: '估值模型更新',
      icon: 'grid',
      tag: 'Excel · 生成更新副本',
      writeMode: 'propose_only',
      desc: '把已确定的财务实际值填入模型，重算受影响的预测与估值，生成更新副本和变更清单。',
      prompt: `你是估值模型的滚动更新 agent。
1. 用 workbook_query 读取模型结构、公式和缓存值，固定基线版本与估值日。
2. 找到已经确定的新实际值，映射到模型科目与期间；无法可靠映射的保留为缺口。
3. 只重算受影响链路：实际值 → 预测 → 三表 → 估值，不整体重写模型。
4. 每条变更记录位置、原值、新值、依据和影响；Excel 原文件保持只读，生成更新副本与 update-plan.json。
5. 回复先给目标价/估值变化，再给“为什么调整”和尚未验证的项。
6. 没有实质变化时明确说“无重大变化”。`,
    },
    generic: {
      label: '通用文件刷新',
      icon: 'refresh',
      tag: '文本 · 按原结构更新',
      writeMode: 'in_place',
      desc: '按文件自身结构和最新资料刷新内容，保留原有结论框架与写作方式。',
      prompt: `你是文件刷新 agent。
1. 读取目标文件，记录当前版本、结构与关键结论。
2. 收集截至今天的新资料，逐条标注来源与日期。
3. 只修改受新资料影响的内容，保留原结构与未受影响的判断。
4. 写入前备份；回复先给结论，再给每条调整的依据。
5. 没有实质变化时明确说“无重大变化”。`,
    },
  };

  const ui = {
    trackings: [],
    loaded: false,
    loading: false,
    error: '',
    seeded: false,
    wired: false,
    openId: null,
    lastFocus: null,
    setup: null,
    scheduleDraft: null,
    runTimers: new Map(),
    initPromise: null,
  };

  async function api(pathname, { method = 'GET', body } = {}) {
    // The active project travels with every request so switching projects never
    // leaks data from the previous one.
    const url = typeof withProject === 'function' ? withProject(pathname) : pathname;
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || '请求失败');
    return data;
  }

  async function loadTrackings() {
    ui.loading = true;
    ui.error = '';
    if (typeof state !== 'undefined' && state.filter === 'tracking') renderPanel();
    try {
      const items = await api('/api/trackings');
      ui.trackings = Array.isArray(items) ? items : [];
      ui.loaded = true;
      return ui.trackings;
    } catch (error) {
      ui.error = error.message || '加载跟踪失败';
      ui.loaded = true;
      throw error;
    } finally {
      ui.loading = false;
      if (ui.openId) {
        const open = ui.trackings.find((item) => item.id === ui.openId);
        if (open) renderDetail();
      }
    }
  }

  function trackingViewKey(tracking) {
    if (!tracking) return '';
    const { runStep, runStartedAt, ...rest } = tracking;
    return JSON.stringify(rest);
  }

  function upsertTracking(tracking) {
    if (!tracking) return;
    const index = ui.trackings.findIndex((item) => item.id === tracking.id);
    const previous = index >= 0 ? ui.trackings[index] : null;
    const changed = !previous || trackingViewKey(previous) !== trackingViewKey(tracking);
    tracking.runStep = tracking.runStep ?? previous?.runStep;
    tracking.runStartedAt = tracking.runStartedAt ?? previous?.runStartedAt;
    if (index >= 0) ui.trackings[index] = tracking;
    else ui.trackings.unshift(tracking);
    if (previous?.running && !tracking.running) {
      clearRunWatcher(tracking.id);
      const failed = tracking.lastRun && tracking.lastRun.ok === false;
      toast(failed ? '跟踪运行失败，详见运行记录' : '跟踪运行完成');
    }
    if (ui.openId === tracking.id) {
      if (changed) renderDetail();
      if (tracking.running) watchRun(tracking.id);
    }
    if (changed) {
      renderPanel();
      updateFilterCount();
      window.NextActions?.refresh?.();
    }
  }

  function removeTracking(id) {
    ui.trackings = ui.trackings.filter((item) => item.id !== id);
    clearRunWatcher(id);
    if (ui.openId === id) closeDetail(false);
    renderPanel();
    updateFilterCount();
    window.NextActions?.refresh?.();
  }

  /* ---------- time / schedule ---------- */

  const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const fullTime = d =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm(d)}`;

  function computeNextRun(schedule, from = new Date()) {
    const [hh, mm] = String(schedule.time || '09:00').split(':').map(Number);
    const hour = Number.isFinite(hh) ? hh : 9;
    const minute = Number.isFinite(mm) ? mm : 0;
    if (schedule.freq === 'daily') {
      const candidate = new Date(from);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    }
    if (schedule.freq === 'weekly') {
      const target = Number(schedule.weekday || 1) % 7;
      const candidate = new Date(from);
      candidate.setHours(hour, minute, 0, 0);
      let diff = (target - candidate.getDay() + 7) % 7;
      if (diff === 0 && candidate <= from) diff = 7;
      candidate.setDate(candidate.getDate() + diff);
      return candidate;
    }
    const day = Math.min(28, Math.max(1, Number(schedule.day || 1)));
    let candidate = new Date(from.getFullYear(), from.getMonth(), day, hour, minute, 0, 0);
    if (candidate <= from) candidate = new Date(from.getFullYear(), from.getMonth() + 1, day, hour, minute, 0, 0);
    return candidate;
  }

  function scheduleLabel(schedule) {
    if (schedule.freq === 'daily') return `每天 ${schedule.time}`;
    if (schedule.freq === 'weekly') return `每${WEEKDAYS[Number(schedule.weekday || 1) % 7]} ${schedule.time}`;
    return `每月 ${Number(schedule.day || 1)} 日 ${schedule.time}`;
  }

  function scheduleShort(schedule) {
    if (schedule.freq === 'daily') return `每天 ${schedule.time}`;
    if (schedule.freq === 'weekly') return `${WEEKDAYS[Number(schedule.weekday || 1) % 7]} ${schedule.time}`;
    return `每月 ${Number(schedule.day || 1)} 日`;
  }

  function nextLabel(date) {
    return `${md(date)}（${WEEKDAYS[date.getDay()]}）${hm(date)}`;
  }

  function refreshNext(t) {
    if (!t.enabled) {
      t.nextRun = null;
      t.nextRunLabel = '已暂停';
      return;
    }
    const next = computeNextRun(t.schedule);
    t.nextRun = next.toISOString();
    t.nextRunLabel = nextLabel(next);
  }

  function nextFromIso(t) {
    if (!t.enabled) return null;
    const iso = t.nextRunAt || t.nextRun;
    if (iso) {
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime()) && parsed > new Date()) return parsed;
    }
    return computeNextRun(t.schedule);
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const days = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
    if (!Number.isFinite(days)) return '未知';
    if (days <= 0) return '今天';
    if (days < 30) return `${days} 天前`;
    return `${Math.floor(days / 30)} 个月前`;
  }

  /* ---------- files / templates ---------- */

  function targetFile(t) {
    if (!t) return null;
    return (
      stateFiles().find(f => f.relPath === t.relPath) ||
      stateFiles().find(f => f.name === t.targetName) ||
      null
    );
  }

  function stateFiles() {
    return files();
  }

  // `state` is app.js's top-level state object, shared by classic scripts.
  function files() {
    try {
      return (typeof state !== 'undefined' && Array.isArray(state.files)) ? state.files : [];
    } catch {
      return [];
    }
  }

  function latestVersion(f) {
    return f && Array.isArray(f.versions) && f.versions.length ? f.versions[0] : null;
  }

  function fileVersion(f) {
    const v = latestVersion(f);
    return v ? v.v : 1;
  }

  function fileIcon(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'csv'].includes(ext)) return { icon: 'grid', tint: 'green' };
    if (['md', 'markdown', 'txt'].includes(ext)) return { icon: 'file-text', tint: 'blue' };
    if (['json'].includes(ext)) return { icon: 'code', tint: 'yellow' };
    return { icon: 'file-text', tint: 'yellow' };
  }

  function templateForFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) return 'model';
    if (['md', 'markdown', 'txt'].includes(ext)) return 'framework';
    return 'generic';
  }

  function templateInfo(key) {
    return TEMPLATES[key] || TEMPLATES.generic;
  }

  function getByFile(f) {
    if (!f) return null;
    return ui.trackings.find(t => t.relPath && f.relPath && t.relPath === f.relPath)
      || ui.trackings.find(t => t.targetName === f.name)
      || null;
  }

  function getById(id) {
    return ui.trackings.find(t => t.id === id) || null;
  }

  function count() {
    return ui.trackings.length;
  }

  /* ---------- seed mock results ---------- */

  /* ---------- panel ---------- */

  function updateFilterCount() {
    const btn = document.querySelector('#fileFilters [data-filter="tracking"]');
    if (!btn) return;
    btn.innerHTML = ui.trackings.length
      ? `跟踪<span class="filter-count">${ui.trackings.length}</span>`
      : '跟踪';
  }

  function renderPanel() {
    const plus = $('#newTrackBtn');
    if (plus) plus.hidden = !(typeof state !== 'undefined' && state.filter === 'tracking');
    updateFilterCount();
    if (typeof state !== 'undefined' && state.filter !== 'tracking') {
      if (typeof window.__peRenderPanel === 'function') window.__peRenderPanel();
      return;
    }
    const list = $('#fileList');
    if (!list) return;
    if (ui.loading && !ui.trackings.length) {
      list.innerHTML = `<div class="track-loading"><span class="prev-spinner" aria-hidden="true"></span><span>正在加载跟踪…</span></div>`;
      return;
    }
    if (ui.error && !ui.trackings.length) {
      list.innerHTML = `<div class="track-empty">
        ${ic('info', 20)}
        <strong>跟踪列表加载失败</strong>
        <span>${esc(ui.error)}</span>
        <button class="btn" data-track-retry>重试</button>
      </div>`;
      return;
    }
    if (!ui.trackings.length) {
      list.innerHTML = `
        <div class="tracking-intro">
          <div class="ti-eyebrow"><span class="dot"></span>文件跟踪</div>
          <div class="ti-headline">让产出文件自己保持最新</div>
          <p class="ti-note">选一个文件，设一个时间。到点后 Workbench 会读文件、找新数据、更新结论，并把「为什么调整」写清楚。</p>
        </div>
        <div class="track-empty">
          ${ic('clock', 20)}
          <strong>还没有跟踪中的文件</strong>
          <span>从产出文件详情里点「加入跟踪」，或直接选择一个文件。</span>
          <button class="btn primary" data-track-new>选择文件</button>
        </div>`;
      return;
    }

    const active = ui.trackings.filter(t => t.enabled);
    const nextDates = active.map(nextFromIso).filter(Boolean).sort((a, b) => a - b);
    const next = nextDates[0];
    const running = ui.trackings.filter(t => t.running).length;
    list.innerHTML = `
      <div class="tracking-intro">
        <div class="ti-eyebrow"><span class="dot ${running ? 'is-live' : ''}"></span>${running ? `${running} 个正在更新` : `${active.length} 个文件正在跟踪`}</div>
        <div class="ti-headline">${next ? `下一次 ${md(next)} ${WEEKDAYS[next.getDay()]} ${hm(next)}` : '全部已暂停'}</div>
        <p class="ti-note">结果先给结论，再给每条调整的依据。没有实质变化时会明确说「无重大变化」。</p>
      </div>
      ${ui.trackings.map(trackCard).join('')}`;
  }

  function trackCard(t) {
    const f = targetFile(t);
    const info = templateInfo(t.template);
    const iconInfo = f ? fileIcon(f) : { icon: info.icon, tint: 'yellow' };
    const badge = t.running
      ? '<span class="badge running">运行中</span>'
      : t.enabled
        ? '<span class="badge on">跟踪中</span>'
        : '<span class="badge off">已暂停</span>';
    const conclusion = t.lastRun
      ? t.lastRun.conclusion
      : '创建后等待首次运行';
    const lastState = t.lastRun
      ? (t.lastRun.ok === false ? '失败' : t.lastRun.status === 'needs_review' ? '待确认' : '成功')
      : '';
    const next = t.enabled ? (t.nextRunLabel || '—').replace(/（[^）]*）/g, ' ').replace(/\s+/g, ' ').trim() : '已暂停';
    return `
      <button class="file-card track-card${t.running ? ' is-running' : ''}" data-track="${esc(t.id)}">
        <span class="file-icon tint-${iconInfo.tint}">${ic(iconInfo.icon)}</span>
        <span class="fl-body">
          <span class="fl-top"><span class="fl-title">${esc(t.targetName)}</span>${badge}</span>
          <span class="fl-meta"><span class="track-when">${esc(t.scheduleShort)}<span class="mid"> · </span>下次 ${esc(next)}</span></span>
          <span class="track-conclusion">${ic('spark', 11)}<span>${esc(conclusion)}</span></span>
          <span class="fl-track">${ic('history', 11)}${t.lastRun ? `上次 ${esc(t.lastRun.at)} · ${lastState}` : '尚未运行'}</span>
        </span>
      </button>`;
  }

  /* ---------- schedule controls ---------- */

  function scheduleControlHTML(prefix, schedule, compact = false) {
    const freq = schedule.freq || 'weekly';
    return `
      <div class="ts-seg" data-sched-seg="${prefix}">
        <button type="button" data-freq="daily" class="${freq === 'daily' ? 'is-on' : ''}">每天</button>
        <button type="button" data-freq="weekly" class="${freq === 'weekly' ? 'is-on' : ''}">每周</button>
        <button type="button" data-freq="monthly" class="${freq === 'monthly' ? 'is-on' : ''}">每月</button>
      </div>
      <div class="ts-time-row">
        <select class="ts-mini" id="${prefix}Weekday" data-sched-when="weekly" ${freq === 'weekly' ? '' : 'hidden'}>
          ${WEEKDAY_OPTIONS.map(([value, label]) => `<option value="${value}" ${Number(schedule.weekday || 1) === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="ts-mini" id="${prefix}MonthDay" data-sched-when="monthly" ${freq === 'monthly' ? '' : 'hidden'}>
          ${Array.from({ length: 28 }, (_, i) => i + 1).map(day => `<option value="${day}" ${Number(schedule.day || 1) === day ? 'selected' : ''}>${day} 日</option>`).join('')}
        </select>
        <span class="ts-at">在</span>
        <input class="ts-time" id="${prefix}Time" type="time" value="${esc(schedule.time || '09:00')}" step="60">
      </div>
      ${compact ? '' : `<p class="ts-next">下次运行 <strong id="${prefix}Next">${nextLabel(computeNextRun(schedule))}</strong><span class="ts-tz">Asia/Shanghai</span></p>`}`;
  }

  function readSchedule(prefix) {
    const seg = document.querySelector(`[data-sched-seg="${prefix}"]`);
    const active = seg ? seg.querySelector('.is-on') : null;
    const freq = active ? active.dataset.freq : 'weekly';
    const schedule = {
      freq,
      weekday: Number($(`#${prefix}Weekday`)?.value || 1),
      day: Number($(`#${prefix}MonthDay`)?.value || 1),
      time: $(`#${prefix}Time`)?.value || '09:00',
    };
    return schedule;
  }

  function updateScheduleNext(prefix) {
    const schedule = readSchedule(prefix);
    const next = $(`#${prefix}Next`);
    if (next) next.textContent = nextLabel(computeNextRun(schedule));
    return schedule;
  }

  function syncScheduleVisibility(prefix, freq) {
    const seg = document.querySelector(`[data-sched-seg="${prefix}"]`);
    const scope = seg ? seg.parentElement : document;
    $$('[data-sched-when]', scope).forEach(el => { el.hidden = el.dataset.schedWhen !== freq; });
  }

  /* ---------- setup ---------- */

  function openSetup(fileId) {
    const f = fileId ? files().find(item => item.id === fileId) : null;
    if (f) {
      const existing = getByFile(f);
      if (existing) {
        closeFile(false);
        closeTask(false);
        openDetail(existing.id);
        return;
      }
    }
    closeFile(false);
    closeTask(false);
    const seedFile = f || files().find(item => item.kind === 'output' && item.relPath) || files()[0];
    ui.setup = {
      targetId: seedFile ? seedFile.id : '',
      template: seedFile ? templateForFile(seedFile) : 'framework',
      freq: 'weekly',
      weekday: 1,
      day: 1,
      time: '09:00',
      runNow: true,
      changeTarget: !f,
    };
    if (!f) ui.setup.changeTarget = true;
    ui.lastFocus = document.activeElement;
    renderSetup();
    setupOverlay.hidden = false;
    $('#trackSetupDialog')?.focus();
  }

  function setupTargetFile() {
    return files().find(f => f.id === ui.setup?.targetId) || null;
  }

  function renderSetup() {
    if (!ui.setup) return;
    const f = setupTargetFile();
    const existing = f ? getByFile(f) : null;
    const info = templateInfo(ui.setup.template);
    const targetInfo = f ? templateInfo(ui.setup.template) : null;
    const invalidTarget = Boolean(f && targetInfo?.writeMode === 'in_place' && !String(f.relPath || '').startsWith('exports/'));
    setupOverlay.innerHTML = `
      <div class="dialog track-setup" id="trackSetupDialog" role="dialog" aria-modal="true" aria-labelledby="trackSetupTitle" tabindex="-1">
        <div class="ts-head">
          <span class="ts-mark">${ic('clock', 18)}</span>
          <div class="ts-head-text">
            <h2 id="trackSetupTitle">建立一个跟踪</h2>
            <p>选文件，设时间。更新逻辑由内置模板负责。</p>
          </div>
          <button class="icon-btn" data-setup-close aria-label="关闭">${ic('x', 16)}</button>
        </div>
        <div class="ts-body">
          <section class="ts-section">
            <div class="ts-label">跟踪文件 <span class="ts-required">必选</span></div>
            ${setupTargetHTML(f)}
            <p class="ts-hint">${setupTargetHint(f)}</p>
          </section>
          <section class="ts-section">
            <div class="ts-label">更新方式 <span class="auto-badge">${ic('spark', 10)} 自动匹配</span></div>
            <div class="tpl-pick">
              ${Object.entries(TEMPLATES).map(([key, tpl]) => `
                <button type="button" class="tpl-option${ui.setup.template === key ? ' is-on' : ''}" data-tpl="${key}">
                  <span class="tpl-icon tint-${key === 'model' ? 'green' : key === 'framework' ? 'blue' : 'yellow'}">${ic(tpl.icon, 14)}</span>
                  <span class="tpl-name">${esc(tpl.label)}<small>${esc(tpl.tag)}</small></span>
                  <span class="tpl-radio" aria-hidden="true">${ui.setup.template === key ? ic('check', 11) : ''}</span>
                </button>`).join('')}
            </div>
            <p class="ts-hint tpl-desc"><strong>${esc(info.label)}</strong> · ${esc(info.desc)}</p>
          </section>
          <section class="ts-section">
            <div class="ts-label">什么时候运行</div>
            ${scheduleControlHTML('ts', ui.setup)}
            <p class="ts-hint">唯一的必填参数。到点后自动创建一次运行，不需要你在线。</p>
          </section>
          <details class="prompt-peek">
            <summary><span>查看内置更新逻辑</span><small>参数只有时间，prompt 由模板维护</small></summary>
            <pre id="tsPrompt">${esc(info.prompt)}</pre>
          </details>
          <label class="ts-check">
            <input type="checkbox" id="tsRunNow" ${ui.setup.runNow ? 'checked' : ''}>
            <span>创建后先运行一次，看看当前结论</span>
          </label>
        </div>
        <div class="ts-foot">
          <span class="ts-foot-note">${existing ? '这个文件已有跟踪。' : '结果会生成新版本、结论和调整原因。'}</span>
          <div class="ts-foot-actions">
            <button class="btn" data-setup-cancel>取消</button>
            <button class="btn primary" data-setup-create ${existing || (f && !invalidTarget) ? '' : 'disabled'}>${existing ? '查看现有跟踪' : '开始跟踪'}</button>
          </div>
        </div>
      </div>`;
    if (existing) ui.setup.existingId = existing.id;
    else delete ui.setup.existingId;
  }

  function setupTargetHTML(f) {
    if (ui.setup.changeTarget || !f) {
      const outputs = files().filter(item => item.kind === 'output');
      const others = files().filter(item => item.kind !== 'output');
      return `
        <select class="ts-select" id="tsTargetSelect" aria-label="选择要跟踪的文件">
          <option value="">选择一个文件…</option>
          <optgroup label="产出">
            ${outputs.map(item => `<option value="${esc(item.id)}" ${item.id === ui.setup.targetId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
          </optgroup>
          <optgroup label="资料">
            ${others.map(item => `<option value="${esc(item.id)}" ${item.id === ui.setup.targetId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
          </optgroup>
        </select>`;
    }
    const iconInfo = fileIcon(f);
    return `
      <div class="ts-target">
        <span class="file-icon tint-${iconInfo.tint}">${ic(iconInfo.icon, 16)}</span>
        <span class="ts-target-main">
          <span class="ts-target-name">${esc(f.name)}</span>
          <span class="ts-target-path">${esc(f.relPath || f.path || '')}</span>
        </span>
        <span class="ver">v${fileVersion(f)}</span>
        <button type="button" class="ts-change" data-setup-change>更换</button>
      </div>`;
  }

  function setupTargetHint(f) {
    if (!f) return '从产出或资料中选择一个文件。建议从 exports/ 下的产出开始。';
    const existing = getByFile(f);
    if (existing) return `这个文件已在跟踪中 · ${existing.scheduleLabel} · 下次 ${existing.nextRunLabel || '—'}`;
    const updated = f.updatedAt ? `最后版本 ${timeAgo(f.updatedAt)}` : '最后版本未知';
    const info = templateInfo(ui.setup.template);
    if (info.writeMode === 'in_place' && !String(f.relPath || '').startsWith('exports/')) {
      return '这个文件在 uploads/ 或 inputs/，是只读的。请选择 exports/ 下的产出文件。';
    }
    if (ui.setup.template === 'model') {
      return `${updated} · Excel 原文件只读，运行后会生成更新计划和变更日志。`;
    }
    return `${updated} · 首次运行会以当前 v${fileVersion(f)} 建立基线，之后只改受影响的内容。`;
  }

  function syncSetupTemplate() {
    const f = setupTargetFile();
    const info = templateInfo(ui.setup.template);
    $$('.tpl-option', setupOverlay).forEach(btn => {
      const on = btn.dataset.tpl === ui.setup.template;
      btn.classList.toggle('is-on', on);
      const radio = $('.tpl-radio', btn);
      if (radio) radio.innerHTML = on ? ic('check', 11) : '';
    });
    const desc = $('.tpl-desc', setupOverlay);
    if (desc) desc.innerHTML = `<strong>${esc(info.label)}</strong> · ${esc(info.desc)}`;
    const prompt = $('#tsPrompt', setupOverlay);
    if (prompt) prompt.textContent = info.prompt;
    const hint = $('.ts-section .ts-hint', setupOverlay);
    if (hint) hint.textContent = setupTargetHint(f);
  }

  async function createTracking() {
    const f = setupTargetFile();
    if (!f) return;
    const existing = getByFile(f);
    if (existing) { closeSetup(); openDetail(existing.id); return; }
    const schedule = readSchedule('ts');
    const runNow = Boolean($('#tsRunNow', setupOverlay)?.checked);
    const button = $('[data-setup-create]', setupOverlay);
    if (button) {
      button.disabled = true;
      button.textContent = '创建中…';
    }
    try {
      const tracking = await api('/api/trackings', {
        method: 'POST',
        body: {
          targetId: f.id,
          templateId: ui.setup.template,
          ...schedule,
        },
      });
      closeSetup(false);
      if (typeof setFilter === 'function') setFilter('tracking');
      if (typeof setFilesOpen === 'function') setFilesOpen(true);
      upsertTracking(tracking);
      openDetail(tracking.id);
      toast('已建立跟踪');
      if (runNow) await startRun(tracking.id);
    } catch (error) {
      if (/已经在跟踪/.test(error.message || '')) {
        await loadTrackings();
        const current = getByFile(f);
        if (current) {
          closeSetup(false);
          openDetail(current.id);
          return;
        }
      }
      toast(error.message || '创建跟踪失败');
      if (button) {
        button.disabled = false;
        button.textContent = '开始跟踪';
      }
    }
  }

  function closeSetup(restoreFocus = true) {
    if (setupOverlay.hidden) return;
    setupOverlay.hidden = true;
    setupOverlay.innerHTML = '';
    if (restoreFocus && ui.lastFocus && ui.lastFocus.focus) ui.lastFocus.focus();
    ui.lastFocus = null;
  }

  /* ---------- detail ---------- */

  function openDetail(id) {
    const t = getById(id);
    if (!t) return;
    if (!setupOverlay.hidden) closeSetup(false);
    if (!scheduleOverlay.hidden) closeSchedule(false);
    closeFile(false);
    closeTask(false);
    ui.openId = id;
    ui.lastFocus = document.activeElement;
    renderDetail();
    detailOverlay.hidden = false;
    $('#trackDialog')?.focus();
    if (t.running) watchRun(id);
    if (t.template === 'framework') void loadModelInfo(id);
  }

  function closeDetail(restoreFocus = true) {
    if (detailOverlay.hidden) return;
    detailOverlay.hidden = true;
    detailOverlay.innerHTML = '';
    ui.openId = null;
    if (!scheduleOverlay.hidden) closeSchedule(false);
    if (restoreFocus && ui.lastFocus && ui.lastFocus.focus) ui.lastFocus.focus();
    ui.lastFocus = null;
    renderPanel();
  }

  function renderDetail() {
    const t = getById(ui.openId);
    if (!t) return;
    const f = targetFile(t);
    const iconInfo = f ? fileIcon(f) : { icon: templateInfo(t.template).icon, tint: 'yellow' };
    const result = t.result;
    detailOverlay.innerHTML = `
      <div class="dialog track-dialog" id="trackDialog" role="dialog" aria-modal="true" aria-labelledby="trackTitle" tabindex="-1">
        <header class="track-head">
          <span class="file-icon tint-${iconInfo.tint}">${ic(iconInfo.icon, 18)}</span>
          <div class="track-head-main">
            <div class="track-title-row">
              <h2 id="trackTitle">${esc(t.targetName)}</h2>
              ${t.running ? '<span class="badge running">运行中</span>' : t.enabled ? '<span class="badge on">跟踪中</span>' : '<span class="badge off">已暂停</span>'}
            </div>
            <p class="track-sub">${ic('clock', 12)}${esc(t.scheduleLabel)} · ${t.enabled ? `下次 ${esc(t.nextRunLabel || '—')}` : '已暂停'}${t.targetVersion || f ? ` · 目标 v${t.targetVersion ?? fileVersion(f)}` : ''}</p>
          </div>
          <div class="track-head-actions">
            ${f ? `<button class="icon-btn" data-track-open-file aria-label="打开目标文件" title="打开目标文件">${ic('external', 16)}</button>` : ''}
            <button class="icon-btn" data-track-close aria-label="关闭">${ic('x', 16)}</button>
          </div>
        </header>
        <div class="track-body">
          ${notificationsHTML(t)}
          ${t.template === 'framework' ? modelHTML(t) : ''}
          ${monitorsHTML(t)}
          ${t.running ? runningHTML(t) : resultHTML(t, result)}
        </div>
        <footer class="track-foot">
          <div class="track-foot-left">
            <button class="btn" data-track-toggle>${t.enabled ? '暂停跟踪' : '启用跟踪'}</button>
            <button class="btn" data-track-schedule>调整时间</button>
            ${(t.monitors || []).length ? `<button class="btn" data-track-check-monitors ${t.running ? 'disabled' : ''}>检查监测项</button>` : ''}
          </div>
          <div class="track-foot-right">
            <button class="btn primary" data-track-run ${t.running ? 'disabled' : ''}>${t.running ? '运行中…' : '立即运行'}</button>
          </div>
        </footer>
      </div>`;
  }

  const MONITOR_STATUS_LABEL = {
    armed: '监控中',
    warning: '接近阈值',
    triggered: '已触发',
    unknown: '缺数据',
    retired: '已归档',
  };

  async function loadModelInfo(id) {
    const t = getById(id);
    if (!t) return;
    if (t.modelInfo !== undefined) return;
    try {
      const info = await api(`/api/trackings/${id}/model`);
      const current = getById(id);
      if (!current) return;
      current.modelInfo = info;
      if (ui.openId === id) renderDetail();
    } catch (error) {
      const current = getById(id);
      if (!current) return;
      current.modelInfo = { error: error.message || '读取模型状态失败' };
      if (ui.openId === id) renderDetail();
    }
  }

  function modelHTML(t) {
    const info = t.modelInfo;
    if (!info) {
      return `<section class="track-sec"><div class="track-sec-head"><h4>模型写回</h4><span>读取中…</span></div></section>`;
    }
    if (info.error) {
      return `
        <section class="track-sec">
          <div class="track-sec-head"><h4>模型写回</h4><span>未准备</span></div>
          <div class="monitor-empty-box"><p>${esc(info.error)}</p></div>
        </section>`;
    }
    const model = info.model || {};
    const bindings = Array.isArray(model.bindings) ? model.bindings : [];
    const verified = bindings.filter(binding => binding.verified === true).length;
    const outputs = Array.isArray(model.outputs) ? model.outputs : [];
    const working = model.working_file || '';
    return `
      <section class="track-sec">
        <div class="track-sec-head"><h4>模型写回</h4><span>${model.write_enabled === true ? '已启用' : '未启用'}</span></div>
        <div class="model-box">
          <div class="model-row"><span>工作模型</span><strong>${esc(working || '尚未准备')}</strong></div>
          <div class="model-row"><span>单元格映射</span><strong>${verified} / ${bindings.length} 已确认</strong></div>
          <div class="model-row"><span>校验输出</span><strong>${outputs.map(output => output.label || `${output.sheet}!${output.cell}`).join('、') || '—'}</strong></div>
          ${model.last_applied ? `<div class="model-row"><span>最近写回</span><strong>${esc(String(model.last_applied.at || '').slice(0, 16))}</strong></div>` : ''}
          <div class="monitor-actions">
            ${working ? '' : `<button class="btn" data-track-prepare-model>准备工作模型</button>`}
            <span class="model-hint">${model.write_enabled === true ? 'Agent 可在监测触发时改写工作模型并重算' : '需要确认绑定并启用写回后，Agent 才会改模型'}</span>
          </div>
        </div>
      </section>`;
  }

  function notificationsHTML(t) {
    const items = Array.isArray(t.notifications) ? t.notifications : [];
    if (!items.length) return '';
    const labels = { info: '提示', attention: '预警', action: '待处理' };
    return `
      <section class="track-sec">
        <div class="track-sec-head"><h4>监测通知</h4><span>${items.filter(item => !item.readAt).length} 条未读 · 最近 ${items.length} 条</span></div>
        <div class="notification-list">
          ${items.map(item => `
            <article class="notification-item ${item.readAt ? '' : 'is-unread'}">
              <span class="notification-sev ${esc(item.severity || 'info')}">${esc(labels[item.severity] || item.severity || '')}</span>
              <div class="notification-main">
                <strong>${esc(item.title || '')}</strong>
                ${item.body ? `<p>${esc(item.body).slice(0, 220)}</p>` : ''}
              </div>
              <span class="notification-time">${esc(timeAgo(item.createdAt))}</span>
              ${item.runId ? `<button class="notify-undo" data-notify-undo="${esc(item.runId)}">撤销</button>` : ''}
            </article>`).join('')}
        </div>
      </section>`;
  }

  function monitorsHTML(t) {
    const items = Array.isArray(t.monitors) ? t.monitors : [];
    if (!items.length) {
      return `
        <section class="track-sec monitor-empty">
          <div class="track-sec-head"><h4>监测项</h4><span>尚未配置</span></div>
          <div class="monitor-empty-box">
            <p>把报告里的失效条件变成后台可执行的 MON 项，才能按时间和事件自动检查。可以先用对话里的“配置监测项”生成方案，再从这里同步。</p>
            <button class="btn" data-track-sync-monitors>从分析状态同步监测项</button>
          </div>
        </section>`;
    }
    return `
      <section class="track-sec">
        <div class="track-sec-head"><h4>监测项</h4><span>${items.length} 项 · 契约 v${Number(t.contractVersion || 1)}</span></div>
        <div class="monitor-list">
          ${items.map(item => {
            const next = item.nextCheckAt ? `下次 ${esc(item.nextCheckAt)}` : '事件驱动';
            return `
              <article class="monitor-item">
                <div class="monitor-top">
                  <span class="thesis-id">${esc(item.id || '')}</span>
                  <span class="monitor-thesis">→ ${esc(item.thesisId || '—')}</span>
                  <strong>${esc(item.metric || item.threshold || '')}</strong>
                  <span class="thesis-pill ${esc(item.status || 'armed')}">${esc(MONITOR_STATUS_LABEL[item.status] || item.status || '')}</span>
                </div>
                <div class="monitor-foot">
                  <span>${esc(item.frequency || '')} · ${next}</span>
                  ${item.lastObserved ? `<span>观察 ${esc(item.lastObserved)}</span>` : ''}
                  <span>${esc(item.autonomy || '')}</span>
                </div>
              </article>`;
          }).join('')}
        </div>
        <div class="monitor-actions">
          <button class="btn" data-track-refresh-events>刷新来源</button>
          <button class="btn" data-track-sync-monitors>重新同步</button>
        </div>
      </section>`;
  }

  function resultHTML(t, result) {
    if (!result) {
      const failed = t.lastRun && t.lastRun.ok === false;
      return `
        <section class="result-hero is-baseline">
          <div class="rh-top"><span class="rh-eyebrow"><span class="dot warn"></span>${failed ? '上次运行失败' : '等待首次运行'}</span></div>
          <h3>${failed ? '这次没有产生可展示的结果' : '跟踪已建立，还没有可比较的结论'}</h3>
          <p class="rh-summary">${failed ? esc(t.lastRun.conclusion || '运行失败，请查看运行记录或重试。') : `下次 ${esc(t.nextRunLabel || '—')} 会自动运行。也可以现在运行一次，先建立当前版本与假设的基线。`}</p>
          <button class="btn" data-track-run>立即运行一次</button>
        </section>`;
    }
    const deltas = result.deltas && result.deltas.length
      ? `<div class="delta-grid">${result.deltas.map(delta => `
          <div class="delta-item">
            <span class="delta-label">${esc(delta.label)}</span>
            <span class="delta-values"><span class="delta-from">${esc(delta.from)}</span>${ic('arrow-right', 12)}<strong>${esc(delta.to)}</strong></span>
            <span class="delta-note ${delta.tone || ''}">${esc(delta.note || '')}</span>
          </div>`).join('')}</div>`
      : '';
    const reasons = result.reasons && result.reasons.length
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>为什么调整</h4><span>${result.reasons.length} 条依据 · 均可追溯到来源</span></div>
          <div class="reason-list">
            ${result.reasons.map((r, i) => `
              <article class="reason">
                <span class="reason-num">0${i + 1}</span>
                <div>
                  <div class="reason-top"><span class="reason-tag">${esc(r.tag)}</span><strong>${esc(r.title)}</strong></div>
                  <p>${esc(r.detail)}</p>
                  <div class="reason-foot"><span class="reason-source">${ic('link', 11)}${esc(r.source)}</span><span class="reason-impact">→ ${esc(r.impact)}</span></div>
                </div>
              </article>`).join('')}
          </div>
        </section>`
      : '';
    const judgment = result.judgment
      ? `<section class="judgment">
          <span class="judgment-label">${ic('info', 13)}判断变化</span>
          <strong>${esc(result.judgment.title)}</strong>
          <p>${esc(result.judgment.text)}</p>
        </section>`
      : '';
    const thesisStatusLabel = { active: '成立中', weakened: '减弱', invalidated: '已失效', confirmed: '已确认', retired: '已归档' };
    const theses = result.theses && result.theses.length
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>观点状态</h4><span>${result.theses.length} 条观点 · 与状态文件对应</span></div>
          <div class="thesis-list">
            ${result.theses.map(t => `
              <article class="thesis-item">
                <div class="thesis-top">
                  <span class="thesis-id">${esc(t.id)}</span>
                  <strong>${esc(t.statement || t.id)}</strong>
                  <span class="thesis-pill ${esc(t.status)}">${esc(thesisStatusLabel[t.status] || t.status)}</span>
                </div>
                <div class="thesis-foot">
                  ${t.change ? `<span class="thesis-change">${esc(t.change)}</span>` : ''}
                  ${t.note ? `<p>${esc(t.note)}</p>` : ''}
                </div>
              </article>`).join('')}
          </div>
        </section>`
      : '';
    const triggeredInvalidations = (result.invalidations || []).filter(item => item.triggered);
    const invalidations = result.invalidations && result.invalidations.length
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>失效条件核对</h4><span>${triggeredInvalidations.length} 条触发 · 共 ${result.invalidations.length} 条</span></div>
          <div class="inval-list">
            ${result.invalidations.map(item => `
              <article class="inval-item${item.triggered ? ' is-triggered' : ''}">
                <div class="inval-top">
                  <span class="thesis-id">${esc(item.id)}</span>
                  ${item.thesis_id ? `<span class="inval-link">→ ${esc(item.thesis_id)}</span>` : ''}
                  <strong>${esc(item.condition || '')}</strong>
                  <span class="inval-pill ${item.triggered ? 'on' : 'off'}">${item.triggered ? '已触发' : '未触发'}</span>
                </div>
                <div class="inval-foot">
                  ${item.observed ? `<span class="inval-observed">观察值 ${esc(item.observed)}</span>` : ''}
                  ${item.action ? `<span class="inval-action">动作：${esc(item.action)}</span>` : ''}
                </div>
              </article>`).join('')}
          </div>
        </section>`
      : '';
    const monitorChecks = result.monitorChecks && result.monitorChecks.length
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>本次监测</h4><span>${result.monitorChecks.filter(item => item.status === 'triggered').length} 项触发 · 共 ${result.monitorChecks.length} 项</span></div>
          <div class="monitor-list">
            ${result.monitorChecks.map(item => `
              <article class="monitor-item">
                <div class="monitor-top">
                  <span class="thesis-id">${esc(item.id)}</span>
                  ${item.falsifier_id ? `<span class="monitor-thesis">→ ${esc(item.falsifier_id)}</span>` : ''}
                  <strong>${esc(item.observed || '—')}</strong>
                  <span class="thesis-pill ${esc(item.status || 'unknown')}">${esc(MONITOR_STATUS_LABEL[item.status] || item.status || '')}</span>
                </div>
                ${item.note ? `<div class="monitor-foot"><span>${esc(item.note)}</span></div>` : ''}
              </article>`).join('')}
          </div>
        </section>`
      : '';
    const wb = result.writeback;
    const wbChanges = wb && wb.changes && wb.changes.length
      ? `<details class="wb-details">
          <summary>查看 ${wb.changes.length} 处具体变更 <span class="wb-chev">${ic('chevron-down', 13)}</span></summary>
          <div class="wb-table">
            <div class="wb-row wb-head-row"><span>位置</span><span>原值</span><span>新值</span><span>变化</span></div>
            ${wb.changes.map(c => `<div class="wb-row"><span>${esc(c.where)}</span><span>${esc(c.from)}</span><strong>${esc(c.to)}</strong><span>${esc(c.note)}</span></div>`).join('')}
          </div>
        </details>`
      : '';
    const writeback = wb
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>写回了什么</h4><span>${esc(wb.stats)}</span></div>
          <div class="writeback">
            <div class="wb-head">
              <span class="badge ${wb.mode.includes('只读') ? 'off' : 'on'}">${esc(wb.version)}</span>
              <strong>${esc(wb.mode)}</strong>
            </div>
            <p>${esc(wb.note)}</p>
            ${wbChanges}
          </div>
        </section>`
      : '';
    const sources = result.sources && result.sources.length
      ? `<section class="track-sec">
          <div class="track-sec-head"><h4>数据与来源</h4><span>截止 ${esc((result.asOf || '').slice(0, 10))}</span></div>
          <div class="sources-row">
            ${result.sources.map(s => `<span class="source-chip">${ic('database', 12)}<span>${esc(s.label)}</span><em>${esc(s.date)}</em></span>`).join('')}
          </div>
          ${result.notUsed && result.notUsed.length ? `<p class="not-used">未使用：${result.notUsed.map(esc).join('、')}</p>` : ''}
        </section>`
      : '';
    const hasNewerCheck = Boolean(t.lastCheck && result.asOf && t.lastCheck.full > result.asOf);
    const isReview = result.status === 'needs_review';
    const isNoChange = result.status === 'no_change';
    const checkStrip = hasNewerCheck
      ? `<div class="check-strip">
          <span class="status-dot ok"></span>
          <span>最近一次检查 ${esc(t.lastCheck.at)} · 无重大变化</span>
          <em>下面保留最近一次有调整的结论（${esc(String(result.asOf).slice(0, 10))}）</em>
        </div>`
      : '';
    const eyebrow = hasNewerCheck ? '最近一次调整' : isReview ? '等待确认' : isNoChange ? '本期检查' : '本期结论';
    return `
      ${checkStrip}
      <section class="result-hero">
        <div class="rh-top">
          <span class="rh-eyebrow"><span class="dot ${isReview ? 'warn' : 'ok'}"></span>${eyebrow}</span>
          <span class="rh-meta">${esc(result.asOf || '')} · ${esc(result.duration || '')}${result.confidence ? ` · 置信度 ${esc(result.confidence)}` : ''}</span>
        </div>
        <h3>${esc(result.headline || result.conclusion)}</h3>
        <p class="rh-summary">${esc(result.summary)}</p>
        ${deltas}
      </section>
      ${theses}
      ${invalidations}
      ${monitorChecks}
      ${judgment}
      ${reasons}
      ${writeback}
      ${sources}
      ${runHistoryHTML(t)}`;
  }

  function runHistoryHTML(t) {
    if (!t.runs || !t.runs.length) return '';
    return `
      <section class="track-sec">
        <div class="track-sec-head"><h4>运行记录</h4><span>共 ${t.runs.length} 次</span></div>
        <div class="run-history">
          ${t.runs.slice(0, 5).map((run, i) => `
            <div class="run-item${i === 0 ? ' is-latest' : ''}">
              <span class="status-dot ${run.ok === false ? 'warn' : run.status === 'needs_review' ? 'warn' : 'ok'}"></span>
              <span class="run-when">${esc(run.at)}</span>
              <span class="run-conclusion">${esc(run.conclusion)}</span>
              <span class="run-ver">${run.version ? `v${run.version}` : '—'}</span>
            </div>`).join('')}
        </div>
      </section>`;
  }

  const RUN_STEPS = [
    '读取目标文件与上次基线',
    '拉取最新财务、行情与同行数据',
    '对比原假设，定位受影响预测',
    '更新文件并生成结论与调整原因',
  ];

  function runningHTML(t) {
    return `
      <div class="run-banner">
        <span class="run-spinner" aria-hidden="true"></span>
        <div class="run-banner-main">
          <strong>正在更新跟踪文件</strong>
          <p id="runStepText">${RUN_STEPS[0]}…</p>
        </div>
        <span class="run-elapsed" id="runElapsed">00:00</span>
      </div>
      <ol class="run-steps" id="runSteps">
        ${RUN_STEPS.map((step, i) => `<li data-run-step="${i}" class="${i === 0 ? 'is-active' : ''}"><span class="run-step-dot">${i + 1}</span><span>${step}</span></li>`).join('')}
      </ol>
      <p class="run-hint">运行在服务端完成，通常需要 1–3 分钟。关闭这个窗口不会中断；完成后可以在运行记录里看到结果。</p>`;
  }

  function updateRunUI(t) {
    const elapsed = $('#runElapsed');
    if (!elapsed) return;
    const seconds = Math.max(0, Math.floor((Date.now() - (t.runStartedAt || Date.now())) / 1000));
    elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const step = t.runStep || 0;
    $$('[data-run-step]', detailOverlay).forEach(el => {
      const index = Number(el.dataset.runStep);
      el.classList.toggle('is-active', index === step);
      el.classList.toggle('is-done', index < step);
    });
    const label = $('#runStepText');
    if (label) label.textContent = `${RUN_STEPS[step]}…`;
  }

  async function syncMonitors() {
    const t = getById(ui.openId);
    if (!t) return;
    const button = $('[data-track-sync-monitors]', detailOverlay);
    if (button) {
      button.disabled = true;
      button.textContent = '同步中…';
    }
    try {
      const result = await api(`/api/trackings/${t.id}/monitors/activate`, {
        method: 'POST',
        body: {},
      });
      const fresh = await api(`/api/trackings/${t.id}`);
      upsertTracking(fresh);
      if (ui.openId === t.id) renderDetail();
      toast(result.items?.length ? `已同步 ${result.items.length} 个监测项` : '状态文件里还没有可同步的失效条件');
    } catch (error) {
      toast(error.message || '同步监测项失败');
      if (button) {
        button.disabled = false;
        button.textContent = '从分析状态同步监测项';
      }
    }
  }

  async function prepareModel() {
    const t = getById(ui.openId);
    if (!t) return;
    const button = $('[data-track-prepare-model]', detailOverlay);
    if (button) {
      button.disabled = true;
      button.textContent = '准备中…';
    }
    try {
      await api(`/api/trackings/${t.id}/model/prepare`, { method: 'POST', body: {} });
      const current = getById(t.id);
      if (current) delete current.modelInfo;
      if (ui.openId === t.id) {
        await loadModelInfo(t.id);
        renderDetail();
      }
      toast('工作模型已准备');
    } catch (error) {
      toast(error.message || '准备工作模型失败');
      if (button) {
        button.disabled = false;
        button.textContent = '准备工作模型';
      }
    }
  }

  async function refreshEvents() {
    const t = getById(ui.openId);
    if (!t) return;
    try {
      const result = await api(`/api/trackings/${t.id}/events/refresh`, { method: 'POST', body: {} });
      const created = (result.results || []).reduce((sum, item) => sum + (Number(item.events) || 0), 0);
      toast(created ? `新增 ${created} 条来源事件` : '没有新的来源事件');
      await loadTrackings();
      if (ui.openId === t.id) renderDetail();
    } catch (error) {
      toast(error.message || '刷新来源失败');
    }
  }

  async function undoRun(runId) {
    if (!runId) return;
    try {
      await api(`/api/runs/${encodeURIComponent(runId)}/undo`, { method: 'POST' });
      await loadTrackings();
      if (ui.openId) renderDetail();
      toast('已撤销这次更新');
    } catch (error) {
      toast(error.message || '撤销失败');
    }
  }

  async function checkMonitors() {
    const t = getById(ui.openId);
    if (!t || t.running) return;
    t.running = true;
    t.runStep = 0;
    t.runStartedAt = Date.now();
    renderDetail();
    renderPanel();
    try {
      const result = await api(`/api/trackings/${t.id}/monitors/check`, {
        method: 'POST',
        body: {},
      });
      if (result.tracking) upsertTracking(result.tracking);
      watchRun(t.id);
    } catch (error) {
      const current = getById(t.id);
      if (current) current.running = false;
      if (ui.openId === t.id) renderDetail();
      renderPanel();
      toast(error.message || '启动监测检查失败');
    }
  }

  async function startRun(id) {
    const t = getById(id);
    if (!t || t.running) return;
    t.running = true;
    t.runStep = 0;
    t.runStartedAt = Date.now();
    if (ui.openId === id) renderDetail();
    renderPanel();
    try {
      const result = await api(`/api/trackings/${id}/run`, { method: 'POST' });
      if (result.tracking) upsertTracking(result.tracking);
      if (result.tracking?.running !== false) watchRun(id);
    } catch (error) {
      const current = getById(id);
      if (current) current.running = false;
      if (ui.openId === id) renderDetail();
      renderPanel();
      toast(error.message || '启动跟踪失败');
    }
  }

  function watchRun(id) {
    if (ui.runTimers.has(id)) return;
    const current = getById(id);
    if (current && current.runStep === undefined) current.runStep = 0;
    if (current && !current.runStartedAt) current.runStartedAt = Date.now();
    const timers = {};
    timers.stepTimer = window.setInterval(() => {
      const tracking = getById(id);
      if (!tracking || !tracking.running) {
        clearRunWatcher(id);
        return;
      }
      if ((tracking.runStep || 0) < RUN_STEPS.length - 1) {
        tracking.runStep = (tracking.runStep || 0) + 1;
        updateRunUI(tracking);
      } else {
        updateRunUI(tracking);
      }
    }, 1800);
    timers.pollTimer = window.setInterval(async () => {
      try {
        const tracking = await api(`/api/trackings/${id}`);
        upsertTracking(tracking);
        if (!tracking.running) clearRunWatcher(id);
      } catch {
        /* the SSE stream is the primary update channel; polling is a fallback */
      }
    }, 3000);
    ui.runTimers.set(id, timers);
  }

  function clearRunWatcher(id) {
    const timers = ui.runTimers.get(id);
    if (!timers) return;
    window.clearInterval(timers.stepTimer);
    window.clearInterval(timers.pollTimer);
    ui.runTimers.delete(id);
  }

  /* ---------- schedule editor ---------- */

  function openSchedule() {
    const t = getById(ui.openId);
    if (!t) return;
    ui.scheduleDraft = { ...t.schedule };
    renderSchedule();
    scheduleOverlay.hidden = false;
    $('#trackScheduleDialog')?.focus();
  }

  function renderSchedule() {
    const t = getById(ui.openId);
    if (!t || !ui.scheduleDraft) return;
    scheduleOverlay.innerHTML = `
      <div class="dialog track-schedule" id="trackScheduleDialog" role="dialog" aria-modal="true" aria-labelledby="trackScheduleTitle" tabindex="-1">
        <div class="ts-head is-compact">
          <span class="ts-mark">${ic('clock', 17)}</span>
          <div class="ts-head-text">
            <h2 id="trackScheduleTitle">调整运行时间</h2>
            <p>${esc(t.targetName)} · 只改时间，更新逻辑不变</p>
          </div>
          <button class="icon-btn" data-schedule-close aria-label="关闭">${ic('x', 15)}</button>
        </div>
        <div class="ts-body">
          <section class="ts-section is-first">
            <div class="ts-label">什么时候运行</div>
            ${scheduleControlHTML('sc', ui.scheduleDraft, true)}
          </section>
          <p class="ts-hint">下次运行：<strong id="scNext2">${nextLabel(computeNextRun(ui.scheduleDraft))}</strong></p>
        </div>
        <div class="ts-foot">
          <span class="ts-foot-note">保存后立即生效</span>
          <div class="ts-foot-actions">
            <button class="btn" data-schedule-cancel>取消</button>
            <button class="btn primary" data-schedule-save>保存</button>
          </div>
        </div>
      </div>`;
  }

  async function saveSchedule() {
    const t = getById(ui.openId);
    if (!t) return;
    const schedule = readSchedule('sc');
    try {
      const updated = await api(`/api/trackings/${t.id}/schedule`, {
        method: 'PATCH',
        body: schedule,
      });
      upsertTracking(updated);
      closeSchedule(false);
      renderDetail();
      toast('运行时间已更新');
    } catch (error) {
      toast(error.message || '保存运行时间失败');
    }
  }

  function closeSchedule(restoreFocus = true) {
    if (scheduleOverlay.hidden) return;
    scheduleOverlay.hidden = true;
    scheduleOverlay.innerHTML = '';
    ui.scheduleDraft = null;
    if (restoreFocus && ui.lastFocus && ui.lastFocus.focus) ui.lastFocus.focus();
  }

  /* ---------- actions ---------- */

  async function toggleTracking() {
    const t = getById(ui.openId);
    if (!t) return;
    try {
      const updated = await api(`/api/trackings/${t.id}/toggle`, { method: 'POST' });
      upsertTracking(updated);
      toast(updated.enabled ? '已启用跟踪' : '已暂停跟踪');
    } catch (error) {
      toast(error.message || '操作失败');
    }
  }

  function resultVersion(t) {
    const raw = t?.result?.target?.result_version
      ?? t?.lastRun?.version
      ?? t?.result?.writeback?.version;
    const value = Number(String(raw ?? '').replace(/[^\d]/g, ''));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  function openTargetFile() {
    const t = getById(ui.openId);
    const f = targetFile(t);
    if (!f) return;
    const version = resultVersion(t);
    closeDetail(false);
    if (typeof openFile === 'function') openFile(f.id, version);
  }

  /* ---------- wiring ---------- */

  function isOpen() {
    return !detailOverlay.hidden || !setupOverlay.hidden || !scheduleOverlay.hidden;
  }

  function activeDialog() {
    if (!scheduleOverlay.hidden) return $('#trackScheduleDialog');
    if (!setupOverlay.hidden) return $('#trackSetupDialog');
    if (!detailOverlay.hidden) return $('#trackDialog');
    return null;
  }

  function closeTop() {
    if (!scheduleOverlay.hidden) { closeSchedule(); return; }
    if (!setupOverlay.hidden) { closeSetup(); return; }
    if (!detailOverlay.hidden) closeDetail();
  }

  function wire() {
    if (ui.wired) return;
    ui.wired = true;

    $('#newTrackBtn')?.addEventListener('click', () => openSetup());
    $('#fileList')?.addEventListener('click', e => {
      const track = e.target.closest('[data-track]');
      if (track) { e.preventDefault(); openDetail(track.dataset.track); return; }
      if (e.target.closest('[data-track-new]')) { openSetup(); return; }
      if (e.target.closest('[data-track-retry]')) {
        loadTrackings().then(() => renderPanel()).catch((error) => {
          ui.error = error.message || '加载跟踪失败';
          renderPanel();
        });
      }
    });
    $('#dTrack')?.addEventListener('click', () => {
      const trackId = $('#dTrack').dataset.track;
      if (trackId) openDetail(trackId);
    });

    setupOverlay.addEventListener('click', e => {
      if (e.target === setupOverlay) { closeSetup(); return; }
      if (e.target.closest('[data-setup-close], [data-setup-cancel]')) { closeSetup(); return; }
      if (e.target.closest('[data-setup-change]')) {
        ui.setup.changeTarget = true;
        renderSetup();
        return;
      }
      const tpl = e.target.closest('[data-tpl]');
      if (tpl) {
        ui.setup.template = tpl.dataset.tpl;
        syncSetupTemplate();
        return;
      }
      const freq = e.target.closest('[data-freq]');
      if (freq) {
        ui.setup.freq = freq.dataset.freq;
        $$('[data-freq]', setupOverlay).forEach(b => b.classList.toggle('is-on', b === freq));
        syncScheduleVisibility('ts', freq.dataset.freq);
        const schedule = updateScheduleNext('ts');
        if (schedule.freq === 'weekly') ui.setup.weekday = schedule.weekday;
        if (schedule.freq === 'monthly') ui.setup.day = schedule.day;
        refreshHintForSchedule();
        return;
      }
      if (e.target.closest('[data-setup-create]')) { createTracking(); return; }
    });

    setupOverlay.addEventListener('change', e => {
      if (e.target.id === 'tsTargetSelect') {
        ui.setup.targetId = e.target.value;
        ui.setup.changeTarget = false;
        const f = setupTargetFile();
        if (f) ui.setup.template = templateForFile(f);
        renderSetup();
        return;
      }
      if (['tsWeekday', 'tsMonthDay', 'tsTime'].includes(e.target.id)) {
        const schedule = updateScheduleNext('ts');
        Object.assign(ui.setup, schedule);
        refreshHintForSchedule();
        return;
      }
      if (e.target.id === 'tsRunNow') ui.setup.runNow = e.target.checked;
    });

    setupOverlay.addEventListener('input', e => {
      if (e.target.id === 'tsTime') {
        const schedule = updateScheduleNext('ts');
        Object.assign(ui.setup, schedule);
      }
    });

    detailOverlay.addEventListener('click', e => {
      if (e.target === detailOverlay) { closeDetail(); return; }
      if (e.target.closest('[data-track-close]')) { closeDetail(); return; }
      if (e.target.closest('[data-track-open-file]')) { openTargetFile(); return; }
      if (e.target.closest('[data-track-toggle]')) { toggleTracking(); return; }
      if (e.target.closest('[data-track-schedule]')) { openSchedule(); return; }
      if (e.target.closest('[data-track-sync-monitors]')) { syncMonitors(); return; }
      if (e.target.closest('[data-track-prepare-model]')) { prepareModel(); return; }
      const undo = e.target.closest('[data-notify-undo]');
      if (undo) { e.stopPropagation(); undoRun(undo.dataset.notifyUndo); return; }
      if (e.target.closest('[data-track-check-monitors]')) { checkMonitors(); return; }
      if (e.target.closest('[data-track-refresh-events]')) { refreshEvents(); return; }
      if (e.target.closest('[data-track-run]')) { startRun(ui.openId); return; }
    });

    scheduleOverlay.addEventListener('click', e => {
      if (e.target === scheduleOverlay) { closeSchedule(); return; }
      if (e.target.closest('[data-schedule-close], [data-schedule-cancel]')) { closeSchedule(); return; }
      if (e.target.closest('[data-schedule-save]')) { saveSchedule(); return; }
      const freq = e.target.closest('[data-freq]');
      if (freq) {
        ui.scheduleDraft = readSchedule('sc');
        ui.scheduleDraft.freq = freq.dataset.freq;
        $$('[data-freq]', scheduleOverlay).forEach(b => b.classList.toggle('is-on', b === freq));
        syncScheduleVisibility('sc', freq.dataset.freq);
        const next = $('#scNext');
        if (next) next.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
        const next2 = $('#scNext2');
        if (next2) next2.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
        return;
      }
    });

    scheduleOverlay.addEventListener('change', e => {
      if (['scWeekday', 'scMonthDay', 'scTime'].includes(e.target.id)) {
        ui.scheduleDraft = readSchedule('sc');
        const next = $('#scNext');
        if (next) next.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
        const next2 = $('#scNext2');
        if (next2) next2.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
      }
    });
    scheduleOverlay.addEventListener('input', e => {
      if (e.target.id === 'scTime') {
        ui.scheduleDraft = readSchedule('sc');
        const next = $('#scNext');
        if (next) next.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
        const next2 = $('#scNext2');
        if (next2) next2.textContent = nextLabel(computeNextRun(ui.scheduleDraft));
      }
    });

    document.addEventListener('keydown', e => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTop();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = activeDialog();
      if (!dialog) return;
      const nodes = $$('button, [href], input, select, [tabindex]:not([tabindex="-1"])', dialog).filter(n => !n.disabled && !n.hidden);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (document.activeElement === dialog) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }, true);
  }

  function refreshHintForSchedule() {
    const f = setupTargetFile();
    const hint = $('.ts-section .ts-hint', setupOverlay);
    if (hint) hint.textContent = setupTargetHint(f);
  }

  function reset() {
    ui.trackings = [];
    ui.loaded = false;
    ui.error = '';
    ui.openId = null;
    ui.runTimers.forEach((timers) => {
      window.clearInterval(timers.stepTimer);
      window.clearInterval(timers.pollTimer);
    });
    ui.runTimers.clear();
    closeTop();
  }

  function init() {
    if (ui.initPromise) return ui.initPromise;
    ui.initPromise = (async () => {
      wire();
      updateFilterCount();
      renderPanel();
      try {
        await loadTrackings();
      } catch (error) {
        ui.error = error.message || '加载跟踪失败';
      }
      renderPanel();
      if (typeof window.__peRenderPanel === 'function') window.__peRenderPanel();
      const hash = location.hash;
      const detailMatch = hash.match(/^#track=([^&]+)/);
      if (detailMatch) {
        window.setTimeout(() => openDetail(decodeURIComponent(detailMatch[1])), 60);
      }
      const setupMatch = hash.match(/^#track-setup(?:=([^&]+))?/);
      if (setupMatch) {
        window.setTimeout(() => openSetup(setupMatch[1] ? decodeURIComponent(setupMatch[1]) : null), 60);
      }
    })();
    return ui.initPromise;
  }

  window.Tracking = {
    init,
    renderPanel,
    openSetup,
    openDetail,
    getByFile,
    count,
    isOpen,
    activeDialog,
    closeTop,
    updateFilterCount,
    list: () => ui.trackings,
    upsert: upsertTracking,
    remove: removeTracking,
    reload: loadTrackings,
    reset,
  };

  // app.js calls init() after the workbench boot sequence so state.files and
  // the tracker API are both ready.
})();
