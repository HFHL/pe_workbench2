#!/usr/bin/env node
/**
 * Approval service integration test.
 *
 * Uses a real SQLite store, a real xlsx fixture and LibreOffice recalculation.
 * The agent is not involved: a normalized tracking result is handed to the
 * approval service exactly the way settleTrackingRun will hand it over.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openStore } from "../store.mjs";
import { createApprovalService } from "../lib/approvals/service.mjs";
import { applyModelChanges, prepareWorkingModel } from "../lib/model-writer.mjs";
import { normalizeTrackingResult } from "../lib/tracking.mjs";
import { readCells } from "../lib/calc-engine.mjs";
import { createTrackingService } from "../server/tracking/service.mjs";

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  fail ${name}`);
    console.error(`       ${error.stack || error.message}`);
    failed += 1;
  }
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-approval-"));
const PROJECT = path.join(ROOT, "project");
await fsp.mkdir(path.join(PROJECT, "exports", "track"), { recursive: true });
await fsp.mkdir(path.join(PROJECT, "uploads"), { recursive: true });
await fsp.mkdir(path.join(PROJECT, "inputs"), { recursive: true });
execFileSync("python3", [
  path.join(import.meta.dirname, "fixtures", "make-workbook-fixture.py"),
  path.join(PROJECT, "uploads", "model.xlsx"),
  "100",
], { stdio: "ignore" });

const store = await openStore({
  root: ROOT,
  workspace: PROJECT,
  projectId: "product-eng",
  seed: false,
});
const ctx = { id: "product-eng", root: PROJECT, store, name: "Product Eng" };

const events = [];
const service = createApprovalService({
  store,
  broadcast: (event) => events.push(event),
  applyModelChanges,
  libreOfficeAvailable: true,
});
ctx.approvals = service;

const trackingService = createTrackingService({
  config: { skillsDir: path.join(import.meta.dirname, "..", "skills") },
  bus: { broadcastGlobal() {} },
  projectManager: { list: () => [ctx] },
  sessions: { createEntry: async () => { throw new Error("not used"); } },
  broadcastMaterial() {},
  broadcastTracking() {},
});

const targetPath = "exports/track/report.md";
await fsp.writeFile(path.join(PROJECT, targetPath), "# Report\n\nBaseline\n", "utf8");
const stateRel = "exports/track/analysis-state.json";
await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify({
  subject: { model_file: "uploads/model.xlsx" },
  model: {
    files: [{ absolute_path: "uploads/model.xlsx" }],
    write_enabled: false,
    bindings: [],
    outputs: [],
  },
}, null, 2));

const target = store.indexFile(targetPath, { source: "agent", status: "draft" });
const stateMaterial = store.indexFile(stateRel, { source: "agent", status: "draft" });
const tracking = store.createTracking({
  targetId: target.id,
  templateId: "model",
  freq: "weekly",
  weekday: 1,
  time: "09:00",
});

// Prepare the working model through the real production path.
const prepared = await prepareWorkingModel({
  ctx,
  tracking: { relPath: targetPath },
  state: JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8")),
  stateRel,
});
assert.equal(prepared.workingFile, "exports/track/model/工作模型.xlsx");
const workingMaterial = store.findMaterialByPath(prepared.workingFile);
assert.ok(workingMaterial);

// Enable write-back only for verified input B2, output B4.
const state = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
state.model.write_enabled = true;
state.model.bindings = [{ metric: "Revenue", sheet: "Model", cell: "B2", verified: true }];
state.model.outputs = [{ label: "Gross profit", sheet: "Model", cell: "B4" }];
await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(state, null, 2));
store.indexFile(stateRel, { source: "agent", status: "draft" });

function trackingResult(runId, value = 120, outputCell = "Model!B4") {
  return normalizeTrackingResult({
    status: "updated",
    headline: "Revenue update",
    conclusion: "Revenue changed",
    summary: "Actual revenue is 120.",
    modelChanges: [{ metric: "Revenue", sheet: "Model", cell: "B2", value, note: "actual" }],
    modelOutputs: [{ label: "Gross profit", sheet: "Model", cell: outputCell.split("!").pop() }],
    sources: [{ label: "Actuals.xlsx", date: "2026-10-20" }],
  }, {
    trackingId: tracking.id,
    targetId: target.id,
    targetPath,
    templateId: "model",
    baseVersion: target.versions[0].v,
    resultVersion: null,
    nowLabel: "2026-10-20 09:00",
    duration: "1m",
    fallbackConclusion: "done",
    fallbackSummary: "",
    status: "needs_review",
    runId,
    trigger: "manual",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
}

async function createProposal(value = 120, outputCell = "Model!B4") {
  const run = store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: target.versions[0].v });
  const result = trackingResult(run.id, value, outputCell);
  store.finishTrackingRun(tracking.id, run.id, {
    status: "needs_review",
    message: "等待人工确认",
    result,
  });
  const proposal = await service.propose({
    ctx,
    tracking: store.getTracking(tracking.id),
    trackingRunId: result.run.id,
    threadId: "thread_test",
    result,
    state: JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8")),
    stateRel,
  });
  assert.equal(proposal.ok, true, proposal.reason);
  return { result, proposal };
}

function versions() {
  return store.findMaterialByPath(prepared.workingFile)?.versions.length || 0;
}

console.log("\nproposal persistence");
await run("creates a pending proposal without modifying the workbook", async () => {
  const before = versions();
  const { proposal } = await createProposal();
  assert.equal(proposal.approval.status, "pending_approval");
  assert.equal(proposal.proposal.proposalId.startsWith("prop_"), true);
  assert.equal(proposal.proposal.workingModel.baseVersion, workingMaterial.versions[0].v);
  assert.equal(proposal.proposal.changes[0].ref, "Model!B2");
  assert.equal(proposal.proposal.changes[0].from, 100);
  assert.equal(proposal.proposal.changes[0].to, 120);
  assert.equal(proposal.proposal.changes[0].bindingVerified, true);
  assert.equal(proposal.proposal.changes[0].formulaCell, false);
  assert.equal(proposal.proposal.validation.writeEnabled, true);
  assert.equal(versions(), before, "proposal must not create a version");
  assert.equal(service.list({ trackingId: tracking.id }).length >= 1, true);
});

await run("refresh reads the same pending proposal", async () => {
  const [approval] = service.list({ trackingId: tracking.id, status: "pending_approval" });
  const fresh = service.get(approval.id);
  assert.equal(fresh.id, approval.id);
  assert.equal(fresh.payload.changes[0].ref, "Model!B2");
});

console.log("\napprove");
let appliedApproval;
await run("approve applies, recalculates and creates one new version", async () => {
  const [approval] = service.list({ status: "pending_approval" });
  const before = versions();
  const result = await service.approve({ ctx, id: approval.id });
  assert.equal(result.ok, true, result.error);
  appliedApproval = result.approval;
  assert.equal(appliedApproval.status, "applied");
  assert.ok(appliedApproval.appliedAt);
  assert.equal(versions(), before + 1);
  const values = await readCells(path.join(PROJECT, prepared.workingFile), ["Model!B2", "Model!B4"]);
  assert.equal(values["Model!B2"], 120);
  assert.equal(values["Model!B4"], 80);
  const run = store.getTrackingRun(appliedApproval.runId);
  assert.equal(run.status, "updated");
  const stored = JSON.parse(run.result_json);
  assert.equal(stored.writeback.approval.status, "applied");
  assert.ok(stored.writeback.model.version >= 1);
});

await run("approve is idempotent", async () => {
  const before = versions();
  const result = await service.approve({ ctx, id: appliedApproval.id });
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(versions(), before);
});

await run("concurrent approve applies exactly once", async () => {
  const { proposal } = await createProposal(130);
  const before = versions();
  const [first, second] = await Promise.all([
    service.approve({ ctx, id: proposal.approval.id }),
    service.approve({ ctx, id: proposal.approval.id }),
  ]);
  assert.equal(versions(), before + 1);
  const statuses = [first.approval?.status, second.approval?.status].sort();
  assert.ok(statuses.includes("applied"), statuses);
  assert.ok(statuses.every((status) => ["applied", "applying", "approved"].includes(status)), statuses);
  const record = store.getApprovalRequest(proposal.approval.id);
  assert.equal(record.status, "applied");
});

await run("approve while applying returns pending, not success", async () => {
  const { proposal } = await createProposal(120);
  store.transitionApproval(proposal.approval.id, {
    fromStatuses: ["pending_approval"],
    status: "applying",
    decision: { approvedAt: new Date().toISOString(), by: "test" },
  });
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 202);
  assert.equal(result.pending, true);
  assert.equal(versions(), before);
});

console.log("\nreject");
await run("reject writes no version and stores the reason", async () => {
  const { proposal } = await createProposal();
  // Reset the run result for the second proposal.
  const before = versions();
  const rejected = await service.reject({ ctx, id: proposal.approval.id, reason: "numbers not final" });
  assert.equal(rejected.ok, true, rejected.error);
  assert.equal(rejected.approval.status, "rejected");
  assert.equal(rejected.approval.decision.reason, "numbers not final");
  assert.equal(versions(), before);
  const again = await service.reject({ ctx, id: proposal.approval.id, reason: "again" });
  assert.equal(again.already, true);
  assert.equal(versions(), before);
  const run = store.getTrackingRun(proposal.approval.runId);
  assert.equal(run.status, "needs_review");
  assert.equal(run.message, "模型变更已拒绝");
  const stored = JSON.parse(run.result_json);
  assert.equal(stored.writeback.approval.status, "rejected");
  assert.match(stored.writeback.note, /文件未修改/);
});

await run("approved request cannot be rejected", async () => {
  const refused = await service.reject({ ctx, id: appliedApproval.id, reason: "late" });
  assert.equal(refused.ok, false);
  assert.equal(refused.httpStatus, 409);
});

console.log("\nconflict");
await run("baseline change returns 409 and never applies the stale proposal", async () => {
  const { proposal } = await createProposal();
  // Simulate a newer working-model version after the proposal was generated.
  const workingAbs = path.join(PROJECT, prepared.workingFile);
  // Re-index the same bytes with forceVersion to simulate another writer's
  // legitimate new version without corrupting the xlsx.
  store.indexFile(prepared.workingFile, { forceVersion: true, source: "agent" });
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false, result.error);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.code, "conflict");
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
  const run = store.getTrackingRun(proposal.approval.runId);
  const stored = JSON.parse(run.result_json);
  assert.equal(stored.writeback.approval.status, "conflict");
});

await run("write-disabled revalidation fails without applying", async () => {
  const { proposal } = await createProposal();
  const disabled = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
  disabled.model.write_enabled = false;
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(disabled, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
});

await run("analysis-state cannot redirect approval to another workbook", async () => {
  const enabled = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
  enabled.model.write_enabled = true;
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(enabled, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
  const { proposal } = await createProposal();
  const redirected = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
  redirected.model.working_file = "uploads/model.xlsx";
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(redirected, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
  // Restore the real working file for later tests.
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(enabled, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
});

await run("missing LibreOffice is a conflict, not a write", async () => {
  const enabled = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
  enabled.model.write_enabled = true;
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(enabled, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
  const { proposal } = await createProposal();
  const strictService = createApprovalService({
    store,
    broadcast: () => {},
    applyModelChanges,
    libreOfficeAvailable: false,
  });
  const before = versions();
  const result = await strictService.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
});

await run("missing output cell is a conflict, not a write", async () => {
  const { proposal } = await createProposal(120, "Model!Z99");
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
});

await run("tracking settlement creates a proposal instead of writing", async () => {
  const before = versions();
  const run = store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: target.versions[0].v });
  run.trigger = "manual";
  const resultRel = `.tracking/${tracking.id}/${run.id}.json`;
  const resultAbs = path.join(PROJECT, resultRel);
  await fsp.mkdir(path.dirname(resultAbs), { recursive: true });
  await fsp.writeFile(resultAbs, JSON.stringify({
    status: "updated",
    conclusion: "Revenue changed",
    summary: "Waiting for approval",
    modelChanges: [{ metric: "Revenue", sheet: "Model", cell: "B2", value: 140, note: "actual" }],
    modelOutputs: [{ label: "Gross profit", sheet: "Model", cell: "B4" }],
  }), "utf8");
  const stateMaterial = store.findMaterialByPath(stateRel);
  const entry = {
    id: "thread_settle_test",
    session: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
  };
  await trackingService.settleTrackingRun({
    ctx,
    trackingId: tracking.id,
    runId: run.id,
    entry,
    run,
    targetId: target.id,
    baseVersion: target.versions[0].v,
    resultAbs,
    backupRel: null,
    error: null,
    monitorMode: false,
    monitorItems: [],
    stateRel,
    stateBaseVersion: stateMaterial?.versions?.[0]?.v ?? null,
  });
  const settled = store.getTrackingRun(run.id);
  assert.equal(settled.status, "needs_review");
  const stored = JSON.parse(settled.result_json);
  assert.equal(stored.schema.name, "pe.tracking-result");
  assert.equal(stored.writeback.approval.status, "pending_approval");
  const approvals = store.listApprovalRequests({ trackingId: tracking.id, status: "pending_approval" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].payload.changes[0].ref, "Model!B2");
  assert.equal(approvals[0].payload.changes[0].to, 140);
  assert.equal(versions(), before);
});

await run("out-of-band file edit is detected by re-hashing", async () => {
  const enabled = JSON.parse(await fsp.readFile(path.join(PROJECT, stateRel), "utf8"));
  enabled.model.write_enabled = true;
  await fsp.writeFile(path.join(PROJECT, stateRel), JSON.stringify(enabled, null, 2));
  store.indexFile(stateRel, { source: "agent", status: "draft" });
  const { proposal } = await createProposal();
  const workingAbs = path.join(PROJECT, prepared.workingFile);
  fs.appendFileSync(workingAbs, Buffer.from("\n"));
  const before = versions();
  const result = await service.approve({ ctx, id: proposal.approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.approval.status, "conflict");
  assert.equal(versions(), before);
});

console.log("\nrecovery");
await run("recoverApplyingApprovals turns applying into failed", async () => {
  const { proposal } = await createProposal();
  store.transitionApproval(proposal.approval.id, {
    fromStatuses: ["pending_approval"],
    status: "applying",
    decision: { approvedAt: new Date().toISOString() },
  });
  const recovered = store.recoverApplyingApprovals();
  assert.equal(recovered >= 1, true);
  const after = store.getApprovalRequest(proposal.approval.id);
  assert.equal(after.status, "failed");
});

await run("corrupt payload fails closed", async () => {
  const approval = store.createApprovalRequest({
    kind: "model_change",
    status: "pending_approval",
    payload: { not: "a proposal" },
    trackingId: tracking.id,
    runId: "run_bad",
    threadId: "thread_test",
  });
  const result = await service.approve({ ctx, id: approval.id });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.equal(store.getApprovalRequest(approval.id).status, "conflict");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
