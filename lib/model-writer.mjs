/**
 * Model write-back: prepare a writable working copy, apply verified input-cell
 * changes, recalculate with LibreOffice, and verify outputs before replacing
 * the working model.
 *
 * The original upload is never modified. A change is only applied when the
 * binding is explicitly verified in analysis-state.json and the target cell is
 * a literal input (not a formula).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  applyWorkbookCells,
  readCells,
} from "./calc-engine.mjs";

function inside(root, candidate) {
  const absolute = path.resolve(root, candidate);
  return absolute === root || absolute.startsWith(root + path.sep) ? absolute : null;
}

function refOf(sheet, cell) {
  return `${String(sheet || "").trim()}!${String(cell || "").trim().toUpperCase()}`;
}

function normalizeOutputs(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((output) => ({
      label: String(output?.label || output?.name || "").trim(),
      sheet: String(output?.sheet || "").trim(),
      cell: String(output?.cell || "").trim().toUpperCase(),
    }))
    .filter((output) => output.sheet && output.cell);
}

function normalizeChanges(changes) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => ({
      metric: String(change?.metric || "").trim(),
      sheet: String(change?.sheet || "").trim(),
      cell: String(change?.cell || "").trim().toUpperCase(),
      value: change?.value,
      note: String(change?.note || change?.reason || "").trim(),
    }))
    .filter((change) => change.sheet && change.cell);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function writeState(ctx, stateRel, state) {
  const absolute = inside(ctx.root, stateRel);
  if (!absolute) throw new Error("状态文件不在项目内");
  const temp = `${absolute}.tmp-${process.pid}`;
  await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(temp, absolute);
  return ctx.store.indexFile(stateRel, {
    source: "agent",
    author: "Workbench",
    note: "模型绑定/输出更新",
    status: "draft",
    visibility: "internal",
    reason: "model metadata",
  });
}

export async function prepareWorkingModel({ ctx, tracking, state, stateRel }) {
  const targetPath = tracking?.relPath || tracking?.targetPath;
  if (!targetPath) throw Object.assign(new Error("目标文件路径为空"), { status: 400 });
  const sourceRel = state?.subject?.model_file
    || state?.model?.files?.[0]?.absolute_path
    || "";
  if (!sourceRel) throw Object.assign(new Error("状态文件里没有 model_file"), { status: 400 });
  const sourceAbs = inside(ctx.root, sourceRel);
  if (!sourceAbs || !fs.existsSync(sourceAbs)) {
    throw Object.assign(new Error(`原始模型不存在：${sourceRel}`), { status: 404 });
  }
  const dir = path.posix.dirname(targetPath);
  const workingRel = path.posix.join(dir, "model", "工作模型.xlsx");
  const workingAbs = path.join(ctx.root, workingRel);
  if (!fs.existsSync(workingAbs)) {
    await fsp.mkdir(path.dirname(workingAbs), { recursive: true });
    await fsp.copyFile(sourceAbs, workingAbs);
  }

  state.model = state.model && typeof state.model === "object" ? state.model : {};
  state.model.working_file = workingRel;
  state.model.working_from = sourceRel;
  state.model.write_enabled = state.model.write_enabled === true;
  state.model.bindings = Array.isArray(state.model.bindings) ? state.model.bindings : [];
  state.model.outputs = Array.isArray(state.model.outputs) ? state.model.outputs : [];
  await writeState(ctx, stateRel, state);
  const material = ctx.store.indexFile(workingRel, {
    source: "agent",
    author: "Workbench",
    note: "工作模型",
    status: "draft",
  });
  return { workingFile: workingRel, material, state };
}

export async function applyModelChanges({
  ctx,
  tracking,
  state,
  changes = [],
  outputs = [],
  runId = null,
} = {}) {
  const workingRel = state?.model?.working_file;
  if (!workingRel) return { ok: false, reason: "还没有准备工作模型" };
  const workingAbs = inside(ctx.root, workingRel);
  if (!workingAbs || !fs.existsSync(workingAbs)) {
    return { ok: false, reason: `工作模型不存在：${workingRel}` };
  }
  if (state?.model?.write_enabled !== true) {
    return { ok: false, reason: "模型写回未启用（model.write_enabled=false）" };
  }

  const normalizedChanges = normalizeChanges(changes);
  const normalizedOutputs = normalizeOutputs(outputs);
  if (!normalizedChanges.length) return { ok: false, reason: "没有模型单元格变更" };
  if (!normalizedOutputs.length) return { ok: false, reason: "没有声明要校验的模型输出" };

  const bindings = Array.isArray(state?.model?.bindings) ? state.model.bindings : [];
  const verified = new Map();
  for (const binding of bindings) {
    if (binding?.verified !== true) continue;
    const ref = refOf(binding.sheet, binding.cell).toUpperCase();
    verified.set(ref, binding);
  }
  if (!verified.size) return { ok: false, reason: "没有已确认的单元格映射" };

  for (const change of normalizedChanges) {
    const ref = refOf(change.sheet, change.cell).toUpperCase();
    if (!verified.has(ref)) {
      return { ok: false, reason: `单元格 ${ref} 没有已验证的映射` };
    }
    if (change.value === undefined || change.value === null || typeof change.value === "object") {
      return { ok: false, reason: `单元格 ${ref} 的值非法` };
    }
  }

  // Never overwrite a formula: bindings must point at literal input cells.
  const formulas = await readCells(workingAbs, normalizedChanges.map((c) => refOf(c.sheet, c.cell)), {
    formulas: true,
  });
  for (const change of normalizedChanges) {
    const ref = refOf(change.sheet, change.cell);
    const formula = formulas[ref];
    if (typeof formula === "string" && formula.trim().startsWith("=")) {
      return { ok: false, reason: `单元格 ${ref} 是公式，不能直接覆盖` };
    }
  }

  const outputRefs = normalizedOutputs.map((output) => refOf(output.sheet, output.cell));
  const before = await readCells(workingAbs, outputRefs);
  const result = await applyWorkbookCells({
    sourcePath: workingAbs,
    changes: normalizedChanges.map((change) => `${refOf(change.sheet, change.cell)}=${JSON.stringify(change.value)}`),
    outputs: outputRefs,
  });
  const after = result.values;

  for (const output of normalizedOutputs) {
    const ref = refOf(output.sheet, output.cell);
    const value = after[ref];
    if (value === null || value === undefined) {
      fs.rmSync(result.workDir, { recursive: true, force: true });
      return { ok: false, reason: `输出 ${ref} 没有值` };
    }
    if (numberOrNull(value) === null && typeof value !== "string") {
      fs.rmSync(result.workDir, { recursive: true, force: true });
      return { ok: false, reason: `输出 ${ref} 不是有效数值或文本` };
    }
  }

  const outputChanged = normalizedOutputs.some((output) => {
    const ref = refOf(output.sheet, output.cell);
    return before[ref] !== after[ref];
  });
  if (!outputChanged) {
    fs.rmSync(result.workDir, { recursive: true, force: true });
    return { ok: false, reason: "重算后输出没有变化，拒绝写入" };
  }

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const backupRel = path.posix.join(
    path.posix.dirname(workingRel),
    "backups",
    `${stamp}-${String(runId || "manual").slice(0, 8)}`,
    path.posix.basename(workingRel),
  );
  const backupAbs = path.join(ctx.root, backupRel);
  await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
  await fsp.copyFile(workingAbs, backupAbs);

  const tempTarget = `${workingAbs}.tmp-${process.pid}`;
  await fsp.copyFile(result.file, tempTarget);
  await fsp.rename(tempTarget, workingAbs);

  const material = ctx.store.indexFile(workingRel, {
    source: "agent",
    author: "Workbench",
    note: "模型更新（LibreOffice 重算）",
    status: "draft",
    visibility: "checkpoint",
    runId,
    reason: "model update",
  });

  state.model = state.model && typeof state.model === "object" ? state.model : {};
  state.model.last_applied = {
    at: new Date().toISOString(),
    run_id: runId,
    changes: normalizedChanges,
    outputs: normalizedOutputs.map((output) => ({
      ...output,
      before: before[refOf(output.sheet, output.cell)] ?? null,
      after: after[refOf(output.sheet, output.cell)] ?? null,
    })),
    backup: backupRel,
  };
  await writeState(ctx, path.posix.join(path.posix.dirname(tracking.relPath || tracking.targetPath), "analysis-state.json"), state);

  fs.rmSync(result.workDir, { recursive: true, force: true });
  return {
    ok: true,
    workingFile: workingRel,
    backupRel,
    material,
    before,
    after,
    changes: normalizedChanges,
    outputs: normalizedOutputs,
  };
}
