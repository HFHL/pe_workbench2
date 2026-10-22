/** Pending model-write approvals: shelf rendering and decisions. */

import { api } from "../api/client.js";
import { getState, state, selectors } from "../state/store.js";
import { approvalCardHTML, errorCardHTML } from "../tool-renderers/registry.js";
import { toast } from "../shared/toast.js";
import { runtime } from "../runtime.js";

export function pendingApprovals() {
  return selectors.pendingApprovals();
}

export function approvalsShelfHTML() {
  const pending = pendingApprovals();
  // Recently rejected/conflicted rows stay visible after a refresh so the
  // outcome is auditable. Applied rows are intentionally dropped.
  const decided = (state.approvals || [])
    .filter((item) => ["rejected", "conflict", "failed"].includes(item.status))
    .slice(0, 5);
  const items = [...pending, ...decided];
  if (!items.length) return "";
  return `<div class="approvals-shelf" aria-label="模型写回审批">
    <div class="approvals-shelf-head"><strong>${pending.length ? "待审批" : "审批结果"}</strong>
      <span>${pending.length ? `${pending.length} 个模型写回请求` : "最近已处理的请求"}</span></div>
    ${items.map((approval) => {
      try {
        return approvalCardHTML(approval.payload || {}, { approval });
      } catch {
        return errorCardHTML("审批数据损坏，无法展示", { title: "审批数据损坏" });
      }
    }).join("")}
  </div>`;
}

export async function loadApprovals() {
  const projectId = getState().project?.id;
  try {
    const items = await api("/api/approvals");
    if (getState().project?.id !== projectId) return; // project switched mid-flight
    state.approvals = Array.isArray(items) ? items : [];
    runtime.renderThread?.(false);
  } catch {
    /* the shelf is optional */
  }
}

export async function decideApproval(id, action, reason = "") {
  if (!id) return;
  const projectId = getState().project?.id;
  const card = document.querySelector(`[data-approval-id="${CSS.escape(id)}"]`);
  card?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: action === "reject" ? { reason } : {},
    });
    if (getState().project?.id !== projectId) return;
    if (result.approval) {
      const index = state.approvals.findIndex((item) => item.id === result.approval.id);
      if (index >= 0) state.approvals[index] = result.approval;
      else state.approvals.unshift(result.approval);
    }
    if (result.tracking) window.Tracking?.upsert?.(result.tracking);
    if (result.material) runtime.upsertMaterial?.(result.material);
    await loadApprovals();
    await runtime.refreshSnapshot?.();
    toast(action === "approve"
      ? (result.pending ? "这个审批正在应用中" : result.already ? "这个审批已经应用过了" : "已批准，模型已重算并写回")
      : (result.error || "已拒绝，文件未修改"));
  } catch (error) {
    toast(error.message || "审批失败");
    await loadApprovals();
  }
}

export function upsertApproval(approval) {
  if (!approval) return;
  const index = state.approvals.findIndex((item) => item.id === approval.id);
  if (index >= 0) state.approvals[index] = approval;
  else state.approvals.unshift(approval);
}
