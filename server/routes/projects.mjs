import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleProjects({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const { defaultStore, projectManager, ensureProjectDirs, PROJECTS_DIR, MODEL_ID, DEFAULT_PROJECT_ID, ASR_ENABLED, ASR_API_KEY, ASR_API_BASE, ANYSEARCH_QUERY, ANYSEARCH_API_KEY, ANYSEARCH_API_BASE, WEB_FETCH, WEB_FETCH_ALLOW_PRIVATE, CALC_INFO, COPILOTKIT_ENABLED } = app;
  const pathname = url.pathname;
  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      model: MODEL_ID,
      projects: defaultStore.listProjects(),
      defaultProject: DEFAULT_PROJECT_ID,
      trackingScheduler: process.env.TRACKING_SCHEDULER !== "0",
      monitorScheduler: process.env.MONITOR_SCHEDULER !== "0",
      sourceScheduler: process.env.SOURCE_SCHEDULER !== "0",
      features: {
        copilotkit: Boolean(COPILOTKIT_ENABLED),
      },
      copilotkit: {
        enabled: Boolean(COPILOTKIT_ENABLED),
        runtimeUrl: "/api/copilotkit",
      },
      asr: {
        enabled: ASR_ENABLED,
        configured: Boolean(ASR_API_KEY),
        apiBase: ASR_API_BASE,
      },
      anysearch: {
        enabled: ANYSEARCH_QUERY,
        configured: Boolean(ANYSEARCH_API_KEY),
        apiBase: ANYSEARCH_API_BASE,
      },
      webFetch: {
        enabled: WEB_FETCH,
        allowPrivate: WEB_FETCH_ALLOW_PRIVATE,
      },
      calc: {
        available: CALC_INFO.available,
        bin: CALC_INFO.bin,
        version: CALC_INFO.version,
      },
    });
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    return json(res, 200, defaultStore.listProjects());
  }

  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readJson(req);
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) return json(res, 400, { error: "项目名称不能为空" });
    const note = String(body.note || "").trim().slice(0, 60) || "个人项目";
    const id = `p-${crypto.randomBytes(4).toString("hex")}`;
    const rootPath = path.join(PROJECTS_DIR, id);
    await ensureProjectDirs(rootPath);
    const dto = defaultStore.createProject({ id, name, note, rootPath });
    const row = defaultStore.getProjectRow(id);
    await projectManager.open(row);
    return json(res, 201, dto);
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "PATCH") {
    let id;
    try {
      id = decodeURIComponent(projectMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid project id" });
    }
    const body = await readJson(req);
    const dto = defaultStore.updateProject(id, {
      name: body.name != null ? String(body.name).trim().slice(0, 40) || undefined : undefined,
      note: body.note != null ? String(body.note).trim().slice(0, 60) : undefined,
      accent: body.accent,
    });
    if (!dto) return json(res, 404, { error: "project not found" });
    const ctx = projectManager.get(id);
    if (ctx) {
      ctx.name = dto.name;
      ctx.note = dto.note;
      ctx.accent = dto.accent;
      ctx.store.projectName = dto.name;
    }
    return json(res, 200, dto);
  }

  return json(res, 404, { error: "not found" });
}
