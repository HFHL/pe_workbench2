/**
 * Environment and path configuration.
 *
 * Importing this module has no side effects beyond reading a local env file. It
 * never starts a server, a scheduler or an interval.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getModel } from "@earendil-works/pi-ai/compat";
import { sofficeInfo } from "../lib/calc-engine.mjs";
import { DEFAULT_PROJECT_ID } from "../store.mjs";

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadEnvFile(file, env = process.env) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!env[key]) env[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* optional */
  }
}

export async function loadConfig({ env = process.env, root = REPO_ROOT } = {}) {
  loadEnvFile(path.join(root, ".env.local"), env);

  const storageRoot = path.resolve(env.WORKBENCH_STORAGE_ROOT || root);
  const projectsDir = path.resolve(env.WORKBENCH_PROJECTS_DIR || path.join(storageRoot, "projects"));
  const defaultProjectRoot = path.join(projectsDir, DEFAULT_PROJECT_ID);
  const modelId = env.PI_MODEL || "deepseek-v4-pro";
  const allowedModels = new Set(["deepseek-v4-pro", "deepseek-flash"]);
  const workbookQuery = env.WORKBOOK_QUERY !== "0";
  const pdfRead = env.PDF_READ !== "0";
  const westockQuery = env.WESTOCK_QUERY !== "0";
  const anysearchQuery = env.ANYSEARCH_QUERY !== "0";
  const webFetch = env.WEB_FETCH !== "0";
  const asrEnabled = env.ASR !== "0";
  const toolNames = ["read", "write", "edit", "grep", "find", "ls", "create_tracking"];
  if (workbookQuery) toolNames.push("workbook_query");
  if (pdfRead) toolNames.push("pdf_read");
  if (westockQuery) toolNames.push("westock_query");
  if (anysearchQuery) toolNames.push("anysearch_search");
  if (webFetch) toolNames.push("web_fetch");
  if (asrEnabled) toolNames.push("asr_read");

  const fakeAgent = env.PI_FAKE_AGENT === "1";
  const model = fakeAgent ? null : getModel("deepseek", modelId);

  return Object.freeze({
    root,
    storageRoot,
    dataDir: path.join(storageRoot, "data"),
    projectsDir,
    defaultProjectRoot,
    legacyWorkspace: path.join(storageRoot, "agent-workspace"),
    agentDir: path.join(root, ".pi-agent"),
    skillsDir: path.join(root, "skills"),
    defaultProjectId: DEFAULT_PROJECT_ID,
    port: Number(env.PORT || 8080),
    host: env.HOST || "127.0.0.1",
    modelId,
    allowedModels,
    model,
    fakeAgent,
    testMode: env.WORKBENCH_TEST === "1",
    // Opt-in only. The pilot bundle is never requested when this is false and
    // the URL flag is absent.
    copilotkitEnabled: env.COPILOTKIT_CORE_EXPERIMENT === "1",
    workbookQuery,
    pdfRead,
    westockQuery,
    anysearchQuery,
    anysearchApiKey: env.ANYSEARCH_API_KEY || "",
    anysearchApiBase: env.ANYSEARCH_API_BASE || "https://api.anysearch.com",
    webFetch,
    webFetchAllowPrivate: env.WEB_FETCH_ALLOW_PRIVATE === "1",
    asrEnabled,
    asrApiKey: env.ASR_API_KEY || env.ZHILING_API_KEY || "",
    asrApiBase: env.ASR_API_BASE || "https://api.17zhiling.com",
    seedDemo: env.WORKBENCH_SEED === "1",
    toolNames,
    trackingSchedulerEnabled: env.TRACKING_SCHEDULER !== "0",
    monitorSchedulerEnabled: env.MONITOR_SCHEDULER !== "0",
    sourceSchedulerEnabled: env.SOURCE_SCHEDULER !== "0",
    trackingMaxRuntimeMs: Number(env.TRACKING_MAX_RUNTIME_MS || 15 * 60 * 1000),
    calcInfo: await sofficeInfo(),
  });
}
