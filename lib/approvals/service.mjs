/**
 * Human approval for model write-back.
 *
 * A tracking run never writes a model. It emits a proposal; this service
 * persists it and applies it only after a human approves. Approval revalidates
 * every claim against the current project state, the current working model and
 * the current analysis-state.json.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findSoffice, readCells } from "../calc-engine.mjs";
import { MODEL_CHANGE_PROPOSAL } from "../contracts/model-change-proposal.mjs";

const PENDING = "pending_approval";

// One in-process mutex per working-model path. The server is single-process by
// design; this serializes approvals that target the same workbook.
const fileLocks = new Map();
async function withFileLock(key, fn) {
  const previous = fileLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  fileLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === current) fileLocks.delete(key);
  }
}

function refOf(sheet, cell) {
  return `${String(sheet || "").trim()}!${String(cell || "").trim().toUpperCase()}`;
}

function splitRef(ref) {
  const value = String(ref || "");
  const index = value.lastIndexOf("!");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    sheet: value.slice(0, index),
    cell: value.slice(index + 1).trim().toUpperCase(),
  };
}

function inside(root, candidate) {
  const absolute = path.resolve(root, candidate);
  return absolute === root || absolute.startsWith(root + path.sep) ? absolute : null;
}

function scalar(value) {
  if (value === undefined || value === null) return null;
  if (["number", "string", "boolean"].includes(typeof value)) return value;
  return null;
}

function bindingsMap(state) {
  const map = new Map();
  for (const binding of Array.isArray(state?.model?.bindings) ? state.model.bindings : []) {
    if (!binding || !binding.sheet || !binding.cell) continue;
    map.set(refOf(binding.sheet, binding.cell).toUpperCase(), binding);
  }
  return map;
}

function outputRefs(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((output) => splitRef(output?.ref) || {
      sheet: String(output?.sheet || "").trim(),
      cell: String(output?.cell || "").trim().toUpperCase(),
    })
    .filter((item) => item.sheet && item.cell)
    .map((item) => refOf(item.sheet, item.cell));
}

function statePathForTracking(tracking) {
  const targetPath = tracking?.relPath || tracking?.targetPath || "";
  if (!targetPath) return "";
  return path.posix.join(path.posix.dirname(targetPath), "analysis-state.json");
}

async function readStateFile(ctx, relPath) {
  if (!relPath) return { state: null, error: "状态文件路径为空" };
  const absolute = inside(ctx.root, relPath);
  if (!absolute) return { state: null, error: "状态文件不在项目内" };
  try {
    return { state: JSON.parse(await fs.promises.readFile(absolute, "utf8")), error: null };
  } catch (error) {
    return {
      state: null,
      error: error.code === "ENOENT" ? `状态文件不存在：${relPath}` : `无法读取状态文件：${error.message}`,
    };
  }
}

async function inspectTargets(ctx, proposal) {
  const material = ctx.store.findMaterialByPath(proposal.workingModel.path);
  const version = material?.versions?.[0] || null;
  const checks = {
    material,
    version,
    problems: [],
    conflict: false,
  };
  if (!material) {
    checks.problems.push(`工作模型不存在：${proposal.workingModel.path}`);
    checks.conflict = true;
    return checks;
  }
  if (!version || Number(version.v) !== Number(proposal.workingModel.baseVersion)) {
    checks.problems.push(
      `工作模型版本已变化（提案 v${proposal.workingModel.baseVersion}，当前 v${version?.v ?? "?"}）`,
    );
    checks.conflict = true;
  }
  if (!version || String(version.sha256) !== String(proposal.workingModel.baseSha256)) {
    checks.problems.push("工作模型版本记录的内容哈希与提案基线不一致");
    checks.conflict = true;
  }
  // The DB records the hash at index time. Re-hash the actual file so an
  // out-of-band edit can never be approved against a stale baseline.
  const workingAbs = inside(ctx.root, proposal.workingModel.path);
  if (workingAbs && fs.existsSync(workingAbs)) {
    const actual = crypto.createHash("sha256").update(await fs.promises.readFile(workingAbs)).digest("hex");
    if (actual !== String(proposal.workingModel.baseSha256)) {
      checks.problems.push("工作模型文件哈希与提案基线不一致");
      checks.conflict = true;
    }
  }
  return checks;
}

async function inspectWorkbook(ctx, proposal, state) {
  const workingAbs = inside(ctx.root, proposal.workingModel.path);
  const report = {
    problems: [],
    conflict: false,
    writeEnabled: state?.model?.write_enabled === true,
    bindings: bindingsMap(state),
    formulas: {},
    values: {},
    outputs: {},
    outputFormulas: {},
  };
  if (!workingAbs || !fs.existsSync(workingAbs)) {
    report.problems.push(`工作模型文件不存在：${proposal.workingModel.path}`);
    report.conflict = true;
    return report;
  }
  if (String(state?.model?.working_file || "") !== proposal.workingModel.path) {
    report.problems.push(
      `状态文件指向的工作模型已变化（提案 ${proposal.workingModel.path}，当前 ${state?.model?.working_file || "空"}）`,
    );
    report.conflict = true;
    return report;
  }
  if (!report.writeEnabled) report.problems.push("模型写回未启用（model.write_enabled=false）");

  const changeRefs = proposal.changes
    .map((change) => splitRef(change.ref))
    .filter(Boolean)
    .map((item) => refOf(item.sheet, item.cell));
  const outputs = outputRefs(proposal.outputsToVerify);
  if (!outputs.length) {
    report.problems.push("提案没有可校验的输出单元格");
    report.conflict = true;
  }

  try {
    report.formulas = await readCells(workingAbs, changeRefs, { formulas: true });
    report.values = await readCells(workingAbs, changeRefs);
    report.outputs = await readCells(workingAbs, outputs);
    report.outputFormulas = await readCells(workingAbs, outputs, { formulas: true });
  } catch (error) {
    report.problems.push(`无法读取工作模型单元格：${error.message}`);
    report.conflict = true;
    return report;
  }

  for (const change of proposal.changes) {
    const binding = report.bindings.get(String(change.ref).toUpperCase());
    if (!binding || binding.verified !== true) {
      report.problems.push(`单元格 ${change.ref} 没有已验证的映射`);
    }
    const formula = report.formulas[String(change.ref).toUpperCase()] ?? report.formulas[change.ref];
    if (typeof formula === "string" && formula.trim().startsWith("=")) {
      report.problems.push(`单元格 ${change.ref} 是公式，不能直接覆盖`);
      report.conflict = true;
    }
  }
  for (const ref of outputs) {
    const value = report.outputs[ref];
    const formula = report.outputFormulas[ref];
    if ((value === undefined || value === null) && !formula) {
      report.problems.push(`输出 ${ref} 不在工作模型中`);
      report.conflict = true;
    }
  }
  if (!report.writeEnabled || report.problems.some((item) => item.includes("没有已验证") || item.includes("没有可校验"))) {
    report.conflict = true;
  }
  return report;
}

function changesForApply(proposal) {
  return proposal.changes.map((change) => {
    const target = splitRef(change.ref);
    return {
      metric: change.metric,
      sheet: target?.sheet || "",
      cell: target?.cell || "",
      value: change.to,
      note: change.reason,
    };
  });
}

function outputsForApply(proposal) {
  return proposal.outputsToVerify.map((output) => {
    const target = splitRef(output.ref);
    return { label: output.label, sheet: target?.sheet || "", cell: target?.cell || "" };
  });
}

export function createApprovalService({
  store,
  broadcast = () => {},
  applyModelChanges,
  now = () => new Date(),
  libreOfficeAvailable = false,
} = {}) {
  if (!store) throw new Error("createApprovalService requires a store");
  if (typeof applyModelChanges !== "function") throw new Error("createApprovalService requires applyModelChanges");

  function record(id) {
    return store.getApprovalRequest(id);
  }

  function emit(type, approval, extra = {}) {
    try {
      broadcast({ type, approval, ...extra });
    } catch {
      /* UI broadcast must never abort a write decision */
    }
  }

  function syncTrackingApproval(approval, status, reason = "") {
    if (!approval?.runId) return;
    try {
      const run = store.getTrackingRun(approval.runId);
      if (!run?.result_json) return;
      const result = JSON.parse(run.result_json);
      if (!result || typeof result !== "object") return;
      result.writeback = result.writeback && typeof result.writeback === "object" ? result.writeback : {};
      result.writeback.approval = {
        id: approval.id,
        status,
        ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
        ...(reason ? { reason } : {}),
      };
      const note = {
        rejected: "模型变更已被人工拒绝，文件未修改。",
        conflict: "提案基线或目标已变化，未写入文件；请重新生成提案。",
        failed: "模型写回失败，文件已保持原样或已回滚。",
      }[status] || "";
      result.writeback.note = `${result.writeback.note || ""} ${note}`.trim();
      const message = {
        rejected: "模型变更已拒绝",
        conflict: "审批冲突，需重新生成提案",
        failed: "模型写回失败",
      }[status] || "等待模型写回审批";
      store.updateTrackingRunResult(approval.runId, {
        status: "needs_review",
        message,
        result,
      });
      const tracking = approval.trackingId ? store.getTracking(approval.trackingId) : null;
      if (tracking) broadcast({ type: "tracking.updated", tracking });
    } catch {
      /* the approval decision must survive a malformed historical result */
    }
  }

  function failTrackingProposal(approval, reason) {
    syncTrackingApproval(approval, "failed", reason);
  }

  /**
   * Build and persist a proposal from a tracking result. This function never
   * calls applyModelChanges and never touches the workbook.
   */
  async function propose({ ctx, tracking, trackingRunId, threadId, result, state, stateRel = "" }) {
    const workingRel = state?.model?.working_file;
    if (!workingRel) {
      return { ok: false, reason: "还没有准备工作模型", proposal: null, approval: null };
    }
    const material = ctx.store.findMaterialByPath(workingRel);
    const version = material?.versions?.[0];
    if (!material || !version) {
      return { ok: false, reason: `工作模型不在资料库中：${workingRel}`, proposal: null, approval: null };
    }
    const workingAbs = inside(ctx.root, workingRel);
    if (!workingAbs || !fs.existsSync(workingAbs)) {
      return { ok: false, reason: `工作模型文件不存在：${workingRel}`, proposal: null, approval: null };
    }

    const changes = Array.isArray(result?.modelChanges) ? result.modelChanges : [];
    const outputs = Array.isArray(result?.modelOutputs) ? result.modelOutputs : [];
    if (!changes.length) {
      return { ok: false, reason: "结果里没有 modelChanges", proposal: null, approval: null };
    }
    if (!outputs.length) {
      return { ok: false, reason: "结果里没有 modelOutputs，无法校验写回", proposal: null, approval: null };
    }

    const refs = changes.map((change) => refOf(change.sheet, change.cell));
    const outputRefsList = outputs.map((output) => refOf(output.sheet, output.cell));
    const formulas = await readCells(workingAbs, refs, { formulas: true });
    const values = await readCells(workingAbs, refs);
    const verified = bindingsMap(state);
    const validation = {
      writeEnabled: state?.model?.write_enabled === true,
      allBindingsVerified: true,
      allTargetsAreLiteralInputs: true,
      libreOfficeAvailable: Boolean(libreOfficeAvailable),
    };
    const proposalChanges = changes.map((change, index) => {
      const ref = refs[index];
      const binding = verified.get(ref.toUpperCase());
      const formula = formulas[ref] ?? formulas[ref.toUpperCase()];
      const isFormula = typeof formula === "string" && formula.trim().startsWith("=");
      if (!binding || binding.verified !== true) validation.allBindingsVerified = false;
      if (isFormula) validation.allTargetsAreLiteralInputs = false;
      return {
        metric: String(change.metric || ""),
        ref,
        from: scalar(values[ref] ?? values[ref.toUpperCase()]),
        to: scalar(change.value),
        bindingVerified: Boolean(binding && binding.verified === true),
        formulaCell: isFormula,
        reason: String(change.note || ""),
        source: String(result.sources?.[0]?.label || change.note || ""),
      };
    });

    const proposal = {
      schema: { name: "pe.model-change.proposal", version: 1 },
      proposalId: `prop_${crypto.randomUUID()}`,
      projectId: ctx.id,
      threadId: String(threadId || ""),
      runId: String(trackingRunId || ""),
      trackingId: String(tracking?.id || ""),
      workingModel: {
        materialId: material.id,
        path: workingRel,
        baseVersion: Number(version.v),
        baseSha256: String(version.sha256 || ""),
      },
      changes: proposalChanges,
      outputsToVerify: outputRefsList.map((ref, index) => ({
        label: String(outputs[index]?.label || outputs[index]?.name || ""),
        ref,
      })),
      validation,
      status: PENDING,
      createdAt: now().toISOString(),
    };
    const checked = MODEL_CHANGE_PROPOSAL.validate(proposal);
    if (!checked.ok) {
      const detail = checked.errors.map((item) => `${item.path} ${item.message}`).join("; ");
      return {
        ok: false,
        reason: `提案不符合 schema：${detail}`,
        proposal,
        approval: null,
      };
    }
    const approval = store.createApprovalRequest({
      threadId,
      runId: trackingRunId,
      trackingId: tracking?.id || "",
      kind: "model_change",
      payload: proposal,
      status: PENDING,
      createdAt: proposal.createdAt,
    });
    proposal.approvalId = approval.id;
    emit("approval.created", approval);
    return { ok: true, proposal, approval, stateRel };
  }

  async function revalidate(ctx, approval, proposal, state) {
    const problems = [];
    let conflict = false;
    if (!ctx || proposal.projectId !== ctx.id) {
      return { ok: false, conflict: true, problems: ["项目不一致"] };
    }
    if (!["pending_approval", "approved", "applying"].includes(approval.status)) {
      return { ok: false, conflict: true, problems: [`请求当前状态为 ${approval.status}`] };
    }
    const target = await inspectTargets(ctx, proposal);
    problems.push(...target.problems);
    conflict = conflict || target.conflict;
    if (!target.material) return { ok: false, conflict: true, problems };
    if (target.material.id !== proposal.workingModel.materialId) {
      problems.push("提案绑定的资料 id 与当前工作模型不一致");
      conflict = true;
    }
    if (!libreOfficeAvailable || !findSoffice()) {
      problems.push("LibreOffice 不可用，无法重算输出");
      conflict = true;
    }

    if (!state) {
      problems.push("状态文件不可读");
      return { ok: false, conflict: true, problems };
    }
    const workbook = await inspectWorkbook(ctx, proposal, state);
    problems.push(...workbook.problems);
    conflict = conflict || workbook.conflict;
    if (!workbook.writeEnabled) conflict = true;

    return {
      ok: problems.length === 0,
      conflict,
      problems,
      target,
      workbook,
    };
  }

  async function approve({ ctx, id }) {
    const approval = record(id);
    if (!approval) return { ok: false, httpStatus: 404, code: "not_found", error: "审批请求不存在" };
    if (approval.status === "applied") {
      return { ok: true, httpStatus: 200, approval, already: true };
    }
    if (approval.status === "applying") {
      return { ok: true, httpStatus: 202, approval, already: true, pending: true };
    }
    if (approval.status === "rejected") {
      return { ok: false, httpStatus: 409, code: "already_rejected", error: "审批已被拒绝", approval };
    }
    if (approval.status === "conflict" || approval.status === "failed") {
      return {
        ok: false,
        httpStatus: 409,
        code: approval.status,
        error: "该提案已失效，请重新生成提案",
        approval,
      };
    }
    if (!approval.payload) {
      const failed = store.transitionApproval(id, {
        fromStatuses: [PENDING],
        status: "failed",
        decision: { reason: "proposal payload is corrupt", at: now().toISOString() },
      });
      syncTrackingApproval(failed || approval, "failed", "proposal payload is corrupt");
      return { ok: false, httpStatus: 409, code: "corrupt_proposal", error: "提案数据损坏", approval: failed || approval };
    }
    const payloadCheck = MODEL_CHANGE_PROPOSAL.validate(approval.payload);
    if (!payloadCheck.ok) {
      const failed = store.transitionApproval(id, {
        fromStatuses: [PENDING],
        status: "conflict",
        decision: { reason: "proposal schema invalid", at: now().toISOString() },
      });
      syncTrackingApproval(failed || approval, "conflict", "proposal schema invalid");
      return {
        ok: false,
        httpStatus: 409,
        code: "invalid_proposal",
        error: "提案不符合 schema，请重新生成",
        approval: failed || approval,
      };
    }
    const proposal = payloadCheck.value;
    const tracking = ctx.store.getTracking(proposal.trackingId);
    if (!tracking) {
      const conflict = store.transitionApproval(id, {
        fromStatuses: [PENDING],
        status: "conflict",
        decision: { reason: "tracking not found", at: now().toISOString() },
      });
      syncTrackingApproval(conflict || approval, "conflict", "tracking not found");
      return { ok: false, httpStatus: 409, code: "tracking_missing", error: "跟踪任务不存在", approval: conflict || approval };
    }
    const stateRel = statePathForTracking(tracking);
    const { state, error: stateError } = await readStateFile(ctx, stateRel);
    const checks = await revalidate(ctx, approval, proposal, state);
    if (!checks.ok) {
      const conflict = store.transitionApproval(id, {
        fromStatuses: [PENDING, "approved"],
        status: checks.conflict ? "conflict" : "failed",
        payload: { ...proposal, status: checks.conflict ? "conflict" : "failed" },
        decision: {
          reason: stateError || checks.problems.join("；") || "revalidation failed",
          at: now().toISOString(),
          problems: checks.problems,
        },
      });
      const current = conflict || record(id) || approval;
      emit("approval.updated", current);
      syncTrackingApproval(current, checks.conflict ? "conflict" : "failed", stateError || checks.problems.join("；"));
      return {
        ok: false,
        httpStatus: 409,
        code: checks.conflict ? "conflict" : "revalidation_failed",
        error: checks.problems.join("；") || "审批重新校验失败",
        approval: current,
      };
    }

    // A crash after approved but before applying is resumable: revalidate,
    // then move straight to applying. Only applied/applying are terminal here.
    let approved = approval;
    if (approval.status === PENDING) {
      approved = store.transitionApproval(id, {
        fromStatuses: [PENDING],
        status: "approved",
        payload: { ...proposal, status: "approved" },
        decision: { approvedAt: now().toISOString(), by: "local-user" },
      });
      if (!approved) {
        const current = record(id);
        if (current && ["applied", "applying"].includes(current.status)) {
          return { ok: true, httpStatus: 200, approval: current, already: true };
        }
        return { ok: false, httpStatus: 409, code: "not_pending", error: "审批请求已被处理", approval: current };
      }
      emit("approval.updated", approved);
    }

    const applying = store.transitionApproval(id, {
      fromStatuses: ["approved"],
      status: "applying",
      payload: { ...(approved.payload || proposal), status: "applying" },
      decision: approved.decision,
    });
    if (!applying) {
      const current = record(id);
      if (current && ["applied", "applying"].includes(current.status)) {
        return { ok: true, httpStatus: 200, approval: current, already: true };
      }
      return { ok: false, httpStatus: 409, code: "not_pending", error: "审批请求已被处理", approval: current };
    }
    emit("approval.updated", applying);

    try {
      const applied = await withFileLock(proposal.workingModel.path, async () => {
        // Re-read the state and revalidate under the file lock. Two approvals
        // for the same working model must not both apply a stale baseline.
        const fresh = await readStateFile(ctx, stateRel);
        const freshChecks = await revalidate(ctx, { ...approval, status: "applying" }, proposal, fresh.state);
        if (!freshChecks.ok) {
          return { ok: false, conflict: true, reason: freshChecks.problems.join("；") || "文件已被其他写入修改" };
        }
        return applyModelChanges({
          ctx,
          tracking,
          state: fresh.state,
          changes: changesForApply(proposal),
          outputs: outputsForApply(proposal),
          runId: proposal.runId,
          expectedSha: proposal.workingModel.baseSha256,
        });
      });
      if (!applied?.ok) {
        const isConflict = applied?.conflict || applied?.code === "baseline_changed";
        const status = isConflict ? "conflict" : "failed";
        const failed = store.transitionApproval(id, {
          fromStatuses: ["applying"],
          status,
          payload: { ...(approved.payload || proposal), status },
          decision: {
            ...(approved.decision || {}),
            reason: applied?.reason || "apply failed",
            at: now().toISOString(),
          },
        });
        emit("approval.updated", failed || record(id));
        syncTrackingApproval(failed || record(id), status, applied?.reason || "模型写回失败");
        return {
          ok: false,
          httpStatus: 409,
          code: isConflict ? "conflict" : "apply_failed",
          error: applied?.reason || "模型写回失败",
          approval: failed || record(id),
        };
      }

      const modelVersion = applied.material?.versions?.[0]?.v ?? null;
      const finished = store.transitionApproval(id, {
        fromStatuses: ["applying"],
        status: "applied",
        appliedAt: now().toISOString(),
        payload: { ...(approved.payload || proposal), status: "applied" },
        decision: {
          ...(approved.decision || {}),
          appliedAt: now().toISOString(),
          materialId: applied.material?.id || "",
          version: modelVersion,
          backup: applied.backupRel || null,
          changes: applied.changes,
          outputs: applied.outputs.map((output) => ({
            ...output,
            before: applied.before[refOf(output.sheet, output.cell)] ?? null,
            after: applied.after[refOf(output.sheet, output.cell)] ?? null,
          })),
        },
      });

      // Keep the tracking run and its stored result consistent with the applied
      // write. This is a result update, not a second write.
      const run = ctx.store.getTrackingRun(proposal.runId);
      let runResult = null;
      if (run?.result_json) {
        try {
          runResult = JSON.parse(run.result_json);
        } catch {
          runResult = null;
        }
      }
      if (runResult && typeof runResult === "object") {
        runResult.status = "updated";
        runResult.writeback = runResult.writeback && typeof runResult.writeback === "object"
          ? runResult.writeback
          : {};
        runResult.writeback.version = modelVersion ? `工作模型 v${modelVersion}` : "工作模型已更新";
        runResult.writeback.model = {
          file: applied.workingFile,
          version: modelVersion,
          backup: applied.backupRel || null,
          changes: applied.changes,
          outputs: applied.outputs.map((output) => ({
            ...output,
            before: applied.before[refOf(output.sheet, output.cell)] ?? null,
            after: applied.after[refOf(output.sheet, output.cell)] ?? null,
          })),
        };
        runResult.writeback.approval = {
          id,
          status: "applied",
          decidedAt: approved.decidedAt,
        };
        runResult.writeback.note = `${runResult.writeback.note || ""} 模型写回已获人工批准，工作模型已重算并写回。`.trim();
        ctx.store.updateTrackingRunResult(proposal.runId, {
          status: "updated",
          message: `模型更新 · 工作模型 v${modelVersion ?? "?"}`,
          result: runResult,
        });
      }
      if (applied.material?.id) {
        try {
          ctx.store.recordRunChange({
            runId: proposal.runId,
            objectType: "model",
            objectId: applied.material.id,
            before: { version: Math.max(1, Number(modelVersion) - 1), backup: applied.backupRel },
            after: { version: modelVersion, file: applied.workingFile },
          });
        } catch {
          /* run-change auditing is best effort */
        }
      }
      const trackingDto = ctx.store.getTracking(proposal.trackingId);
      emit("approval.updated", finished || record(id), {
        tracking: trackingDto,
        material: applied.material,
      });
      if (trackingDto) broadcast({ type: "tracking.updated", tracking: trackingDto });
      if (applied.material) broadcast({ type: "material.updated", material: applied.material });
      return { ok: true, httpStatus: 200, approval: finished || record(id), tracking: trackingDto, material: applied.material };
    } catch (error) {
      const failed = store.transitionApproval(id, {
        fromStatuses: ["applying"],
        status: "failed",
        payload: { ...(approved.payload || proposal), status: "failed" },
        decision: {
          ...(approved.decision || {}),
          reason: error.message || String(error),
          at: now().toISOString(),
        },
      });
      emit("approval.updated", failed || record(id));
      return {
        ok: false,
        httpStatus: 500,
        code: "apply_error",
        error: error.message || "模型写回异常",
        approval: failed || record(id),
      };
    }
  }

  async function reject({ ctx, id, reason = "" }) {
    const approval = record(id);
    if (!approval) return { ok: false, httpStatus: 404, code: "not_found", error: "审批请求不存在" };
    if (approval.status === "rejected") {
      return { ok: true, httpStatus: 200, approval, already: true };
    }
    if (["applied", "applying", "approved"].includes(approval.status)) {
      return {
        ok: false,
        httpStatus: 409,
        code: "not_rejectable",
        error: "审批已进入执行阶段，不能拒绝",
        approval,
      };
    }
    const rejected = store.transitionApproval(id, {
      fromStatuses: [PENDING, "conflict", "failed"],
      status: "rejected",
      payload: approval.payload ? { ...approval.payload, status: "rejected" } : undefined,
      decision: {
        rejectedAt: now().toISOString(),
        reason: String(reason || "").slice(0, 1000),
        by: "local-user",
      },
    });
    if (!rejected) {
      const current = record(id);
      if (current?.status === "rejected") return { ok: true, httpStatus: 200, approval: current, already: true };
      return { ok: false, httpStatus: 409, code: "not_pending", error: "审批请求已被处理", approval: current };
    }

    syncTrackingApproval(rejected, "rejected", rejected.decision?.reason || "");
    emit("approval.updated", rejected);
    const tracking = rejected.trackingId ? ctx.store.getTracking(rejected.trackingId) : null;
    return { ok: true, httpStatus: 200, approval: rejected, tracking };
  }

  async function cancel(id, reason = "proposal cancelled") {
    const approval = record(id);
    if (!approval) return null;
    if (!["pending_approval", "approved"].includes(approval.status)) return approval;
    const cancelled = store.transitionApproval(id, {
      fromStatuses: ["pending_approval", "approved"],
      status: "failed",
      payload: approval.payload ? { ...approval.payload, status: "failed" } : undefined,
      decision: { reason: String(reason).slice(0, 500), at: now().toISOString() },
    });
    if (cancelled) {
      emit("approval.updated", cancelled);
      syncTrackingApproval(cancelled, "failed", reason);
    }
    return cancelled || approval;
  }

  function list(options = {}) {
    return store.listApprovalRequests(options);
  }

  function get(id) {
    return record(id);
  }

  return { propose, approve, reject, cancel, list, get };
}

export default createApprovalService;
