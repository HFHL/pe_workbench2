/**
 * Tool presentation renderer registry.
 *
 * Every renderer declares the tool/schema/version it understands, validates the
 * payload before rendering, returns escaped HTML, and lists its actions. Unknown
 * schemas, versions or corrupt payloads render an error placeholder instead of
 * throwing into the message renderer.
 */

import { esc, safeText } from "../shared/escape.js";
import {
  validateProposalPayload,
  validateTrackingPayload,
  validateWorkbookPayload,
} from "./validators.js";

export const TOOL_STATUSES = Object.freeze([
  "queued",
  "running",
  "complete",
  "error",
  "awaiting_approval",
  "applying",
  "applied",
  "rejected",
  "conflict",
]);

const STATUS_LABEL = {
  queued: "排队中",
  running: "运行中",
  complete: "完成",
  error: "失败",
  awaiting_approval: "待审批",
  applying: "应用中",
  applied: "已应用",
  rejected: "已拒绝",
  conflict: "冲突",
};

const registry = new Map();

function keyOf(schema, version) {
  return `${schema}@${version}`;
}

export function registerRenderer({
  toolName,
  schema,
  version = 1,
  validate,
  render,
  actions = () => [],
}) {
  if (!schema || !toolName) throw new Error("renderer requires toolName and schema");
  if (typeof validate !== "function" || typeof render !== "function") {
    throw new Error("renderer requires validate and render");
  }
  const entry = { toolName, schema, version, validate, render, actions };
  registry.set(keyOf(schema, version), entry);
  return entry;
}

export function getRenderer(schema, version = 1) {
  return registry.get(keyOf(schema, version)) || null;
}

export function rendererForTool(tool) {
  const presentation = tool?.presentation;
  if (!presentation?.schema?.name) return null;
  return getRenderer(presentation.schema.name, Number(presentation.schema.version || 1));
}

export function errorCardHTML(message, { title = "无法展示这个工具结果" } = {}) {
  return `<div class="tool-result-card tool-card-error" role="note">
    <div class="tc-head"><span class="tc-title">${esc(title)}</span><span class="tc-meta">错误占位</span></div>
    <p class="tc-error">${esc(safeText(message, 300))}</p>
  </div>`;
}

export function renderToolPresentation(tool, context = {}) {
  const presentation = tool?.presentation;
  if (tool?.presentationError) return errorCardHTML(tool.presentationError);
  if (!presentation?.schema?.name) return "";
  const renderer = getRenderer(presentation.schema.name, Number(presentation.schema.version || 1));
  if (!renderer) {
    return errorCardHTML(
      `未知的展示契约：${presentation.schema.name}@${presentation.schema.version || "?"}`,
      { title: "未知 schema / version" },
    );
  }
  try {
    const problem = renderer.validate(presentation.payload);
    if (problem) return errorCardHTML(`数据结构不完整：${problem}`);
    return renderer.render(presentation.payload, { ...context, tool });
  } catch (error) {
    return errorCardHTML(`渲染失败：${error.message || error}`);
  }
}

/* ---------- workbook ---------- */

function relationLabel(relation) {
  return { seed: "命中", upstream: "上游", downstream: "下游" }[relation] || relation;
}

export function workbookCardHTML(payload) {
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  const shown = cells.slice(0, 8);
  const rows = shown.map((cell) => `<tr>
    <td class="wb-ref">${esc(cell.ref)}</td>
    <td>${esc(cell.displayLabel || "—")}</td>
    <td><span class="wb-rel ${esc(cell.relation)}">${esc(relationLabel(cell.relation))}</span></td>
    <td class="wb-value">${esc(cell.value.display)}</td>
    <td class="wb-formula">${cell.formula ? esc(safeText(cell.formula, 120)) : "输入值"}</td>
  </tr>`).join("");
  const rest = cells.slice(8, 48);
  const hidden = Math.max(0, cells.length - 8 - rest.length);
  const restRows = rest.map((cell) => `<tr>
    <td class="wb-ref">${esc(cell.ref)}</td>
    <td>${esc(cell.displayLabel || "—")}</td>
    <td><span class="wb-rel ${esc(cell.relation)}">${esc(relationLabel(cell.relation))}</span></td>
    <td class="wb-value">${esc(cell.value.display)}</td>
    <td class="wb-formula">${cell.formula ? esc(safeText(cell.formula, 120)) : "输入值"}</td>
  </tr>`).join("");
  const deps = cells.slice(0, 12).map((cell) => {
    const up = (cell.upstreamRefs || []).map((ref) => `<span class="wb-dep">${esc(ref)}</span>`).join("");
    const down = (cell.downstreamRefs || []).map((ref) => `<span class="wb-dep">${esc(ref)}</span>`).join("");
    if (!up && !down) return "";
    return `<div class="wb-dep-row"><span class="wb-ref">${esc(cell.ref)}</span>
      <span class="wb-dep-label">上游</span>${up || "<em>无</em>"}
      <span class="wb-dep-label">下游</span>${down || "<em>无</em>"}</div>`;
  }).filter(Boolean).join("");
  const warnings = (payload.warnings || []).map((warning) => `<p>${esc(warning)}</p>`).join("");
  const more = rest.length
    ? `<details class="wb-more"><summary>还有 ${rest.length + hidden} 个单元格</summary><div class="wb-table-wrap"><table class="wb-table">${restRows}</table></div>${hidden ? `<div class="tc-note">还有 ${hidden} 个单元格未展开，请缩小查询范围。</div>` : ""}</details>`
    : "";
  return `<div class="tool-result-card workbook-card">
    <div class="tc-head"><span class="tc-title">工作簿查询 · ${esc(payload.query)}</span>
      <span class="tc-meta">${esc(payload.material.path)} · v${esc(payload.material.version)}</span></div>
    <div class="tc-summary">命中 ${esc(payload.summary.matchedCells)} 个 · 返回 ${esc(payload.summary.returnedCells)} 个${payload.summary.truncated ? " · 已截断" : ""}</div>
    <div class="wb-table-wrap"><table class="wb-table"><thead><tr><th>单元格</th><th>标签</th><th>关系</th><th>值</th><th>公式</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${more}
    ${deps ? `<details class="wb-deps"><summary>依赖关系</summary>${deps}</details>` : ""}
    ${warnings ? `<div class="tc-warnings">${warnings}</div>` : ""}
  </div>`;
}

/* ---------- approval ---------- */

const APPROVAL_STATUS_LABEL = {
  pending_approval: "待审批",
  approved: "已批准",
  applying: "应用中",
  applied: "已应用",
  rejected: "已拒绝",
  conflict: "冲突",
  failed: "失败",
};

export function approvalCardHTML(payload, { approval = null } = {}) {
  if (!payload || typeof payload !== "object" || !payload.workingModel || !Array.isArray(payload.changes)) {
    return errorCardHTML("审批数据不完整或已损坏，请重新生成提案", { title: "审批数据损坏" });
  }
  const workingModel = payload.workingModel;
  const status = approval?.status || payload.status || "pending_approval";
  const pending = status === "pending_approval";
  const allChanges = Array.isArray(payload.changes) ? payload.changes : [];
  const changes = allChanges.slice(0, 8).map((change) => `<li>
    <span class="ap-metric">${esc(change.metric || change.ref)}</span>
    <span class="ap-ref">${esc(change.ref)}</span>
    <span class="ap-from">${esc(change.from ?? "—")}</span>
    <span class="ap-arrow">→</span>
    <span class="ap-to">${esc(change.to ?? "—")}</span>
    <span class="ap-badge ${change.bindingVerified ? "ok" : "warn"}">${change.bindingVerified ? "映射已验证" : "映射未验证"}</span>
    ${change.formulaCell ? '<span class="ap-badge warn">公式单元格</span>' : ""}
  </li>`).join("");
  const allOutputs = Array.isArray(payload.outputsToVerify) ? payload.outputsToVerify : [];
  const outputs = allOutputs.slice(0, 8).map((output) =>
    `<span class="ap-output">${esc(output.label || output.ref)} · ${esc(output.ref)}</span>`).join("");
  const overflow = `${allChanges.length > 8 ? `<div class="tc-note">还有 ${allChanges.length - 8} 项变更未展开</div>` : ""}
    ${allOutputs.length > 8 ? `<div class="tc-note">还有 ${allOutputs.length - 8} 个输出未展开</div>` : ""}`;
  const validation = payload.validation || {};
  const checks = [
    ["写回已启用", validation.writeEnabled],
    ["绑定已验证", validation.allBindingsVerified],
    ["目标为输入值", validation.allTargetsAreLiteralInputs],
    ["LibreOffice 可用", validation.libreOfficeAvailable],
  ].map(([label, ok]) => `<span class="ap-check ${ok ? "ok" : "warn"}">${ok ? "✓" : "!"} ${esc(label)}</span>`).join("");
  const decision = approval?.decision
    ? `<div class="ap-decision">${approval.decision.reason ? `原因：${esc(safeText(approval.decision.reason, 300))}` : ""}
        ${approval.decidedAt ? `<span>${esc(approval.decidedAt.slice(0, 16).replace("T", " "))}</span>` : ""}</div>`
    : "";
  const actions = pending
    ? `<div class="ap-actions">
        <input class="ap-reason" data-approval-reason="${esc(approval?.id || "")}" placeholder="拒绝原因（可选）" maxlength="200">
        <button type="button" class="ap-btn primary" data-approval-action="approve" data-approval-id="${esc(approval?.id || "")}">批准并写回</button>
        <button type="button" class="ap-btn" data-approval-action="reject" data-approval-id="${esc(approval?.id || "")}">拒绝</button>
      </div>`
    : "";
  return `<div class="tool-result-card approval-card" data-approval-id="${esc(approval?.id || "")}">
    <div class="tc-head"><span class="tc-title">模型写回审批</span>
      <span class="tc-meta ap-status ${esc(status)}">${esc(APPROVAL_STATUS_LABEL[status] || status)}</span></div>
    <div class="ap-model">${esc(workingModel.path || "—")} · 基线 v${esc(workingModel.baseVersion ?? "?")}</div>
    <ul class="ap-changes">${changes}</ul>
    <div class="ap-outputs">${outputs}</div>
    ${overflow}
    <div class="ap-checks">${checks}</div>
    ${decision}
    ${actions}
  </div>`;
}

/* ---------- tracking result ---------- */

export function trackingResultCardHTML(payload) {
  const deltas = (payload.deltas || []).slice(0, 5).map((delta) =>
    `<li><span>${esc(delta.label)}</span><span>${esc(delta.from)} → <strong>${esc(delta.to)}</strong></span></li>`).join("");
  const modelCount = (payload.modelChanges || []).length;
  const thesisCount = (payload.theses || []).length;
  const approval = payload.writeback?.approval;
  return `<div class="tool-result-card tracking-result-card">
    <div class="tc-head"><span class="tc-title">${esc(payload.headline || payload.conclusion || "跟踪结果")}</span>
      <span class="tc-meta">${esc(payload.confidence || "—")} · ${esc(payload.status)}</span></div>
    <p class="tc-summary">${esc(safeText(payload.summary || payload.conclusion, 400))}</p>
    ${deltas ? `<ul class="tr-deltas">${deltas}</ul>` : ""}
    <div class="tr-meta"><span>${esc(thesisCount)} 个观点</span><span>${esc(modelCount)} 个模型变更</span>
      ${approval ? `<span class="tr-approval">审批 ${esc(APPROVAL_STATUS_LABEL[approval.status] || approval.status)}</span>` : ""}</div>
    ${payload.writeback?.note ? `<p class="tc-note">${esc(safeText(payload.writeback.note, 500))}</p>` : ""}
  </div>`;
}

/* ---------- registrations ---------- */

registerRenderer({
  toolName: "workbook_query",
  schema: "pe.workbook-query.result",
  version: 1,
  validate: validateWorkbookPayload,
  render: (payload) => workbookCardHTML(payload),
  actions: () => [{ action: "open-material", label: "打开工作簿" }],
});

registerRenderer({
  toolName: "model_change",
  schema: "pe.model-change.proposal",
  version: 1,
  validate: validateProposalPayload,
  render: (payload, context) => approvalCardHTML(payload, context),
  actions: (payload) => [
    { action: "approve", label: "批准并写回" },
    { action: "reject", label: "拒绝" },
  ],
});

registerRenderer({
  toolName: "tracking_result",
  schema: "pe.tracking-result",
  version: 1,
  validate: validateTrackingPayload,
  render: (payload) => trackingResultCardHTML(payload),
  actions: () => [],
});

export function fallbackToolCardHTML(tool, status = "complete") {
  const label = STATUS_LABEL[status] || status;
  return `<div class="tool-result-card fallback-card">
    <div class="tc-head"><span class="tc-title">${esc(tool?.name || "工具")}</span><span class="tc-meta">${esc(label)}</span></div>
    ${tool?.detail ? `<div class="tc-summary">${esc(safeText(tool.detail, 200))}</div>` : ""}
    ${tool?.output ? `<pre class="tc-output">${esc(safeText(tool.output, 2000))}</pre>` : ""}
  </div>`;
}

export { STATUS_LABEL, APPROVAL_STATUS_LABEL };
