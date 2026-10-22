/**
 * Test-only fixture routes. Disabled unless WORKBENCH_TEST=1.
 *
 * The browser suite needs a real workbook, a real prepared working model and a
 * real pending proposal without calling a model provider. Everything here uses
 * the same approval service and file paths as production; only the seeding is
 * synthetic.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { normalizeTrackingResult } from "../../lib/tracking.mjs";

export async function handleTesting({ req, res, url, app, ctx }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/testing/")) return false;
  if (!app.config.testMode) {
    app.http.json(res, 404, { error: "not found" });
    return true;
  }

  if (pathname === "/api/testing/approvals" && req.method === "POST") {
    const body = await app.http.readJson(req).catch(() => ({}));
    const scenario = String(body.scenario || "approve");
    try {
      const seeded = await seedApproval({ ctx, app, scenario });
      app.http.json(res, 201, seeded);
    } catch (error) {
      app.http.json(res, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/testing/reset" && req.method === "POST") {
    const rows = ctx.store.db.prepare(
      `select id from trackings where workspace_id = ? and target_id in (
         select id from materials where workspace_id = ? and path like 'exports/test-approval/%'
       )`,
    ).all(ctx.id, ctx.id);
    for (const row of rows) ctx.store.deleteTracking(row.id);
    ctx.store.db.prepare(`delete from approval_requests where workspace_id = ?`).run(ctx.id);
    const root = path.join(ctx.root, "exports", "test-approval");
    await fsp.rm(root, { recursive: true, force: true });
    app.http.json(res, 200, { ok: true });
    return true;
  }

  app.http.json(res, 404, { error: "not found" });
  return true;
}

async function seedApproval({ ctx, app, scenario }) {
  const stamp = Date.now().toString(36);
  const dirRel = `exports/test-approval/${stamp}`;
  const dirAbs = path.join(ctx.root, dirRel);
  await fsp.mkdir(path.join(dirAbs, "model"), { recursive: true });

  const sourceRel = `${dirRel}/source.xlsx`;
  const sourceAbs = path.join(ctx.root, sourceRel);
  execFileSync("python3", [
    path.join(app.config.root, "scripts", "fixtures", "make-workbook-fixture.py"),
    sourceAbs,
    "100",
  ], { stdio: "ignore" });
  ctx.store.indexFile(sourceRel, { source: "agent", status: "draft" });

  const targetRel = `${dirRel}/report.md`;
  await fsp.writeFile(path.join(ctx.root, targetRel), "# Test report\n\nBaseline\n", "utf8");
  const target = ctx.store.indexFile(targetRel, { source: "agent", status: "draft" });

  const stateRel = `${dirRel}/analysis-state.json`;
  const state = {
    subject: { model_file: sourceRel },
    model: {
      files: [{ absolute_path: sourceRel }],
      write_enabled: false,
      bindings: [],
      outputs: [],
    },
  };
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", status: "draft" });

  const prepared = await app.prepareWorkingModel({
    ctx,
    tracking: { relPath: targetRel },
    state,
    stateRel,
  });
  const enabled = JSON.parse(await fsp.readFile(path.join(ctx.root, stateRel), "utf8"));
  enabled.model.write_enabled = true;
  enabled.model.bindings = [{ metric: "Revenue", sheet: "Model", cell: "B2", verified: true }];
  enabled.model.outputs = [{ label: "Gross profit", sheet: "Model", cell: "B4" }];
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(enabled, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", status: "draft" });

  const tracking = ctx.store.createTracking({
    targetId: target.id,
    templateId: "model",
    freq: "weekly",
    weekday: 1,
    time: "09:00",
  });
  const run = ctx.store.startTrackingRun(tracking.id, {
    trigger: "manual",
    baseVersion: target.versions[0].v,
  });
  run.trigger = "manual";

  const result = normalizeTrackingResult({
    status: "needs_review",
    headline: "Revenue update needs approval",
    conclusion: "Revenue changed from 100 to 120.",
    summary: "The actual revenue is 120. Gross profit should be recalculated.",
    confidence: "中",
    modelChanges: [{ metric: "Revenue", sheet: "Model", cell: "B2", value: 120, note: "actual revenue" }],
    modelOutputs: [{ label: "Gross profit", sheet: "Model", cell: "B4" }],
    sources: [{ label: "Actuals.xlsx", date: "2026-10-20" }],
  }, {
    trackingId: tracking.id,
    targetId: target.id,
    targetPath: targetRel,
    templateId: "model",
    baseVersion: target.versions[0].v,
    resultVersion: null,
    nowLabel: "2026-10-20 09:00",
    duration: "1m",
    fallbackConclusion: "done",
    fallbackSummary: "",
    status: "needs_review",
    runId: run.id,
    trigger: "manual",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });

  const proposed = await ctx.approvals.propose({
    ctx,
    tracking: ctx.store.getTracking(tracking.id),
    trackingRunId: run.id,
    threadId: `test-thread-${stamp}`,
    result,
    state: enabled,
    stateRel,
  });
  if (!proposed.ok) throw new Error(proposed.reason);
  result.writeback.approval = {
    id: proposed.approval.id,
    status: proposed.approval.status,
    createdAt: proposed.approval.createdAt,
  };
  ctx.store.finishTrackingRun(tracking.id, run.id, {
    status: "needs_review",
    message: "等待模型写回审批",
    result,
  });

  if (scenario === "conflict") {
    // Simulate a newer version written after the proposal was generated.
    ctx.store.indexFile(prepared.workingFile, { forceVersion: true, source: "agent" });
  }

  app.bus.broadcastGlobal({
    type: "approval.created",
    approval: ctx.approvals.get(proposed.approval.id),
  }, ctx.id);
  app.bus.broadcastGlobal({ type: "tracking.updated", tracking: ctx.store.getTracking(tracking.id) }, ctx.id);
  return {
    approval: ctx.approvals.get(proposed.approval.id),
    trackingId: tracking.id,
    runId: run.id,
    workingFile: prepared.workingFile,
    scenario,
  };
}
