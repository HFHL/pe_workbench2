/**
 * Workbench composition root.
 *
 * Wires configuration, project contexts, session service, tracking service,
 * schedulers, routes and the HTTP server. Importing this module does not listen;
 * call createWorkbench() and then listen().
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { getModel } from "@earendil-works/pi-ai/compat";

import { loadConfig } from "./config.mjs";
import {
  json,
  readBody,
  readJson,
  sendText,
  MIME,
  parseByteRange,
  serveStatic,
} from "./http/respond.mjs";
import { createEventBus } from "./events/bus.mjs";
import { createProjectManager, ensureProjectDirs } from "./project-context.mjs";
import { createSessionService } from "./agent/session-service.mjs";
import { lastAssistantText, makeTitle } from "./agent/snapshot.mjs";
import { createTrackingService } from "./tracking/service.mjs";
import { createTrackingScheduler } from "./schedulers/tracking.mjs";
import { createMonitorScheduler } from "./schedulers/monitor.mjs";
import { createSourceScheduler } from "./schedulers/source.mjs";
import { handleAgUiRequest } from "../lib/agent-protocol/ag-ui-endpoint.mjs";
import { openStore } from "../store.mjs";
import {
  TRACKING_TEMPLATES,
  normalizeSchedule,
  templateForFile,
} from "../lib/tracking.mjs";
import {
  computeNextCheck,
  deriveMonitorPlan,
  normalizeMonitorItem,
  validateMonitorPlan,
} from "../lib/monitoring.mjs";
import { prepareWorkingModel } from "../lib/model-writer.mjs";
import { handleProjects } from "./routes/projects.mjs";
import { handleApprovals } from "./routes/approvals.mjs";
import { handleAgUi } from "./routes/ag-ui.mjs";
import { handleCopilotKit } from "./routes/copilotkit.mjs";
import { handleSessions } from "./routes/sessions.mjs";
import { handleMaterials } from "./routes/materials.mjs";
import { handleTracking } from "./routes/tracking.mjs";
import { handlePlans } from "./routes/plans.mjs";
import { handleTesting } from "./routes/testing.mjs";

export async function createWorkbench({ config: providedConfig = null, logger = console } = {}) {
  const config = providedConfig || await loadConfig();
  const MODEL_ID = config.modelId;
  const ALLOWED_MODELS = config.allowedModels;
  const DEFAULT_PROJECT_ID = config.defaultProjectId;
  const WORKBOOK_QUERY = config.workbookQuery;
  const PDF_READ = config.pdfRead;
  const ASR_ENABLED = config.asrEnabled;
  const ASR_API_KEY = config.asrApiKey;
  const ASR_API_BASE = config.asrApiBase;
  const ANYSEARCH_QUERY = config.anysearchQuery;
  const ANYSEARCH_API_KEY = config.anysearchApiKey;
  const ANYSEARCH_API_BASE = config.anysearchApiBase;
  const WEB_FETCH = config.webFetch;
  const WEB_FETCH_ALLOW_PRIVATE = config.webFetchAllowPrivate;
  const SEED_DEMO = config.seedDemo;
  const CALC_INFO = config.calcInfo;
  const COPILOTKIT_ENABLED = config.copilotkitEnabled === true;
  const ROOT = config.root;
  const PROJECTS_DIR = config.projectsDir;
  const bus = createEventBus();
  const live = new Map();
  let sessions = null;
  let tracking = null;

  const nowIso = () => new Date().toISOString();
  const broadcast = (entry, payload) => bus.broadcast(entry, payload);
  const broadcastGlobal = (payload, projectId = null) => bus.broadcastGlobal(payload, projectId);

  let projectManager = null;
function withAsr(ctx, material) {
  if (!ctx?.asr || !material) return material;
  try {
    return ctx.asr.attach(material);
  } catch (error) {
    console.warn(`[asr] attach failed for ${material.id}: ${error.message}`);
    return material;
  }
}

function broadcastMaterial(material, projectId = null) {
  if (!material) return;
  const pid = projectId || material.projectId;
  const decorated = withAsr(projectManager.get(pid), material);
  broadcastGlobal({ type: "material.updated", material: decorated }, pid);
}

function broadcastPlan(plan, projectId = null) {
  if (!plan) return;
  broadcastGlobal({ type: "plan.updated", plan }, projectId || plan.projectId);
}

function broadcastTracking(tracking, projectId = null) {
  if (!tracking) return;
  broadcastGlobal({ type: "tracking.updated", tracking }, projectId || tracking.projectId);
}

function warmWorkbook(ctx, material) {
  if (!WORKBOOK_QUERY || !material || !ctx.workbooks.isSupportedName(material.relPath)) return;
  void ctx.workbooks
    .warm(material.id)
    .then((info) => {
      broadcastGlobal({ type: "material.parsed", id: material.id, ...info }, ctx.id);
    })
    .catch((error) => {
      console.warn(`[workbook] parse failed for ${ctx.id}/${material.relPath}: ${error.message}`);
      broadcastGlobal({
        type: "material.parse_failed",
        id: material.id,
        error: error.message,
      }, ctx.id);
    });
}

function warmPdf(ctx, material) {
  if (!PDF_READ || !material || !ctx.pdfs.isSupportedName(material.relPath)) return;
  void ctx.pdfs
    .warm(material.id)
    .then((info) => {
      broadcastGlobal({ type: "material.parsed", id: material.id, kind: "pdf", ...info }, ctx.id);
    })
    .catch((error) => {
      console.warn(`[pdf] parse failed for ${ctx.id}/${material.relPath}: ${error.message}`);
      broadcastGlobal({
        type: "material.parse_failed",
        id: material.id,
        kind: "pdf",
        error: error.message,
      }, ctx.id);
    });
}

/**
 * Uploaded/restored audio is queued for background transcription immediately.
 * The await only covers the local DB write (no network), so the upload response
 * can already show "排队中". Set `notify: false` because the caller broadcasts.
 */
async function warmAsr(ctx, material) {
  if (!ctx.asr || !material || !ctx.asr.isAudio(material.relPath)) return material;
  try {
    await ctx.asr.autoStart(material.id, { notify: false });
  } catch (error) {
    console.warn(`[asr] enqueue failed for ${ctx.id}/${material.relPath}: ${error.message}`);
  }
  return ctx.store.getMaterial(material.id) || material;
}

async function maybeMaterialSaved(entry, toolName, args) {
  if (toolName !== "write" && toolName !== "edit") return;
  const ctx = entry.ctx;
  const root = path.resolve(ctx.root);
  const target = typeof args?.path === "string" ? path.resolve(root, args.path) : "";
  if (!target || !target.startsWith(root + path.sep)) return;
  try {
    const rel = path.relative(ctx.root, target).split(path.sep).join("/");
    if (rel.startsWith(".tracking/") || rel.includes("/backups/")) return;
    const isState = path.posix.basename(rel) === "analysis-state.json";
    const run = entry.trackingRun || null;
    const material = ctx.store.indexFile(rel, {
      source: "agent",
      author: "Workbench",
      note: isState ? "监测观察值" : "Agent 更新",
      status: "draft",
      // The state file is the machine truth and changes on every check. Keep
      // tracking-driven revisions for audit without turning each observation
      // into a user-visible version. Manual edits outside a run stay checkpoints.
      visibility: isState && run ? "internal" : "checkpoint",
      runId: run?.runId || null,
      reason: isState && run ? "monitor observation" : null,
    });
    broadcastMaterial(material, ctx.id);
    broadcast(entry, { type: "material.updated", material: withAsr(ctx, material) });
    warmWorkbook(ctx, material);
    warmPdf(ctx, material);
    void warmAsr(ctx, material).then((next) => {
      if (!next?.asr) return;
      broadcastMaterial(next, ctx.id);
      broadcast(entry, { type: "material.updated", material: next });
    });
  } catch {
    /* file may not exist (dry run or error) */
  }
}


async function runPlan(ctx, planId) {
  const store = ctx.store;
  const row = store.getPlanRow(planId);
  if (!row) {
    const error = new Error("plan not found");
    error.status = 404;
    throw error;
  }
  const plan = store.getPlan(planId);
  if (plan.running) {
    const error = new Error("plan is running");
    error.status = 409;
    throw error;
  }

  const targetBefore = row.target_id
    ? (store.getMaterial(row.target_id)?.versions?.[0]?.v ?? 0)
    : 0;
  const run = store.startPlanRun(planId);
  broadcastPlan(store.getPlan(planId), ctx.id);

  const entry = await sessions.createEntry({ id: crypto.randomUUID(), ctx });
  entry.title = `[计划] ${row.name}`;
  entry.session.setSessionName(entry.title);
  entry.updatedAt = nowIso();

  const target = row.target_id ? store.getMaterial(row.target_id) : null;
  const inputs = store.getPlan(planId).inputIds.map((id) => store.getMaterial(id)).filter(Boolean);
  const prompt = [
    row.prompt || `更新 ${target?.relPath || "目标产出"}`,
    target ? `目标产出：${target.relPath}` : "",
    inputs.length ? `监控资料：${inputs.map((item) => item.relPath).join("、")}` : "",
    "完成后用一句话说明更新了什么。",
  ].filter(Boolean).join("\n");

  let settled = false;
  const unsubscribe = entry.session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    settled = true;
    unsubscribe();

    const latest = row.target_id ? store.getMaterial(row.target_id) : null;
    const latestVersion = latest?.versions?.[0]?.v ?? null;
    const version = latestVersion && latestVersion > targetBefore ? latestVersion : null;
    const failed = entry.session.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    );
    const dto = store.finishPlanRun(planId, run.id, {
      ok: !failed,
      message: failed ? "运行失败" : version ? `成功 · 产出 v${version}` : "成功 · 无变化",
      version,
    });
    broadcastPlan(dto, ctx.id);
  });

  entry.session.prompt(prompt, {}).catch((error) => {
    if (settled) return;
    unsubscribe();
    const dto = store.finishPlanRun(planId, run.id, {
      ok: false,
      message: error?.message || "运行失败",
      version: null,
    });
    broadcastPlan(dto, ctx.id);
  });

  return { runId: run.id, sessionId: entry.id, plan: store.getPlan(planId) };
}

/* ---------- tracking runs ---------- */


  let defaultStore = null;
  await (async () => {
    const manager = createProjectManager({
      config,
      bus,
      broadcastMaterial,
      broadcastTracking,
    });
    projectManager = manager;
    const effectiveDefaultRoot = await manager.migrateLayout();

    defaultStore = await openStore({
      root: config.storageRoot,
      workspace: effectiveDefaultRoot,
      projectId: DEFAULT_PROJECT_ID,
      projectName: "Product Eng",
      projectNote: "个人项目",
      seed: SEED_DEMO,
    });

    const recoveredPlans = defaultStore.recoverPlanRuns();
    if (recoveredPlans) logger.log?.(`[plan] marked ${recoveredPlans} interrupted run(s) as failed`);

    for (const row of defaultStore.listProjectRows()) {
      await manager.open(row, row.id === DEFAULT_PROJECT_ID ? defaultStore : null);
    }

    for (const ctx of manager.list()) {
      const recovered = ctx.store.recoverTrackingRuns();
      if (recovered) logger.log?.(`[tracking] ${ctx.id}: marked ${recovered} interrupted run(s) as failed`);
      const recoveredApprovals = ctx.approvals.recoverApplying();
      if (recoveredApprovals) logger.log?.(`[approval] ${ctx.id}: marked ${recoveredApprovals} interrupted apply(s) as failed`);
      const seeded = ctx.store.seedTrackings();
      if (seeded) logger.log?.(`[tracking] ${ctx.id}: seeded ${seeded} tracking(s)`);
    }
  })();

  sessions = createSessionService({
    config,
    bus,
    projectManager,
    live,
    onMaterialSaved: maybeMaterialSaved,
  });

  tracking = createTrackingService({
    config,
    bus,
    projectManager,
    sessions,
    broadcastMaterial,
    broadcastTracking,
    logger,
  });
  const {
    activeTrackingRuns,
    runTracking,
    readTrackingState,
    writeTrackingState,
    syncSourceBindings,
    pollSourceBinding,
    ingestUploadEvent,
    triageSourceEvent,
  } = tracking;

  const trackingScheduler = createTrackingScheduler({
    contexts: projectManager.contexts,
    runTracking,
    activeTrackingRuns,
    onError: (ctx, trackingId) => {
      broadcastTracking(ctx.store.getTracking(trackingId), ctx.id);
    },
    enabled: config.trackingSchedulerEnabled,
    logger,
  });
  const monitorScheduler = createMonitorScheduler({
    contexts: projectManager.contexts,
    runTracking,
    activeTrackingRuns,
    enabled: config.monitorSchedulerEnabled,
    logger,
  });
  const sourceScheduler = createSourceScheduler({
    contexts: projectManager.contexts,
    pollSourceBinding,
    nowIso,
    enabled: config.sourceSchedulerEnabled,
    logger,
  });

async function serveVersionFile(ctx, req, res, url, materialId, version) {
  const row = ctx.store.getVersionRow(materialId, version);
  if (!row) return json(res, 404, { error: "version not found" });
  const blob = ctx.store.blobPath(row.version.blob_sha256);
  let stat;
  try {
    stat = await fsp.stat(blob);
  } catch {
    return json(res, 404, { error: "version content not found" });
  }
  if (!stat.isFile()) return json(res, 404, { error: "version content not found" });

  const ext = path.extname(row.material.path).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const download = url.searchParams.get("download") === "1";
  const fileName = row.version.displayName || path.basename(row.material.path);
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, stat.size);
    if (!range) {
      res.writeHead(416, {
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      return res.end();
    }
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(blob, { start: range.start, end: range.end }).pipe(res);
  }

  headers["Content-Length"] = stat.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(blob).pipe(res);
}

/* ---------- api ---------- */

function projectFor(req, url) {
  const id = String(url.searchParams.get("project") || req.headers["x-project-id"] || DEFAULT_PROJECT_ID);
  const ctx = projectManager.get(id);
  if (!ctx) throw Object.assign(new Error("project not found"), { status: 404 });
  return ctx;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (
    pathname === "/api/health"
    || pathname === "/api/projects"
    || pathname.startsWith("/api/projects/")
  ) {
    return handleProjects({ req, res, url, app });
  }

  const ctx = projectFor(req, url);
  if (pathname.startsWith("/api/testing/")) {
    return handleTesting({ req, res, url, app, ctx });
  }
  if (pathname.startsWith("/api/approvals")) {
    return handleApprovals({ req, res, url, app, ctx });
  }
  if (pathname.startsWith("/api/ag-ui/")) {
    return handleAgUi({ req, res, url, app, ctx });
  }
  if (pathname.startsWith("/api/copilotkit")) {
    return handleCopilotKit({ req, res, url, app, ctx });
  }
  if (
    pathname === "/api/sessions"
    || pathname.startsWith("/api/sessions/")
    || pathname === "/api/events"
  ) {
    return handleSessions({ req, res, url, app, ctx });
  }
  if (
    pathname === "/api/materials"
    || pathname.startsWith("/api/materials/")
    || pathname === "/api/upload"
    || pathname === "/api/file"
  ) {
    return handleMaterials({ req, res, url, app, ctx });
  }
  if (pathname === "/api/plans" || pathname.startsWith("/api/plans/")) {
    return handlePlans({ req, res, url, app, ctx });
  }
  if (
    pathname === "/api/trackings"
    || pathname.startsWith("/api/trackings/")
    || pathname.startsWith("/api/monitors/")
    || pathname.startsWith("/api/runs/")
    || pathname === "/api/notifications"
    || pathname.startsWith("/api/notifications/")
  ) {
    return handleTracking({ req, res, url, app, ctx });
  }
  return json(res, 404, { error: "not found" });
}

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      const served = await serveStatic({ root: ROOT, req, res, pathname: url.pathname });
      if (!served) json(res, 404, { error: "not found" });
      return undefined;
    } catch (error) {
      logger.error?.(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.message || "internal error" });
      else res.end();
      return undefined;
    }
  });

  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 60 * 1000;

  function listen(port = config.port, host = config.host) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        logger.log?.(`Workbench listening on http://${host}:${actualPort}`);
        logger.log?.(`model: ${MODEL_ID} · projects: ${[...projectManager.contexts.keys()].join(", ")}`);
        logger.log?.(
          `asr: ${ASR_ENABLED ? (ASR_API_KEY ? "enabled" : "enabled (ASR_API_KEY missing)") : "disabled"} · ${ASR_API_BASE}`,
        );
        logger.log?.(
          `anysearch: ${ANYSEARCH_QUERY ? (ANYSEARCH_API_KEY ? "enabled" : "enabled (anonymous)") : "disabled"} · ${ANYSEARCH_API_BASE}`,
        );
        logger.log?.(`web_fetch: ${WEB_FETCH ? "enabled" : "disabled"}${WEB_FETCH_ALLOW_PRIVATE ? " (private targets allowed)" : ""}`);
        trackingScheduler.start();
        monitorScheduler.start();
        sourceScheduler.start();
        resolve({ port: actualPort, host, url: `http://${host}:${actualPort}` });
      });
    });
  }

  function close() {
    trackingScheduler.stop();
    monitorScheduler.stop();
    sourceScheduler.stop();
    sessions?.close();
    projectManager?.close();
    bus.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  const app = {
    config,
    logger,
    bus,
    broadcast,
    live,
    projectManager,
    defaultStore,
    sessions,
    tracking,
    http: { json, readJson, sendText, MIME },
    getModel,
    MODEL_ID,
    makeTitle,
    ALLOWED_MODELS,
    PROJECTS_DIR,
    ASR_ENABLED,
    ASR_API_KEY,
    ASR_API_BASE,
    ANYSEARCH_QUERY,
    ANYSEARCH_API_KEY,
    ANYSEARCH_API_BASE,
    WEB_FETCH,
    WEB_FETCH_ALLOW_PRIVATE,
    CALC_INFO,
    COPILOTKIT_ENABLED,
    WORKBOOK_QUERY,
    PDF_READ,
    ensureProjectDirs,
    handleAgUiRequest,
    serveVersionFile,
    prepareWorkingModel,
    TRACKING_TEMPLATES,
    normalizeSchedule,
    templateForFile,
    computeNextCheck,
    deriveMonitorPlan,
    normalizeMonitorItem,
    validateMonitorPlan,
    nowIso,
    schedulers: { tracking: trackingScheduler, monitor: monitorScheduler, source: sourceScheduler },
    server,
    listen,
    close,
    createEntry: (args) => sessions.createEntry(args),
    ensureEntry: (id, ctx) => sessions.ensureEntry(id, ctx),
    listSessions: (ctx) => sessions.listSessions(ctx),
    runTracking,
    readTrackingState,
    writeTrackingState,
    syncSourceBindings,
    pollSourceBinding,
    ingestUploadEvent,
    triageSourceEvent,
    broadcastMaterial,
    broadcastTracking,
    broadcastPlan,
    withAsr,
    warmWorkbook,
    warmPdf,
    warmAsr,
    maybeMaterialSaved,
    handleApi,
    projectFor,
    runPlan,
    broadcastGlobal,
  };
  return app;
}

export default createWorkbench;
