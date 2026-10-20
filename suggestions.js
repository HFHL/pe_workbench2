/* Workbench — contextual next-step suggestions above the composer.
   Rule-based on purpose: immediate, deterministic, no extra model call per keystroke.
   Every suggestion carries a ready-to-edit prompt; clicking only fills the input. */

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ic = (name, size = 16) =>
    `<svg class="i" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s = '') =>
    String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MAX = 3;
  const ui = {
    suggestions: [],
    signature: '',
    renderedSignature: '',
    dismissed: '',
    initialized: false,
  };

  const ext = name => (String(name).split('.').pop() || '').toLowerCase();
  const base = rel => String(rel || '').split('/').pop();
  const dir = rel => {
    const parts = String(rel || '').split('/');
    parts.pop();
    return parts.join('/');
  };
  const isModel = f => ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext(f?.name));
  const isMarket = f => /\.md$/i.test(f?.name || '') && /(同行|行情|peer|market)/i.test(`${f.name} ${f.relPath || ''}`);
  const isState = f => /analysis-state\.json$/i.test(f?.name || '');
  const isReport = f => {
    if (!/\.(md|markdown)$/i.test(f?.name || '')) return false;
    if (isMarket(f)) return false;
    return /(投资框架|框架|投资报告|研究报告|framework|report)/i.test(`${f.name} ${f.relPath || ''}`);
  };
  const isText = f => /\.(md|markdown|txt)$/i.test(f?.name || '');
  const isAudio = f => ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext(f?.name));

  function files() {
    return Array.isArray(state.files) ? state.files : [];
  }

  function pending() {
    return Array.isArray(state.pending) ? state.pending : [];
  }

  function previewText(f) {
    const version = f?.versions?.[0];
    if (version?.preview?.type === 'text') return version.preview.text || '';
    return '';
  }

  function parseJsonPreview(f) {
    try {
      return JSON.parse(previewText(f));
    } catch {
      return null;
    }
  }

  function findByRel(rel) {
    if (!rel) return null;
    const all = files();
    const clean = String(rel).replace(/^(?:agent-workspace|projects\/[^/]+)[\\/]/, '').split('\\').join('/');
    return all.find(f => f.relPath === clean)
      || all.find(f => String(f.relPath || '').endsWith(`/${clean}`))
      || all.find(f => f.name === base(clean))
      || null;
  }

  function trackingFor(f) {
    return f ? (window.Tracking?.getByFile?.(f) || null) : null;
  }

  function updatedAt(f) {
    const value = f?.updatedAt || f?.versions?.[0]?.createdAt;
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function ageDays(f) {
    const date = updatedAt(f);
    if (!date) return Number.POSITIVE_INFINITY;
    return Math.max(0, (Date.now() - date.getTime()) / 86400000);
  }

  function recencyScore(f) {
    const days = ageDays(f);
    if (days < 1) return 10;
    if (days < 7) return 6;
    if (days < 30) return 2;
    return 0;
  }

  function lastTouchedFile() {
    const all = files();
    const messages = Array.isArray(state.messages) ? state.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const tools = messages[i]?.tools || [];
      for (let j = tools.length - 1; j >= 0; j -= 1) {
        const tool = tools[j];
        if (!['read', 'write', 'edit', 'workbook_query', 'asr_read'].includes(tool?.name)) continue;
        const detail = String(tool.detail || '');
        if (!detail) continue;
        const matched = all.find(f => detail.includes(f.relPath || '') || detail.endsWith(f.name));
        if (matched) return matched;
      }
    }
    return null;
  }

  function groupScore(group, lastTouched, pendingIds) {
    const members = [group.model, group.stateFile, group.report, group.market].filter(Boolean);
    if (!members.length) return 0;
    let score = Math.max(...members.map(recencyScore));
    if (members.some(f => pendingIds.has(f.id))) score += 40;
    if (lastTouched && members.some(f => f.id === lastTouched.id)) score += 30;
    if (group.report && trackingFor(group.report)) score += 4;
    return score;
  }

  function buildGroups() {
    const known = files();
    const pendingOnly = pending().filter(item => !known.some(f => f.id === item.id));
    const all = [...known, ...pendingOnly];
    const groups = new Map();

    for (const stateFile of all.filter(isState)) {
      const parsed = parseJsonPreview(stateFile);
      const folder = dir(stateFile.relPath);
      const modelRel = parsed?.model?.files?.[0]?.absolute_path || parsed?.subject?.model_file;
      const model = findByRel(modelRel);
      const siblings = all.filter(f => dir(f.relPath) === folder);
      const report = siblings.find(isReport) || null;
      const market = siblings.find(isMarket) || null;
      groups.set(folder, {
        key: folder,
        folder,
        subject: parsed?.subject?.company || base(folder) || '这个标的',
        stateFile,
        model,
        report,
        market,
      });
    }

    for (const model of all.filter(isModel)) {
      if ([...groups.values()].some(group => group.model?.id === model.id)) continue;
      const folder = dir(model.relPath);
      const siblings = all.filter(f => dir(f.relPath) === folder);
      groups.set(`model:${model.relPath}`, {
        key: `model:${model.relPath}`,
        folder,
        subject: model.name.replace(/\.[^.]+$/, ''),
        stateFile: null,
        model,
        report: siblings.find(isReport) || null,
        market: siblings.find(isMarket) || null,
      });
    }

    for (const report of all.filter(isReport)) {
      if ([...groups.values()].some(group => group.report?.id === report.id)) continue;
      const folder = dir(report.relPath);
      const siblings = all.filter(f => dir(f.relPath) === folder);
      groups.set(`report:${report.relPath}`, {
        key: `report:${report.relPath}`,
        folder,
        subject: base(folder) || report.name,
        stateFile: siblings.find(isState) || null,
        model: siblings.find(isModel) || null,
        report,
        market: siblings.find(isMarket) || null,
      });
    }

    for (const market of all.filter(isMarket)) {
      if ([...groups.values()].some(group => group.market?.id === market.id)) continue;
      groups.set(`market:${market.relPath}`, {
        key: `market:${market.relPath}`,
        folder: dir(market.relPath),
        subject: base(dir(market.relPath)) || market.name,
        stateFile: null,
        model: null,
        report: null,
        market,
      });
    }

    return [...groups.values()].slice(0, 12);
  }

  function promptFor(group, kind) {
    const subject = group.subject;
    const folder = group.folder;
    const report = group.report;
    const model = group.model;
    const stateFile = group.stateFile;
    const market = group.market;
    const reportPath = report?.relPath || `${folder}/投资框架报告.md`;
    const targetFolder = folder && folder.startsWith('exports/') ? folder : `exports/investment-model/${subject}`;

    switch (kind) {
      case 'analyze-model':
        return `请解读估值模型 \`${model.relPath}\`，复现目标价和关键预测；把核心假设拆到公式和业务条件（如分地区增长、量价/产能、行情周期），做公式级敏感性，并结合行业、同行和截至今天的最新行情形成七节投资框架。同时把结论落成可跟踪的状态文件 \`${targetFolder}/analysis-state.json\`：观点 T1–Tn、假设 A、敏感性 S、失效条件 F 一一关联，每个观点至少一条可观测的失效条件。报告写到 \`${targetFolder}/投资框架报告.md\`，先给结论，再给观点台账、敏感性、失效条件与监控。`;
      case 'build-framework':
        return `请读取 \`${stateFile.relPath}\` 中的假设、观点、证据和缺口，沿用稳定 ID 生成七节投资框架报告，写到 \`${targetFolder}/投资框架报告.md\`。补齐每个观点的正反证据、替代解释和至少一条带阈值、来源、频率、触发动作的失效条件；同步更新 \`${targetFolder}/analysis-state.json\`，不要丢掉未受影响的判断。`;
      case 'update-framework':
        return market
          ? `请复核 \`${reportPath}\`：先读同目录的 \`analysis-state.json\`，对比 \`${market.relPath}\` 的最新行情与原假设，用截至今天的最新财务、行情和同行数据逐条核对失效条件（指标、阈值、来源、频率），只在证据支持时改变观点状态，只更新受影响的小节和状态文件；说明哪些观点维持、降级或失效，哪些失效条件被触发。`
          : `请复核 \`${reportPath}\`：先读同目录的 \`analysis-state.json\`，用截至今天的最新财务、行情和同行数据逐条核对失效条件（指标、阈值、来源、频率），只在证据支持时改变观点状态，只更新受影响的小节和状态文件；说明哪些观点维持、降级或失效，哪些失效条件被触发。`;
      case 'track-assess':
        return `请评估 \`${reportPath}\` 是否适合纳入定期跟踪：读同目录的 \`analysis-state.json\`，按失效条件的来源与频率给出建议运行频率、每轮要核对的指标、触发后的动作和缺数据项。先不要修改文件。`;
      case 'backfill-state':
        return `请加载 investment-framework Skill 的“补建状态”流程：读取 \`${reportPath}\`，只抽取报告里明确写过的观点、假设、敏感性、失效条件和证据，生成同目录的 \`analysis-state.json\`。保留报告的 ID 与结构，不重写结论；抽出来的证据标 kind=inference，stage=draft，并在 review.notes 写明“由报告回溯补建”。完成后告诉我需要人工核对哪些项。`;
      case 'check-tracking': {
        const tracking = trackingFor(report);
        const when = tracking?.nextRunLabel ? `下次运行 ${tracking.nextRunLabel}` : '查看最近一次跟踪结果';
        return `请读取 \`${reportPath}\` 最近一次跟踪记录和当前版本，用 3 句话告诉我：结论有没有变、关键变化是什么、是否需要调整。${when ? `（${when}）` : ''}`;
      }
      case 'setup-monitoring': {
        const tracking = trackingFor(report);
        const statePath = stateFile?.relPath || `${dir(reportPath)}/analysis-state.json`;
        return `请加载 monitoring-setup Skill，读取 \`${statePath}\` 和 \`${reportPath}\`${tracking ? `（跟踪已建立：${tracking.scheduleLabel || '已启用'}）` : ''}。把报告第 6 节的失效条件整理成 MON 监测项：每项给出关联观点、指标、来源、频率、预警阈值、失效阈值、触发动作和默认自治级别；先做一次试取数，取不到的标 unknown。把方案和缺数据项列清楚让我确认，不要直接激活，也不要改模型。`;
      }
      case 'model-actuals':
        return `请检查 \`${model.relPath}\` 里哪些预测现在已经有确定的实际值可以替换，列出变更计划、影响链和需要人工确认的项。不要直接修改 xlsx，按工作台只读边界处理。`;
      case 'refresh-market':
        return `请用最新行情数据刷新 \`${market.relPath}\`，更新数据日期和关键价格，并对比 ${report ? `\`${reportPath}\` 的目标价假设` : '模型的目标价假设'}，指出是否出现偏离。`;
      case 'audio-notes':
        if (group.file?.asr?.status === 'done') {
          return `请用 asr_read 读取音频 \`${group.file.relPath}\` 的转写全文，整理成会议纪要：先给 3 条结论，再列讨论要点、已达成的决定、待办事项和负责人；信息不足的地方标注“待确认”。完整纪要写到 \`exports/录音纪要/${group.subject || '录音'}-纪要.md\`。`;
        }
        return `请用 asr_read 检查音频 \`${group.file?.relPath}\` 的转写状态：如果已完成，提炼 3–5 条要点和待办；如果还在转写，只告诉我当前进度，不要猜测音频内容。`;
      case 'explain':
        if (isAudio(group.file)) {
          return `请用 asr_read 读取音频 \`${group.file.relPath}\` 的转写内容，用 3 句话说明这段录音的主题、关键结论和下一步最值得做什么；如果还没有转写完成，只报告状态。`;
        }
        return `请快速解读 \`${group.file?.relPath || reportPath}\`，用 3 句话说明它是什么、关键结论是什么、下一步最值得做什么。`;
      default:
        return '';
    }
  }

  function addCandidate(list, group, kind, icon, tint, label, detail, base, lastTouched, pendingIds) {
    const prompt = promptFor(group, kind);
    if (!prompt) return;
    const subject = String(group.subject || '').replace(/（[^）]*）/g, '').trim();
    const detailText = subject ? `${subject} · ${detail}` : detail;
    list.push({
      id: `${kind}:${group.key}`,
      kind,
      group: group.key,
      icon,
      tint,
      label,
      detail: detailText,
      prompt,
      score: base + groupScore(group, lastTouched, pendingIds),
    });
  }

  function buildSuggestions() {
    const lastTouched = lastTouchedFile();
    const pendingIds = new Set(pending().map(f => f.id));
    const allGroups = buildGroups();
    const activeGroups = allGroups.filter((group) => {
      const members = [group.model, group.stateFile, group.report, group.market].filter(Boolean);
      return Boolean(
        group.report
        || group.stateFile
        || group.market
        || members.some(f => pendingIds.has(f.id))
        || (lastTouched && members.some(f => f.id === lastTouched.id)),
      );
    });
    const groups = activeGroups.length ? activeGroups : allGroups;
    const list = [];

    for (const group of groups) {
      const report = group.report;
      const model = group.model;
      const stateFile = group.stateFile;
      const market = group.market;
      const tracking = report ? trackingFor(report) : null;
      const reportOlderThanMarket = report && market && updatedAt(report) && updatedAt(market)
        && updatedAt(report) < updatedAt(market);
      const marketStale = market ? ageDays(market) > 1 : false;

      if (model && !stateFile && !report) {
        addCandidate(list, group, 'analyze-model', 'grid', 'green', '形成投资框架', '解读模型，复现目标价', 46, lastTouched, pendingIds);
      }
      if (stateFile && !report) {
        addCandidate(list, group, 'build-framework', 'spark', 'blue', '生成投资框架', '基于已有分析状态', 44, lastTouched, pendingIds);
      }
      if (report) {
        addCandidate(list, group, 'update-framework', 'refresh', 'yellow', reportOlderThanMarket ? '用最新行情复核' : '复核投资框架', reportOlderThanMarket ? '行情已更新，检查原假设' : '对比新数据与原假设', 30 + (reportOlderThanMarket ? 14 : 0), lastTouched, pendingIds);
        if (!stateFile) {
          addCandidate(list, group, 'backfill-state', 'layers', 'blue', '补建分析状态', '让报告可被跟踪', 28, lastTouched, pendingIds);
        }
        if (!tracking) {
          addCandidate(list, group, 'track-assess', 'clock', 'yellow', '评估是否跟踪', '给出频率与监控指标', 26, lastTouched, pendingIds);
        } else {
          const monitorCount = Array.isArray(tracking.monitors) ? tracking.monitors.length : 0;
          if (!monitorCount) {
            addCandidate(list, group, 'setup-monitoring', 'search', 'blue', '配置监测项', '把失效条件变成自动监控', 34, lastTouched, pendingIds);
          }
          addCandidate(list, group, 'check-tracking', 'history', 'green', '查看跟踪结论', '最近一次调整与版本', 24, lastTouched, pendingIds);
        }
        if (model) {
          addCandidate(list, group, 'model-actuals', 'table', 'green', '检查模型实际值', '列出可替换的预测', 20, lastTouched, pendingIds);
        }
      }
      if (market && (marketStale || !report)) {
        addCandidate(list, group, 'refresh-market', 'table', 'blue', '刷新同行行情', marketStale ? '数据已超过 1 天' : '更新价格与数据日期', 18 + (marketStale ? 8 : 0), lastTouched, pendingIds);
      }
    }

    // A report the assistant just wrote but that doesn't sit in a recognized folder.
    if (lastTouched && isReport(lastTouched) && !groups.some(group => group.report?.id === lastTouched.id)) {
      const group = {
        key: `touched:${lastTouched.relPath}`,
        folder: dir(lastTouched.relPath),
        subject: lastTouched.name,
        report: lastTouched,
        market: null,
        model: null,
        stateFile: null,
      };
      addCandidate(list, group, 'update-framework', 'refresh', 'yellow', '复核这份报告', '检查是否需要更新', 20, lastTouched, pendingIds);
      addCandidate(list, group, 'track-assess', 'clock', 'yellow', '评估是否跟踪', '给出频率与监控指标', 18, lastTouched, pendingIds);
    }

    const recent = lastTouched || files().slice().sort((a, b) => {
      const ta = updatedAt(a)?.getTime() || 0;
      const tb = updatedAt(b)?.getTime() || 0;
      return tb - ta;
    })[0];
    if (!list.length && recent) {
      const group = { key: `recent:${recent.relPath}`, file: recent, folder: dir(recent.relPath), subject: recent.name };
      addCandidate(list, group, 'explain', 'file-text', 'blue', '解读这个文件', '先看结论和下一步', 10, lastTouched, pendingIds);
    }

    // Recent audio: the generic "解读这个文件" prompt works, but a dedicated
    // transcript-aware action is more useful and can show the ASR state.
    const recentAudio = [lastTouched, ...pending(), ...files()]
      .filter(isAudio)
      .sort((a, b) => (updatedAt(b)?.getTime() || 0) - (updatedAt(a)?.getTime() || 0))[0];
    if (recentAudio) {
      const audioDone = recentAudio.asr?.status === 'done';
      const audioActive = recentAudio.asr?.active;
      const group = {
        key: `audio:${recentAudio.relPath}`,
        folder: dir(recentAudio.relPath),
        subject: recentAudio.name.replace(/\.[^.]+$/, ''),
        file: recentAudio,
      };
      addCandidate(
        list, group, 'audio-notes', 'audio', 'violet',
        audioDone ? '整理录音纪要' : '查看转写状态',
        audioDone ? '提炼结论与待办' : audioActive ? '转写中，先看进度' : '读取音频转写',
        audioDone ? 34 : 22,
        lastTouched, pendingIds,
      );
    }

    const sorted = list.sort((a, b) => b.score - a.score);
    const perGroup = new Map();
    const picked = [];
    for (const item of sorted) {
      const count = perGroup.get(item.group) || 0;
      if (count >= 2) continue;
      perGroup.set(item.group, count + 1);
      picked.push(item);
      if (picked.length >= MAX) break;
    }
    return picked;
  }

  function currentSignature() {
    return ui.suggestions.map(item => item.id).join('|');
  }

  function rebuild() {
    const next = buildSuggestions();
    const signature = next.map(item => item.id).join('|');
    if (signature !== ui.signature) {
      ui.dismissed = '';
      ui.signature = signature;
    }
    ui.suggestions = next;
    render();
  }

  function render() {
    const host = $('#nextActions');
    const input = $('#input');
    if (!host || !input) return;
    if (state.streaming || input.value.trim() || !ui.suggestions.length || ui.dismissed === currentSignature()) {
      host.hidden = true;
      return;
    }
    if (ui.renderedSignature !== currentSignature()) {
      host.innerHTML = `
        <div class="na-panel" role="region" aria-label="下一步建议">
          <div class="na-head">
            <span class="na-eyebrow">${ic('spark', 11)}猜你下一步</span>
            <button type="button" class="na-dismiss" data-next-dismiss aria-label="收起建议">${ic('x', 13)}</button>
          </div>
          <div class="na-list">
            ${ui.suggestions.map((item, index) => `
              <button type="button" class="na-card" data-next-action="${index}">
                <span class="na-icon tint-${item.tint}">${ic(item.icon, 14)}</span>
                <span class="na-copy"><span class="na-label">${esc(item.label)}</span><span class="na-detail">${esc(item.detail)}</span></span>
                <span class="na-enter">填入 →</span>
              </button>`).join('')}
          </div>
        </div>`;
      ui.renderedSignature = currentSignature();
    }
    host.hidden = false;
  }

  function apply(index) {
    const item = ui.suggestions[index];
    const input = $('#input');
    if (!item || !input) return;
    input.value = item.prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (typeof autosize === 'function') autosize();
    if (typeof syncComposer === 'function') syncComposer();
    if (typeof toast === 'function') toast('已填入输入框，可编辑后发送');
    render();
  }

  function dismiss() {
    ui.dismissed = currentSignature();
    render();
  }

  function onInput() {
    render();
  }

  function wire() {
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-next-action]');
      if (action) {
        event.preventDefault();
        apply(Number(action.dataset.nextAction));
        return;
      }
      if (event.target.closest('[data-next-dismiss]')) {
        event.preventDefault();
        dismiss();
      }
    });
    const input = $('#input');
    input?.addEventListener('input', onInput);
  }

  function init() {
    if (ui.initialized) return;
    ui.initialized = true;
    wire();
    rebuild();
  }

  window.NextActions = {
    init,
    refresh: rebuild,
    onInput,
  };
})();
