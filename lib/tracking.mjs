/**
 * Tracking domain helpers.
 *
 * A tracking is a durable "keep this file current" contract:
 *   file identity + schedule + template + result contract.
 *
 * The file identity never changes on an in-place update. Every run that changes
 * the file content is committed by the existing material version model as
 * v1 -> v2 -> v3, not as a new `*-v2.md` file.
 */

export const TRACKING_TEMPLATES = {
  framework: {
    id: "framework",
    label: "投资框架复核",
    tag: "Markdown · 原位更新",
    writeMode: "in_place",
    description: "读取新财务、行情和同行数据，对比原预测与假设，更新投资结论和失效条件。",
  },
  model: {
    id: "model",
    label: "估值模型更新",
    tag: "Excel · 生成更新副本",
    writeMode: "propose_only",
    description: "把已确定的财务实际值填入模型，重算受影响的预测与估值，生成更新副本和变更清单。",
  },
  generic: {
    id: "generic",
    label: "通用文件刷新",
    tag: "文本 · 按原结构更新",
    writeMode: "in_place",
    description: "按文件自身结构和最新资料刷新内容，保留原有结论框架与写作方式。",
  },
};

const TEMPLATE_IDS = new Set(Object.keys(TRACKING_TEMPLATES));
const FREQS = new Set(["daily", "weekly", "monthly"]);

export function templateForFile(name = "") {
  const ext = String(name).split(".").pop().toLowerCase();
  if (["xlsx", "xlsm", "xltx", "xltm"].includes(ext)) return "model";
  if (["md", "markdown", "txt"].includes(ext)) return "framework";
  return "generic";
}

export function templateFor(id) {
  return TRACKING_TEMPLATES[id] || TRACKING_TEMPLATES.generic;
}

export function normalizeSchedule(input = {}) {
  const freq = FREQS.has(input.freq) ? input.freq : "weekly";
  const time = /^\d{2}:\d{2}$/.test(String(input.time || "")) ? String(input.time) : "09:00";
  const weekday = Math.min(7, Math.max(1, Number(input.weekday) || 1));
  const day = Math.min(28, Math.max(1, Number(input.day) || 1));
  return { freq, time, weekday, day };
}

export function scheduleLabel(schedule) {
  if (schedule.freq === "daily") return `每天 ${schedule.time}`;
  if (schedule.freq === "weekly") return `每周${["", "一", "二", "三", "四", "五", "六", "日"][schedule.weekday] || "一"} ${schedule.time}`;
  return `每月 ${schedule.day} 日 ${schedule.time}`;
}

export function scheduleShort(schedule) {
  if (schedule.freq === "daily") return `每天 ${schedule.time}`;
  if (schedule.freq === "weekly") return `周${["", "一", "二", "三", "四", "五", "六", "日"][schedule.weekday] || "一"} ${schedule.time}`;
  return `每月 ${schedule.day} 日`;
}

export function computeNextRun(schedule, from = new Date()) {
  const [hour, minute] = String(schedule.time || "09:00").split(":").map(Number);
  const h = Number.isFinite(hour) ? hour : 9;
  const m = Number.isFinite(minute) ? minute : 0;

  if (schedule.freq === "daily") {
    const candidate = new Date(from);
    candidate.setHours(h, m, 0, 0);
    if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.freq === "weekly") {
    const target = Number(schedule.weekday || 1) % 7;
    const candidate = new Date(from);
    candidate.setHours(h, m, 0, 0);
    let diff = (target - candidate.getDay() + 7) % 7;
    if (diff === 0 && candidate <= from) diff = 7;
    candidate.setDate(candidate.getDate() + diff);
    return candidate;
  }

  const day = Math.min(28, Math.max(1, Number(schedule.day) || 1));
  let candidate = new Date(from.getFullYear(), from.getMonth(), day, h, m, 0, 0);
  if (candidate <= from) {
    candidate = new Date(from.getFullYear(), from.getMonth() + 1, day, h, m, 0, 0);
  }
  return candidate;
}

export function formatNextLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const week = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  return `${date.getMonth() + 1}/${date.getDate()}（周${week}）${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function buildTrackingPrompt({
  trackingId,
  runId,
  targetPath,
  targetName,
  templateId,
  baseVersion,
  resultRelPath,
  backupRelPath = null,
  trigger,
  workspaceFiles = [],
  skillsDir = "",
  monitorItems = [],
  monitorMode = false,
  events = [],
}) {
  const template = templateFor(templateId);
  const validatorPath = `${skillsDir || "skills"}/investment-framework/scripts/validate_state.mjs`;
  const fileLine = (file) => {
    const size = formatBytes(file.size);
    const date = file.updatedAt ? ` · ${String(file.updatedAt).slice(0, 10)}` : "";
    return `- [${file.kind === "output" ? "输出" : "输入"}] \`${file.path}\` · v${file.version ?? 1}${size ? ` · ${size}` : ""}${date}`;
  };
  const inputs = workspaceFiles.filter((file) => file.kind !== "output");
  const outputs = workspaceFiles.filter((file) => file.kind === "output");
  const workspaceSection = `## 工作空间参考（输入 + 输出）

更新不是只改目标文件。请先主动巡检当前工作空间，把相关输入和已有输出都纳入参考：

- 先看目录：\`ls .\`、\`ls uploads\`、\`ls inputs\`、\`ls exports\`（不存在的目录跳过）；文件多时用 \`find\` / \`grep\` 定位同主题文件。
- **输入**（\`uploads/\`、\`inputs/\`）：用于核对事实、补充最新数据、发现与目标文件不一致之处。输入只读，禁止修改。
- **输出**（\`exports/\`）：用于延续已有结论、口径、结构和已声明的假设；如果本次判断与已有输出冲突，必须说明冲突原因，并以更新、更可靠的证据为准。
- 同目录的 \`analysis-state.json\`、\`tracking.json\` 和历史跟踪记录（如有）也要先读。
- 下面的清单只是索引，是否相关以实际读取到的内容为准；清单之外新出现的文件也要用 \`ls\` 发现。

${workspaceFiles.length
  ? `已入库的工作空间文件（不含目标文件）：
### 输入
${inputs.length ? inputs.map(fileLine).join("\n") : "- （无）"}
### 输出
${outputs.length ? outputs.map(fileLine).join("\n") : "- （无）"}`
  : "（当前工作空间没有其它已入库文件；仍请用 `ls` 检查是否存在未入库的状态文件、草稿或历史产出。）"}`;
  const eventsSection = monitorMode && events.length
    ? `## 本次触发的事件

${events.map((event) => `- [S${event.sourceTier || 3}] ${event.title || "无标题"}${event.url ? ` · ${event.url}` : ""}${event.publishedAt ? ` · ${event.publishedAt}` : ""}${event.snippet ? `\n  ${String(event.snippet).slice(0, 400)}` : ""}`).join("\n")}

先判断这些事件是否与监测项相关；不相关就忽略并输出 no_change。相关的事件只作为证据，仍要按下面的监测项逐条核对。`
    : "";
  const monitorSection = monitorMode
    ? `## 本次监测项（只检查这些）

${monitorItems.length
  ? monitorItems.map((item) => `- ${item.id} / ${item.falsifierId || "—"}（${item.thesisId || "—"}）：${item.metric || "—"}；预警：${item.warning || "—"}；失效：${item.threshold || "—"}；来源：${item.source?.text || item.source?.query || "—"}；频率：${item.frequency || "—"}；下次检查：${item.nextCheckAt || item.next_check_at || "—"}`).join("\n")
  : "- （没有到期的监测项；请直接输出 no_change，不要改任何文件）"}

监测模式规则：
- 只检查以上监测项，不要顺手复核其他观点或改其他小节。
- 逐条更新 \`analysis-state.json\` 的 falsifiers：\`last_observed\`、\`last_checked_at\`、\`status\`（armed / warning / triggered / unknown）、\`next_check_at\`。
- **没有判断变化时不要修改报告，也不要追加 \`## 跟踪记录\`**；观察值只写状态文件。
- 预警或触发时，在结果 JSON 的 \`monitorChecks\` 与 \`invalidations\` 中列出；没有触发的也要写观察值。
- 如果 \`analysis-state.json\` 里 \`model.write_enabled=true\` 且单元格绑定已确认，可以提出 \`modelChanges\`（只改输入单元格，不改公式）；没有把握就不填，标 \`needs_review\`。`
    : "";
  const modeText = template.writeMode === "propose_only"
    ? "仅生成更新副本/变更计划；不要写 .xlsx 原文件"
    : "原位更新同一路径；由系统生成新的 material 版本";
  const backupText = backupRelPath
    ? `\n- 宿主已把原文件备份到：\`${backupRelPath}\`。不要再创建新的备份文件，也不要把备份内容写进正文。`
    : "";
  const domainRules = templateId === "model"
    ? `- 用 workbook_query 读取 .xlsx，不要用 read 直接读二进制。
- 先参考 exports/ 里已有的更新记录/模型说明，以及 inputs/ 中的原始假设；输入和输出都要与本次更新计划对齐。
- 把已确认的实际值映射到模型科目与期间，标出无法映射的缺口。
- 生成 \`update-plan.json\` 和 \`change-log.md\` 到 \`.tracking/${trackingId}/${runId}/\`。
- 不要写回 xlsx 原文件；本次不产生原文件的新版本，status 使用 \`needs_review\`。`
    : templateId === "framework"
      ? `- 读取目标文件和同目录的 analysis-state.json（事实源）；有状态时先读它确认基线，若当前会话有 bash，可跑 \`node ${validatorPath} analysis-state.json\` 检查结构，否则按 Skill 的自查清单核对。没有状态文件时：如果报告确实是投资框架（有观点/失效条件结构），按现有结构做最小复核并标 needs_review，建议补建状态；如果只是一般文档，按通用刷新处理。
- 状态文件是事实源，报告是视图：先逐条核对 falsifiers（指标、阈值、来源、频率），再决定 theses 的状态，最后才改报告受影响的小节。
- 每个 F 更新 observed / last_checked_at / status（armed / triggered / unknown）；触发后按 action 执行核验，不自动交易。
- 每个 T 的状态只在证据支持时改变（active / weakened / invalidated / confirmed / retired），并写清证据 ID 与失效条件 ID。
- 只修改受新证据影响的假设、敏感性、估值、观点和失效条件；保留稳定 ID 与未受影响内容，不整体重写。
- 有实质变化时 revision +1 并追加 changes；只追加跟踪记录时不要升 revision。同步更新 tracking 游标（last_run_id、last_run_at、data_cutoff、thesis_status、triggered_falsifier_ids）。
- 先写状态文件（一次写完整 JSON），再改报告；两边的数字和状态必须一致。
${monitorMode ? "- 监测模式下不要写 `## 跟踪记录`；观察值只写入状态文件。" : "- 即使没有重大变化，也在文末 `## 跟踪记录` 追加本次记录（日期、数据截止日、结论一行）。"}`
      : `- 读取目标文件和同目录的状态文件（若存在）。
- 同时参考 exports/ 中已有的产出和 uploads/、inputs/ 中的输入资料，保持结构与口径一致。
- 用可用工具获取最新资料，只更新受影响的内容，保留原结构。
${monitorMode ? "- 监测模式下不要写 `## 跟踪记录`；无变化时不要改文件。" : "- 即使没有重大变化，也在文末 `## 跟踪记录` 追加本次记录（日期、数据截止日、结论一行）。"}`;

  return `# Workbench 跟踪运行

这不是普通聊天，而是一次可审计的自动更新。${templateId === "framework" ? "请先加载并遵循 `framework-update` Skill（状态契约见 `investment-framework`）。" : "按下面的领域规则执行。"}

## 本次跟踪
- tracking_id：${trackingId}
- run_id：${runId}
- 模板：${template.label}（${template.id}）
- 触发方式：${trigger}
- 目标文件（唯一身份）：\`${targetPath}\`
- 当前基线版本：v${baseVersion}
- 写回模式：${modeText}${backupText}

${workspaceSection}

${monitorSection}

${eventsSection}

## 必须遵守
1. **只更新这一个路径**：\`${targetPath}\`。禁止创建 \`*-v2.md\`、\`*-updated.md\`、\`${targetName.replace(/\.[^.]+$/, "")}-跟踪版.md\` 等新文件。文件身份不变，内容变化后由系统生成 v${baseVersion + 1}。
2. 更新前先做工作空间巡检：\`ls\` 项目根目录、\`uploads/\`、\`inputs/\`、\`exports/\`，读取与目标主题相关的输入和输出文件；再读目标文件和同目录的 \`analysis-state.json\` / \`tracking.json\`（若存在），保留原有结构和未受影响的判断。
3. ${monitorMode ? "**监测模式**：只有判断/结论变化时才改报告；没有变化不要写报告，也不要追加 `## 跟踪记录`。观察值写状态文件即可。" : "每次运行都必须在目标文件末尾维护 `## 跟踪记录`：追加本次记录（运行日期、数据截止日、结论一行），没有变化也写“本期无变化”。不要删除历史记录，也不要覆盖已有内容。"}
4. 同时把结构化结果写到：\`${resultRelPath}\`。这是宿主读取的唯一结果来源，必须是合法 JSON。
5. 最后回复 2–4 句结论，不要重复整份报告；不要使用表格。

## 领域规则
${domainRules}

## 结果 JSON schema（必须遵守）
\`\`\`json
{
  "status": "updated | no_change | needs_review",
  "conclusion": "一句话结论，先给判断/目标价有没有变",
  "summary": "2–4 句解释，说明为什么调整或为什么没变",
  "confidence": "高 | 中 | 低 | —",
  "deltas": [
    { "label": "目标价", "from": "129 元", "to": "134 元", "note": "+3.9%", "tone": "up" }
  ],
  "theses": [
    { "id": "T1", "statement": "一句话观点", "status": "active | weakened | invalidated | confirmed | retired", "change": "维持 | 降级 | 失效 | 升级", "note": "依据：证据 ID / 失效条件 ID" }
  ],
  "invalidations": [
    { "id": "F1", "thesis_id": "T1", "condition": "库存 > 12 周", "observed": "12.6 周", "triggered": true, "action": "下调 A1，重算 V1" }
  ],
  "monitorChecks": [
    { "id": "MON1", "falsifier_id": "F1", "observed": "12.6 周", "status": "armed | warning | triggered | unknown", "note": "来源与口径" }
  ],
  "modelChanges": [
    { "metric": "HBM 营收占比", "sheet": "Assumption", "cell": "AA54", "value": 0.27, "note": "下调假设" }
  ],
  "modelOutputs": [
    { "label": "目标价", "sheet": "Discount PE", "cell": "H29" }
  ],
  "reasons": [
    {
      "tag": "新实际值 | 结构变化 | 估值对照 | 无变化",
      "title": "一句话依据",
      "detail": "这条依据如何影响预测/估值/判断",
      "source": "来源名称 · YYYY-MM-DD",
      "impact": "影响了什么"
    }
  ],
  "judgment": { "title": "判断变化标题", "text": "判断是否反转、新增/删除了哪些失效条件" },
  "sources": [ { "label": "来源名称", "date": "YYYY-MM-DD" } ],
  "notUsed": ["尚未披露/未使用的数据"],
  "writeback": {
    "stats": "3 处假设 · 2 处预测 · 1 处结论",
    "note": "写回位置、备份位置、未验证项",
    "changes": [
      { "where": "位置", "from": "旧值", "to": "新值", "note": "变化" }
    ]
  }
}
\`\`\`

注意：
- \`status\` 必须是上述四个值之一；没有实质变化用 \`no_change\`。${monitorMode ? "监测模式下无判断变化也用 \`no_change\`，但不要改报告。" : "没有实质变化时仍要在目标文件追加跟踪记录。"}
- \`theses\` 与 \`invalidations\` 是投资框架模板的必需输出：\`theses\` 覆盖所有 active / weakened / invalidated 的观点，\`invalidations\` 列出本期核对过的失效条件（触发的排前面）。其他模板可留空数组。
- \`monitorChecks\` 只在监测模式下必需：覆盖本次所有到期的 MON，\`status\` 是 armed / warning / triggered / unknown 之一。
- \`modelChanges\` / \`modelOutputs\` 只在模型写回启用时使用：\`cell\` 必须是已验证的输入单元格，不能是公式；没有把握就不填，改为 \`needs_review\`。
- 不要编造来源、日期或数字；无法验证的项写进 \`notUsed\` 或 \`writeback.note\`。
- 在 \`sources\` 或 \`writeback.note\` 中列出本次实际参考的工作空间文件（尤其是用到的输入和输出文件名），便于审计。
- 结果 JSON 里的 \`writeback.version\` 不需要填，系统会根据实际版本补齐。`;
}

function cleanString(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

function normalizeSource(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const name = cleanString(value.name || value.label);
  const date = cleanString(value.date);
  return [name, date].filter(Boolean).join(" · ");
}

function normalizeDelta(value) {
  if (!value || typeof value !== "object") return null;
  const label = cleanString(value.label);
  const from = cleanString(value.from, "—");
  const to = cleanString(value.to, "—");
  if (!label) return null;
  const tone = ["up", "down", "flat"].includes(value.tone) ? value.tone : "flat";
  return { label, from, to, note: cleanString(value.note), tone };
}

function normalizeReason(value, index) {
  if (typeof value === "string") {
    return {
      tag: "依据",
      title: value,
      detail: "",
      source: "",
      impact: "",
    };
  }
  if (!value || typeof value !== "object") return null;
  return {
    tag: cleanString(value.tag, `依据 ${index + 1}`),
    title: cleanString(value.title, "未命名依据"),
    detail: cleanString(value.detail),
    source: normalizeSource(value.source),
    impact: cleanString(value.impact),
  };
}

function normalizeThesis(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id);
  if (!id) return null;
  const status = ["active", "weakened", "invalidated", "confirmed", "retired"].includes(value.status)
    ? value.status
    : "active";
  return {
    id,
    statement: cleanString(value.statement),
    status,
    change: cleanString(value.change),
    note: cleanString(value.note),
  };
}

function normalizeInvalidation(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id);
  if (!id) return null;
  return {
    id,
    thesis_id: cleanString(value.thesis_id),
    condition: cleanString(value.condition),
    observed: cleanString(value.observed),
    triggered: value.triggered === true || value.triggered === "true",
    action: cleanString(value.action),
  };
}

function normalizeMonitorCheck(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id);
  if (!id) return null;
  if (!value.observed && !value.status && !value.note) return null;
  const status = ["armed", "warning", "triggered", "unknown"].includes(value.status)
    ? value.status
    : "unknown";
  return {
    id,
    falsifier_id: cleanString(value.falsifier_id || value.falsifierId),
    observed: cleanString(value.observed),
    status,
    note: cleanString(value.note),
  };
}

function normalizeModelChange(value) {
  if (!value || typeof value !== "object") return null;
  const sheet = cleanString(value.sheet);
  const cell = cleanString(value.cell).toUpperCase();
  if (!sheet || !cell) return null;
  if (value.value === undefined || value.value === null || typeof value.value === "object") return null;
  return {
    metric: cleanString(value.metric),
    sheet,
    cell,
    value: value.value,
    note: cleanString(value.note || value.reason),
  };
}

function normalizeModelOutput(value) {
  if (!value || typeof value !== "object") return null;
  const sheet = cleanString(value.sheet);
  const cell = cleanString(value.cell).toUpperCase();
  if (!sheet || !cell) return null;
  return { label: cleanString(value.label || value.name), sheet, cell };
}

function normalizeWriteback(value, { template, resultVersion, backupPath = null }) {
  const raw = value && typeof value === "object" ? value : {};
  const changes = Array.isArray(raw.changes)
    ? raw.changes.map((item) => ({
        where: cleanString(item?.where),
        from: cleanString(item?.from, "—"),
        to: cleanString(item?.to, "—"),
        note: cleanString(item?.note),
      })).filter((item) => item.where)
    : [];
  const defaultMode = template.writeMode === "propose_only" ? "生成更新副本 · 原文件只读" : "原位更新 · 已备份";
  const defaultNote = template.writeMode === "propose_only"
    ? "Excel 原文件保持只读；更新副本与 update-plan.json 已生成。副本是独立文件，不会出现在原文件的 v1 / v2 版本列表里。"
    : backupPath
      ? `写入前已由宿主备份到 ${backupPath}。同路径更新会出现在文件详情的版本历史，可在旧版与新版本之间切换。`
      : "同路径更新会出现在文件详情的版本历史，可在旧版与新版本之间切换。";
  return {
    mode: cleanString(raw.mode, defaultMode),
    version: resultVersion ? `v${resultVersion}` : "未产生新版本",
    stats: cleanString(raw.stats, changes.length ? `${changes.length} 处变更` : "0 处修改"),
    note: cleanString(raw.note, defaultNote),
    backup: backupPath || undefined,
    changes,
  };
}

export function normalizeTrackingResult(raw, context) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const template = templateFor(context.templateId);
  const status = ["updated", "no_change", "needs_review", "baseline", "failed"].includes(value.status)
    ? value.status
    : context.status;
  const deltas = Array.isArray(value.deltas) ? value.deltas.map(normalizeDelta).filter(Boolean) : [];
  const theses = Array.isArray(value.theses) ? value.theses.map(normalizeThesis).filter(Boolean) : [];
  const invalidations = Array.isArray(value.invalidations)
    ? value.invalidations
        .map(normalizeInvalidation)
        .filter(Boolean)
        .sort((a, b) => Number(b.triggered) - Number(a.triggered))
    : [];
  const monitorChecks = Array.isArray(value.monitorChecks)
    ? value.monitorChecks.map(normalizeMonitorCheck).filter(Boolean)
    : [];
  const modelChanges = Array.isArray(value.modelChanges)
    ? value.modelChanges.map(normalizeModelChange).filter(Boolean)
    : [];
  const modelOutputs = Array.isArray(value.modelOutputs)
    ? value.modelOutputs.map(normalizeModelOutput).filter(Boolean)
    : [];
  const reasons = Array.isArray(value.reasons) ? value.reasons.map(normalizeReason).filter(Boolean) : [];
  const sources = Array.isArray(value.sources)
    ? value.sources.map((item) => {
        if (typeof item === "string") return { label: item, date: "" };
        if (!item || typeof item !== "object") return null;
        return { label: cleanString(item.label || item.name), date: cleanString(item.date) };
      }).filter((item) => item && item.label)
    : [];
  const notUsed = Array.isArray(value.notUsed)
    ? value.notUsed.map((item) => cleanString(item)).filter(Boolean)
    : [];
  const judgment = value.judgment && typeof value.judgment === "object"
    ? { title: cleanString(value.judgment.title, "判断变化"), text: cleanString(value.judgment.text) }
    : typeof value.judgment === "string"
      ? { title: "判断变化", text: value.judgment }
      : null;

  const conclusion = cleanString(value.conclusion, context.fallbackConclusion || "跟踪运行完成");

  return {
    status,
    headline: cleanString(value.headline, conclusion),
    conclusion,
    summary: cleanString(value.summary, context.fallbackSummary || ""),
    confidence: cleanString(value.confidence, "—"),
    asOf: context.nowLabel,
    duration: context.duration || "",
    deltas,
    theses,
    invalidations,
    monitorChecks,
    modelChanges,
    modelOutputs,
    reasons,
    judgment,
    writeback: normalizeWriteback(value.writeback, {
      template,
      resultVersion: context.resultVersion,
      backupPath: context.backupPath,
    }),
    sources,
    notUsed,
    target: {
      path: context.targetPath,
      base_material_id: context.targetId,
      base_version: context.baseVersion,
      result_material_id: context.targetId,
      result_version: context.resultVersion,
      write_mode: template.writeMode,
    },
  };
}

export function fallbackTrackingResult(context) {
  const template = templateFor(context.templateId);
  return normalizeTrackingResult(
    {
      status: context.status,
      conclusion: context.fallbackConclusion || "跟踪运行完成",
      summary: context.fallbackSummary || "",
      confidence: "—",
      deltas: [],
      reasons: [],
      judgment: null,
      sources: [],
      notUsed: [],
      writeback: {
        mode: template.writeMode === "propose_only" ? "生成更新副本 · 原文件只读" : "原位更新 · 已备份",
        stats: "本次没有可解析的变更清单",
        note: "Agent 未写出结构化结果，以上结论来自运行回复；请打开文件版本核对。",
        changes: [],
      },
    },
    context,
  );
}

export function isTrackingTemplate(value) {
  return TEMPLATE_IDS.has(value);
}
