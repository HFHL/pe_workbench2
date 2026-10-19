import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { DEFAULT_PROJECT_ID, openStore } from "./store.mjs";
import { WorkbookStore } from "./lib/workbook-store.mjs";
import { ExcelPreviewStore } from "./lib/excel-preview.mjs";
import { createWorkbookTool } from "./lib/workbook-tool.mjs";
import { PdfStore } from "./lib/pdf-store.mjs";
import { createPdfTool } from "./lib/pdf-tool.mjs";
import { createWestockTool } from "./lib/westock-tool.mjs";
import { AsrService } from "./lib/asr.mjs";
import { createAsrTool } from "./lib/asr-tool.mjs";
import { AUDIO_EXTS } from "./lib/asr-status.mjs";
import {
  TRACKING_TEMPLATES,
  buildTrackingPrompt,
  fallbackTrackingResult,
  normalizeSchedule,
  normalizeTrackingResult,
  templateForFile,
  templateFor,
} from "./lib/tracking.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(ROOT, "projects");
const LEGACY_WORKSPACE = path.join(ROOT, "agent-workspace");
let DEFAULT_PROJECT_ROOT = path.join(PROJECTS_DIR, DEFAULT_PROJECT_ID);
const AGENT_DIR = path.join(ROOT, ".pi-agent");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";

/* ---------- env ---------- */

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!process.env[key]) process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* optional */
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));

const MODEL_ID = process.env.PI_MODEL || "deepseek-v4-pro";
const ALLOWED_MODELS = new Set(["deepseek-v4-pro", "deepseek-flash"]);
const WORKBOOK_QUERY = process.env.WORKBOOK_QUERY !== "0";
const PDF_READ = process.env.PDF_READ !== "0";
const WESTOCK_QUERY = process.env.WESTOCK_QUERY !== "0";
const ASR_ENABLED = process.env.ASR !== "0";
const ASR_API_KEY = process.env.ASR_API_KEY || process.env.ZHILING_API_KEY || "";
const ASR_API_BASE = process.env.ASR_API_BASE || "https://api.17zhiling.com";
// Demo files/plans are opt-in. A fresh workbench starts empty.
const SEED_DEMO = process.env.WORKBENCH_SEED === "1";
const TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"];
if (WORKBOOK_QUERY) TOOL_NAMES.push("workbook_query");
if (PDF_READ) TOOL_NAMES.push("pdf_read");
if (WESTOCK_QUERY) TOOL_NAMES.push("westock_query");
if (ASR_ENABLED) TOOL_NAMES.push("asr_read");

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set (put it in .env.local or the environment)");
  process.exit(1);
}

const model = getModel("deepseek", MODEL_ID);
if (!model) {
  console.error(`Unknown model: ${MODEL_ID}`);
  process.exit(1);
}

/* ---------- projects ---------- */

async function ensureProjectDirs(root) {
  const dirs = ["exports", "inputs", "uploads", ".tracking", ".pi/sessions", ".agents/skills"];
  await Promise.all(dirs.map((rel) => fsp.mkdir(path.join(root, rel), { recursive: true })));
}

async function migrateProjectLayout() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  // The original workspace is already a valid project root. Keep it in place so
  // existing Pi session headers (which embed the cwd) stay discoverable; new
  // projects live under projects/<id>.
  if (fs.existsSync(LEGACY_WORKSPACE)) DEFAULT_PROJECT_ROOT = LEGACY_WORKSPACE;
  await ensureProjectDirs(DEFAULT_PROJECT_ROOT);
}

const contexts = new Map();
const live = new Map();
const globalClients = new Map();

function systemHint(ctx) {
  return `你是 Workbench，一个产品团队的研究与写作助手。

当前项目：${ctx.name}（根目录：${ctx.root}）
- \`exports/\` 放产出（文档、报告、变更说明）
- \`uploads/\` 放用户上传的资料
- \`inputs/\` 是只读资料

规则：
- 用中文回答，先给结论，简洁，不解释界面功能。
- 需要数据时先用工具读取文件，不要臆测。
- 写文件优先放 \`exports/\`，不要修改 \`inputs/\`。
- 改完文件用一句话说明改了什么、路径是什么。
- 分析/报告类任务把完整报告写入 \`exports/\` 下的 \`.md\` 文件；回答给结论摘要，界面会展开报告全文。
${WORKBOOK_QUERY ? "- 查询 .xlsx/.xlsm 模型时使用 workbook_query；不要用 read 直接读二进制，也不要临时写 python 解析。" : ""}
${PDF_READ ? "- 读取 .pdf 时使用 pdf_read：先拿章节与页概览，再用 page 读指定页或 query 检索；不要用 read 直接读 PDF。引用正文时标注页码（p.N）。" : ""}
${ASR_ENABLED ? "- 读取 .mp3/.wav 音频时使用 asr_read：它会返回转写状态或全文；不要用 read 直接读音频二进制。上传后的音频会自动在后台转写，完成前不要臆测内容。" : ""}
${WESTOCK_QUERY ? "- 查询行情、财报、研报、公告、资金、宏观等金融数据时使用 westock_query；不要用 web_search 或训练数据替代。" : ""}
- 回答使用 Markdown，但不要使用表格。`;
}

async function openProjectContext(row, existingStore = null) {
  await ensureProjectDirs(row.root_path);
  const store = existingStore || await openStore({
    root: ROOT,
    workspace: row.root_path,
    projectId: row.id,
    projectName: row.name,
    projectNote: row.note || "",
    seed: false,
  });
  const workbooks = new WorkbookStore({ store });
  const previews = new ExcelPreviewStore({ store });
  const pdfs = new PdfStore({ store });
  const workbookTool = WORKBOOK_QUERY
    ? createWorkbookTool({
        store,
        workbooks,
        workspace: row.root_path,
        onMaterial: (material) => broadcastMaterial(material, row.id),
      })
    : null;
  const pdfTool = PDF_READ
    ? createPdfTool({
        store,
        pdfs,
        workspace: row.root_path,
        onMaterial: (material) => broadcastMaterial(material, row.id),
      })
    : null;
  const westockTool = WESTOCK_QUERY ? createWestockTool({ workspace: row.root_path }) : null;
  // ASR is content-addressed by blob sha, so the service can be per project
  // while the transcript cache and poll state live in the shared SQLite file.
  const asr = ASR_ENABLED
    ? new AsrService({
        store,
        apiKey: ASR_API_KEY,
        apiBase: ASR_API_BASE,
        autoStart: false,
        onChange: (materialId) => {
          const material = store.getMaterial(materialId);
          if (material) broadcastMaterial(material, row.id);
        },
      })
    : null;
  const asrTool = ASR_ENABLED
    ? createAsrTool({
        store,
        asr,
        workspace: row.root_path,
        onMaterial: (material) => broadcastMaterial(material, row.id),
      })
    : null;
  const ctx = {
    id: row.id,
    name: row.name,
    note: row.note || "",
    accent: row.accent || "slate",
    root: row.root_path,
    sessionsDir: path.join(row.root_path, ".pi", "sessions"),
    uploadsDir: path.join(row.root_path, "uploads"),
    store,
    workbooks,
    previews,
    pdfs,
    asr,
    tools: [workbookTool, pdfTool, westockTool, asrTool].filter(Boolean),
  };
  contexts.set(ctx.id, ctx);
  // Boot after the context is registered so the first ASR broadcast can
  // decorate the material and reach the right project.
  asr?.boot();
  return ctx;
}

await migrateProjectLayout();

const defaultStore = await openStore({
  root: ROOT,
  workspace: DEFAULT_PROJECT_ROOT,
  projectId: DEFAULT_PROJECT_ID,
  projectName: "Product Eng",
  projectNote: "个人项目",
  seed: SEED_DEMO,
});

const recoveredPlans = defaultStore.recoverPlanRuns();
if (recoveredPlans) console.log(`[plan] marked ${recoveredPlans} interrupted run(s) as failed`);

for (const row of defaultStore.listProjectRows()) {
  await openProjectContext(row, row.id === DEFAULT_PROJECT_ID ? defaultStore : null);
}

for (const ctx of contexts.values()) {
  const recovered = ctx.store.recoverTrackingRuns();
  if (recovered) console.log(`[tracking] ${ctx.id}: marked ${recovered} interrupted run(s) as failed`);
  const seeded = ctx.store.seedTrackings();
  if (seeded) console.log(`[tracking] ${ctx.id}: seeded ${seeded} tracking(s)`);
}

/* ---------- sessions ---------- */

function nowIso() {
  return new Date().toISOString();
}

function isProjectSkill(skill, ctx) {
  const file = path.resolve(skill.filePath);
  const roots = [
    path.join(ctx.root, ".agents", "skills"),
    path.join(ctx.root, ".pi", "skills"),
    path.join(AGENT_DIR, "skills"),
  ];
  return roots.some((root) => file === root || file.startsWith(root + path.sep));
}

function makeLoader(ctx) {
  return new DefaultResourceLoader({
    cwd: ctx.root,
    agentDir: AGENT_DIR,
    appendSystemPromptOverride: (base) => [...base, systemHint(ctx)],
    // Workbench 只加载当前项目内的 Skill。用户级 ~/.agents/skills
    // （CrewAI、Remotion、Coze 等全局技能）不进入产品提示，避免路由干扰。
    skillsOverride: (base) => ({
      skills: base.skills.filter((skill) => isProjectSkill(skill, ctx)),
      diagnostics: base.diagnostics,
    }),
  });
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function shortPath(ctx, value) {
  if (typeof value !== "string") return "";
  const rel = path.relative(ctx.root, path.resolve(ctx.root, value));
  if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
  return value;
}

function toolDetail(ctx, name, args = {}) {
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return shortPath(ctx, args.path || ".");
    case "grep":
      return args.pattern || "";
    case "find":
      return args.pattern || "";
    case "bash":
      return args.command || "";
    case "workbook_query":
      return `${shortPath(ctx, args.path || "")} · ${args.query || ""}`.trim();
    case "asr_read":
      return shortPath(ctx, args.path || "");
    case "westock_query":
      return Array.isArray(args.args) ? args.args.join(" ").slice(0, 120) : "";
    default:
      return JSON.stringify(args || {}).slice(0, 80);
  }
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return textOfContent(result.content);
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return "";
  }
}

function hm(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function snapshotMessages(session, ctx) {
  const results = new Map();
  for (const message of session.messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }

  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const segments = current.segments || [];
    let lastTool = -1;
    segments.forEach((segment, index) => {
      if (segment.type === "tool") lastTool = index;
    });

    const processParts = [];
    const finalParts = [];
    segments.forEach((segment, index) => {
      if (segment.type !== "text") return;
      if (index > lastTool) finalParts.push(segment.text);
      else processParts.push(segment.text);
    });

    let text = finalParts.join("\n\n").trim();
    let processText = processParts.join("\n\n").trim();
    if (!text && processText) {
      // If the model ended on a tool call, keep its last paragraph as the answer.
      const parts = processText.split("\n\n");
      text = parts.pop() || "";
      processText = parts.join("\n\n").trim();
    }

    if (text || processText || current.tools.length) {
      out.push({
        role: "assistant",
        text,
        processText,
        tools: current.tools,
        time: current.time,
      });
    }
    current = null;
  };

  for (const message of session.messages) {
    if (message.role === "user") {
      flush();
      const userText = textOfContent(message.content).replace(/\n\n\[已上传资料\][\s\S]*$/, "");
      out.push({ role: "user", text: userText, time: hm(message.timestamp) });
      continue;
    }
    if (message.role !== "assistant") continue;

    if (!current) current = { role: "assistant", segments: [], tools: [], time: hm(message.timestamp) };
    const text = textOfContent(message.content);
    if (text) current.segments.push({ type: "text", text });

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      current.segments.push({ type: "tool" });
      current.tools.push({
        id: block.id,
        name: block.name,
        detail: toolDetail(ctx, block.name, block.arguments || {}),
        status: result ? (result.isError ? "error" : "done") : "done",
        output: result ? resultText(result).slice(0, 4000) : "",
      });
    }
  }
  flush();
  return out;
}

function makeTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "新会话";
  const first = clean.split(/[，。！？；,.!?;\n]/)[0].trim() || clean;
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

function titleFromMessages(session) {
  const firstUser = session.messages.find((message) => message.role === "user");
  return makeTitle(firstUser ? textOfContent(firstUser.content) : "");
}

function serializeSession(entry) {
  return {
    type: "snapshot",
    sessionId: entry.id,
    title: entry.title,
    messages: snapshotMessages(entry.session, entry.ctx),
    streaming: entry.session.isStreaming,
    model: entry.modelId,
    projectId: entry.ctx.id,
  };
}

function sendToClient(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* disconnected */
  }
}

function broadcast(entry, payload) {
  for (const client of entry.clients) sendToClient(client, payload);
}

function broadcastGlobal(payload, projectId = null) {
  for (const [client, project] of globalClients) {
    if (projectId && project && project !== projectId) continue;
    sendToClient(client, payload);
  }
}

/** Attach the canonical ASR summary to a material DTO (list/SSE/upload). */
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
  const decorated = withAsr(contexts.get(pid), material);
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

function blockOutsideProject(ctx, toolName, args) {
  if (!args || typeof args !== "object") return null;
  const candidate = args.path;
  if (typeof candidate !== "string" || !candidate) return null;
  const absolute = path.resolve(ctx.root, candidate);
  const inside = absolute === ctx.root || absolute.startsWith(ctx.root + path.sep);
  if (inside) return null;
  return { block: true, reason: `${toolName} 只能访问当前项目内的路径` };
}

async function maybeMaterialSaved(entry, toolName, args) {
  if (toolName !== "write" && toolName !== "edit") return;
  const ctx = entry.ctx;
  const target = typeof args?.path === "string" ? path.resolve(ctx.root, args.path) : "";
  if (!target || !target.startsWith(ctx.root + path.sep)) return;
  try {
    const rel = path.relative(ctx.root, target).split(path.sep).join("/");
    if (rel.startsWith(".tracking/") || rel.includes("/backups/")) return;
    const material = ctx.store.indexFile(rel, {
      source: "agent",
      author: "Workbench",
      note: "Agent 更新",
      status: "draft",
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

function attachEvents(entry) {
  entry.unsubscribe = entry.session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        broadcast(entry, { type: "run.started" });
        break;
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") {
          broadcast(entry, { type: "assistant.delta", delta: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start": {
        entry.toolArgs.set(event.toolCallId, event.args || {});
        broadcast(entry, {
          type: "tool.started",
          id: event.toolCallId,
          name: event.toolName,
          detail: toolDetail(entry.ctx, event.toolName, event.args || {}),
        });
        break;
      }
      case "tool_execution_update":
        broadcast(entry, {
          type: "tool.updated",
          id: event.toolCallId,
          output: resultText(event.partialResult).slice(0, 800),
        });
        break;
      case "tool_execution_end": {
        const args = entry.toolArgs.get(event.toolCallId) || {};
        entry.toolArgs.delete(event.toolCallId);
        broadcast(entry, {
          type: "tool.completed",
          id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? "error" : "done",
          detail: toolDetail(entry.ctx, event.toolName, args),
          output: resultText(event.result).slice(0, 4000),
        });
        void maybeMaterialSaved(entry, event.toolName, args);
        break;
      }
      case "agent_settled": {
        entry.updatedAt = nowIso();
        const title = entry.session.sessionName || entry.title;
        entry.title = title;
        broadcast(entry, { type: "run.settled", aborted: event.aborted });
        broadcast(entry, {
          type: "session.updated",
          id: entry.id,
          title,
          messageCount: entry.session.messages.length,
          updatedAt: entry.updatedAt,
        });
        break;
      }
    }
  });
}

async function createEntry({ id, file, ctx }) {
  if (!ctx) throw Object.assign(new Error("project not found"), { status: 404 });
  const sessionManager = file
    ? SessionManager.open(file, ctx.sessionsDir)
    : SessionManager.create(ctx.root, ctx.sessionsDir, id ? { id } : undefined);

  const loader = makeLoader(ctx);
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.root,
    agentDir: AGENT_DIR,
    model: getModel("deepseek", MODEL_ID),
    thinkingLevel: "off",
    sessionManager,
    resourceLoader: loader,
    tools: TOOL_NAMES,
    customTools: ctx.tools,
  });

  session.agent.beforeToolCall = async ({ toolCall, args }) =>
    blockOutsideProject(ctx, toolCall.name, args) ?? undefined;

  const entry = {
    id: session.sessionId,
    session,
    ctx,
    clients: new Set(),
    toolArgs: new Map(),
    title: session.sessionName || titleFromMessages(session),
    modelId: MODEL_ID,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    unsubscribe: null,
  };
  attachEvents(entry);
  live.set(entry.id, entry);
  return entry;
}

async function ensureEntry(id, ctx = null) {
  const existing = live.get(id);
  if (existing) {
    if (ctx && existing.ctx.id !== ctx.id) return null;
    return existing;
  }
  const candidates = ctx ? [ctx] : Array.from(contexts.values());
  for (const candidate of candidates) {
    const file = SessionManager.findById(candidate.root, id, candidate.sessionsDir);
    if (file) return createEntry({ id, file, ctx: candidate });
  }
  return null;
}

async function listSessions(ctx) {
  const infos = await SessionManager.list(ctx.root, ctx.sessionsDir);
  const items = infos
    .filter((info) => !/^\[(计划|跟踪)\]/.test(String(info.name || "")))
    .map((info) => ({
      id: info.id,
      title: info.name || makeTitle(info.firstMessage) || "未命名会话",
      messageCount: info.messageCount,
      updatedAt: info.modified.toISOString(),
    }));

  for (const entry of live.values()) {
    if (entry.ctx.id !== ctx.id) continue;
    if (/^\[(计划|跟踪)\]/.test(String(entry.session.sessionName || entry.title || ""))) continue;
    const item = {
      id: entry.id,
      title: entry.session.sessionName || entry.title || "新会话",
      messageCount: entry.session.messages.length,
      updatedAt: entry.updatedAt,
    };
    const index = items.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
  }

  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return items;
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

  const entry = await createEntry({ id: crypto.randomUUID(), ctx });
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

const activeTrackingRuns = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fullNowLabel(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatRunDuration(startedAt, endedAt = new Date()) {
  const seconds = Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function lastAssistantText(session) {
  const messages = session?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

function backupStamp(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}

async function backupTrackingTarget(ctx, target, runId) {
  const targetAbs = path.join(ctx.root, target.relPath);
  const dir = path.posix.dirname(target.relPath);
  const base = path.posix.basename(target.relPath);
  const rel = path.posix.join(dir, "backups", `${backupStamp()}-${runId.slice(0, 8)}`, base);
  const absolute = path.join(ctx.root, rel);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.copyFile(targetAbs, absolute);
  return rel;
}

async function readTrackingResult(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function settleTrackingRun({
  ctx,
  trackingId,
  runId,
  entry,
  run,
  targetId,
  baseVersion,
  resultAbs,
  backupRel,
  error,
}) {
  const store = ctx.store;
  try {
    // Give the write tool's indexing callback a beat to finish.
    await sleep(320);
    const row = store.getTrackingRow(trackingId);
    const target = store.getMaterial(targetId);
    const latestVersion = target?.versions?.[0]?.v ?? baseVersion;
    const versionIncreased = latestVersion > baseVersion;
    const rawResult = error ? null : await readTrackingResult(resultAbs);
    const finalText = entry ? lastAssistantText(entry.session) : "";
    const failed = Boolean(error) || Boolean(
      entry?.session.messages?.some(
        (message) => message.role === "assistant" && message.stopReason === "error",
      ),
    );

    let status;
    if (failed) status = "failed";
    else if (rawResult?.status === "needs_review") status = "needs_review";
    else if (rawResult?.status === "no_change") status = "no_change";
    else if (rawResult?.status === "updated" || versionIncreased) status = "updated";
    else status = "no_change";

    const template = templateFor(row?.template_id);
    if (!failed && template.writeMode === "propose_only" && !versionIncreased) {
      status = "needs_review";
    }

    const endedAt = new Date();
    const context = {
      trackingId,
      targetId,
      targetPath: target?.relPath || "",
      templateId: row?.template_id || "generic",
      baseVersion,
      resultVersion: versionIncreased ? latestVersion : null,
      nowLabel: fullNowLabel(endedAt),
      duration: formatRunDuration(run.startedAt, endedAt),
      fallbackConclusion: finalText ? finalText.split(/\n/)[0].slice(0, 180) : "跟踪运行完成",
      fallbackSummary: finalText.slice(0, 2400),
      status,
      backupPath: backupRel,
    };

    if (failed) {
      const dto = store.finishTrackingRun(trackingId, runId, {
        status: "failed",
        message: error?.message || "运行失败",
        sessionId: entry?.id || null,
      });
      broadcastTracking(dto, ctx.id);
      return;
    }

    const result = rawResult
      ? normalizeTrackingResult(rawResult, context)
      : fallbackTrackingResult(context);
    result.status = status;
    result.target.result_version = versionIncreased ? latestVersion : null;
    result.writeback.version = versionIncreased ? `v${latestVersion}` : "未产生新版本";
    if (backupRel) {
      result.writeback.backup = backupRel;
      const note = String(result.writeback.note || "");
      if (!note.includes(backupRel) && !note.includes("backups/")) {
        result.writeback.note = `${note} 宿主已把原文件备份到 ${backupRel}。`.trim();
      }
    }
    if (status === "no_change" && versionIncreased) {
      result.writeback.note = `${result.writeback.note} 本次同时在目标文件写入了跟踪记录，因此产生了审计版本 v${latestVersion}。`;
    }

    const message = status === "updated"
      ? `更新到 v${latestVersion}`
      : status === "no_change"
        ? (versionIncreased ? `无重大变化 · 审计版本 v${latestVersion}` : "无重大变化")
        : "等待人工确认";
    const dto = store.finishTrackingRun(trackingId, runId, {
      status,
      message,
      resultVersion: versionIncreased ? latestVersion : null,
      result,
      sessionId: entry?.id || null,
    });
    broadcastTracking(dto, ctx.id);
    if (target) broadcastMaterial(target, ctx.id);
  } catch (failure) {
    console.error(`[tracking] settle failed: ${failure.message}`);
    const dto = store.finishTrackingRun(trackingId, runId, {
      status: "failed",
      message: failure.message || "结果处理失败",
      sessionId: entry?.id || null,
    });
    broadcastTracking(dto, ctx.id);
  } finally {
    activeTrackingRuns.delete(trackingId);
  }
}

function trackingWorkspaceFiles(ctx, target) {
  const targetPath = target?.relPath || "";
  const files = [];
  for (const material of ctx.store.listMaterials()) {
    const relPath = material?.relPath;
    if (!relPath || relPath === targetPath) continue;
    if (relPath.startsWith(".tracking/") || relPath.includes("/backups/")) continue;
    const version = material.versions?.[0];
    files.push({
      path: relPath,
      name: material.name,
      kind: material.kind === "output" ? "output" : "input",
      version: version?.v ?? 1,
      size: version?.size ?? null,
      updatedAt: version?.createdAt || material.updatedAt || "",
    });
  }
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "input" ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return files.slice(0, 80);
}

async function runTracking(ctx, trackingId, { trigger = "manual", scheduledFor = null } = {}) {
  const store = ctx.store;
  if (activeTrackingRuns.has(trackingId)) {
    throw Object.assign(new Error("tracking is running"), { status: 409 });
  }
  const row = store.getTrackingRow(trackingId);
  if (!row) throw Object.assign(new Error("tracking not found"), { status: 404 });
  const current = store.getTracking(trackingId);
  if (current?.running) throw Object.assign(new Error("tracking is running"), { status: 409 });
  const target = store.getMaterial(row.target_id);
  if (!target) throw Object.assign(new Error("target file not found"), { status: 400 });

  const baseVersion = target.versions?.[0]?.v ?? 0;
  activeTrackingRuns.add(trackingId);
  let run;
  try {
    run = store.startTrackingRun(trackingId, {
      trigger,
      baseVersion,
      scheduledFor,
    });
  } catch (error) {
    activeTrackingRuns.delete(trackingId);
    throw error;
  }
  broadcastTracking(store.getTracking(trackingId), ctx.id);

  const resultRel = `.tracking/${trackingId}/${run.id}.json`;
  const resultAbs = path.join(ctx.root, resultRel);
  const template = templateFor(row.template_id);
  let backupRel = null;
  let entry;
  try {
    await fsp.mkdir(path.dirname(resultAbs), { recursive: true });
    if (template.writeMode === "in_place") {
      backupRel = await backupTrackingTarget(ctx, target, run.id);
    }
    entry = await createEntry({ id: crypto.randomUUID(), ctx });
  } catch (error) {
    activeTrackingRuns.delete(trackingId);
    store.clearTrackingLease(trackingId);
    const dto = store.finishTrackingRun(trackingId, run.id, {
      status: "failed",
      message: error?.message || "无法备份目标文件或创建跟踪会话",
    });
    broadcastTracking(dto, ctx.id);
    throw error;
  }

  entry.title = `[跟踪] ${current?.targetName || target.name}`;
  entry.session.setSessionName(entry.title);
  entry.updatedAt = nowIso();

  const prompt = buildTrackingPrompt({
    trackingId,
    runId: run.id,
    targetPath: target.relPath,
    targetName: target.name,
    templateId: row.template_id,
    baseVersion,
    resultRelPath: resultRel,
    backupRelPath: backupRel,
    trigger,
    workspaceFiles: trackingWorkspaceFiles(ctx, target),
  });

  let settled = false;
  let unsubscribe = null;
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    try {
      unsubscribe?.();
    } catch {
      /* ignore */
    }
    void settleTrackingRun({
      ctx,
      trackingId,
      runId: run.id,
      entry,
      run,
      targetId: row.target_id,
      baseVersion,
      resultAbs,
      backupRel,
      error,
    });
  };

  unsubscribe = entry.session.subscribe((event) => {
    if (event.type === "agent_settled") finish(null);
  });

  try {
    entry.session.prompt(prompt, {}).catch((error) => finish(error));
  } catch (error) {
    finish(error);
  }

  return {
    runId: run.id,
    sessionId: entry.id,
    tracking: store.getTracking(trackingId),
  };
}

let trackingTickBusy = false;

async function tickTrackings() {
  if (trackingTickBusy) return;
  trackingTickBusy = true;
  try {
    for (const ctx of contexts.values()) {
      const store = ctx.store;
      const due = store.listDueTrackings(new Date());
      let started = false;
      for (const row of due) {
        if (activeTrackingRuns.has(row.id)) continue;
        const leaseUntil = new Date(Date.now() + 10 * 60 * 1000);
        if (!store.claimTracking(row.id, leaseUntil)) continue;
        try {
          await runTracking(ctx, row.id, {
            trigger: "schedule",
            scheduledFor: row.next_run_at,
          });
          started = true;
        } catch (error) {
          console.warn(`[tracking] scheduled run failed (${ctx.id}): ${error.message}`);
          store.clearTrackingLease(row.id);
          broadcastTracking(store.getTracking(row.id), ctx.id);
        }
        // One agent run per tick keeps the local machine responsive.
        break;
      }
      if (started) break;
    }
  } catch (error) {
    console.warn(`[tracking] scheduler tick failed: ${error.message}`);
  } finally {
    trackingTickBusy = false;
  }
}

function startTrackingScheduler() {
  if (process.env.TRACKING_SCHEDULER === "0") {
    console.log("[tracking] scheduler disabled by TRACKING_SCHEDULER=0");
    return;
  }
  setInterval(() => { void tickTrackings(); }, 30_000).unref?.();
  setTimeout(() => { void tickTrackings(); }, 3_000).unref?.();
  console.log("[tracking] scheduler started (30s tick)");
}

/* ---------- http helpers ---------- */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text, { filename = "transcript.txt", type = "text/plain; charset=utf-8" } = {}) {
  const payload = Buffer.from(String(text || ""), "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(payload);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".xltm": "application/vnd.ms-excel.template.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
};

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
  let filePath;
  if (pathname === "/" || pathname === "/index.html") filePath = path.join(ROOT, "index.html");
  else if (pathname === "/styles.css") filePath = path.join(ROOT, "styles.css");
  else if (pathname === "/app.js") filePath = path.join(ROOT, "app.js");
  else if (pathname === "/tracking.css") filePath = path.join(ROOT, "tracking.css");
  else if (pathname === "/tracking.js") filePath = path.join(ROOT, "tracking.js");
  else if (pathname === "/suggestions.css") filePath = path.join(ROOT, "suggestions.css");
  else if (pathname === "/suggestions.js") filePath = path.join(ROOT, "suggestions.js");
  else if (pathname === "/vendor/marked.umd.js") filePath = path.join(ROOT, "node_modules", "marked", "lib", "marked.umd.js");
  else if (pathname === "/preview.png") filePath = path.join(ROOT, "preview.png");
  else if (/^\/docs\/ui-shots\/[a-z0-9-]+\.png$/i.test(pathname)) filePath = path.join(ROOT, pathname);
  else return json(res, 404, { error: "not found" });

  try {
    const stat = await fsp.stat(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

/* ---------- versioned file / excel preview helpers ---------- */

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match) return null;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

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
  const ctx = contexts.get(id);
  if (!ctx) throw Object.assign(new Error("project not found"), { status: 404 });
  return ctx;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      model: MODEL_ID,
      projects: defaultStore.listProjects(),
      defaultProject: DEFAULT_PROJECT_ID,
      trackingScheduler: process.env.TRACKING_SCHEDULER !== "0",
      asr: {
        enabled: ASR_ENABLED,
        configured: Boolean(ASR_API_KEY),
        apiBase: ASR_API_BASE,
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
    await openProjectContext(row);
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
    const ctx = contexts.get(id);
    if (ctx) {
      ctx.name = dto.name;
      ctx.note = dto.note;
      ctx.accent = dto.accent;
      ctx.store.projectName = dto.name;
    }
    return json(res, 200, dto);
  }

  const ctx = projectFor(req, url);

  if (pathname === "/api/sessions" && req.method === "GET") {
    return json(res, 200, await listSessions(ctx));
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    const entry = await createEntry({ id: crypto.randomUUID(), ctx });
    return json(res, 201, { id: entry.id, title: entry.title, messageCount: 0, updatedAt: entry.updatedAt });
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    globalClients.set(res, ctx.id);
    sendToClient(res, { type: "hello", projectId: ctx.id });
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      globalClients.delete(res);
    });
    return;
  }

  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(state|events|messages|abort|model)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const entry = await ensureEntry(id, ctx);
    if (!entry) return json(res, 404, { error: "session not found" });

    if (action === "state" && req.method === "GET") {
      return json(res, 200, serializeSession(entry));
    }

    if (action === "events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 2000\n\n");
      entry.clients.add(res);
      sendToClient(res, serializeSession(entry));
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(ping);
        entry.clients.delete(res);
      });
      return;
    }

    if (action === "messages" && req.method === "POST") {
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text && !attachments.length) return json(res, 400, { error: "empty message" });

      const safeAttachments = attachments
        .filter((item) => typeof item === "string")
        .map((item) => path.relative(ctx.root, path.resolve(ctx.root, item)))
        .filter((item) => item && !item.startsWith(".."));

      let promptText = text || "看一下这几个文件。";
      if (safeAttachments.length) {
        promptText += `\n\n[已上传资料]\n${safeAttachments.map((item) => `- ${item}`).join("\n")}`;
      }

      if (entry.title === "新会话" || !entry.title) {
        const title = makeTitle(text);
        entry.title = title;
        entry.session.setSessionName(title);
      }

      entry.updatedAt = nowIso();
      const streaming = entry.session.isStreaming;
      const run = entry.session.prompt(
        promptText,
        streaming ? { streamingBehavior: "followUp" } : {},
      );
      run.catch((error) => {
        broadcast(entry, { type: "run.error", message: error?.message || String(error) });
      });

      broadcast(entry, {
        type: "session.updated",
        id: entry.id,
        title: entry.title,
        messageCount: entry.session.messages.length,
        updatedAt: entry.updatedAt,
      });

      return json(res, 202, { accepted: true, queued: streaming, sessionId: entry.id, title: entry.title });
    }

    if (action === "abort" && req.method === "POST") {
      await entry.session.abort();
      return json(res, 200, { ok: true });
    }

    if (action === "model" && req.method === "POST") {
      const body = await readJson(req);
      const requested = String(body.model || "");
      if (!ALLOWED_MODELS.has(requested)) return json(res, 400, { error: "unsupported model" });
      const next = getModel("deepseek", requested);
      if (!next) return json(res, 400, { error: "model not found" });
      await entry.session.setModel(next);
      entry.modelId = requested;
      broadcast(entry, { type: "session.updated", id: entry.id, title: entry.title, messageCount: entry.session.messages.length, updatedAt: entry.updatedAt, model: requested });
      return json(res, 200, { ok: true, model: requested });
    }
  }

  if (pathname === "/api/materials" && req.method === "GET") {
    return json(res, 200, ctx.store.listMaterials().map((material) => withAsr(ctx, material)));
  }

  /* ---------- ASR ---------- */

  const asrRoute = pathname.match(/^\/api\/materials\/([^/]+)\/asr$/);
  if (asrRoute) {
    if (!ctx.asr) return json(res, 404, { error: "语音转写未启用", code: "disabled" });
    let materialId;
    try {
      materialId = decodeURIComponent(asrRoute[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    try {
      if (req.method === "GET") {
        return json(res, 200, ctx.asr.get(materialId));
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const version = body.version != null ? Number(body.version) : null;
        const result = ctx.asr.start(materialId, {
          versionNumber: Number.isFinite(version) ? version : null,
          force: Boolean(body.force),
          notify: false,
        });
        const material = ctx.store.getMaterial(materialId);
        if (material) broadcastMaterial(material, ctx.id);
        return json(res, 202, { ok: true, asr: result });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }

  const versionAsrRoute = pathname.match(
    /^\/api\/materials\/([^/]+)\/versions\/(\d+)\/asr(?:\/(content))?$/,
  );
  if (versionAsrRoute) {
    if (!ctx.asr) return json(res, 404, { error: "语音转写未启用", code: "disabled" });
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    try {
      materialId = decodeURIComponent(versionAsrRoute[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionAsrRoute[2]);
    try {
      if (versionAsrRoute[3] === "content") {
        const format = url.searchParams.get("format") === "srt" ? "srt" : "txt";
        const payload = ctx.asr.contentText(materialId, version, format);
        const stem = payload.name.replace(/\.[^.]+$/, "");
        return sendText(res, 200, payload.text, {
          filename: `${stem}.${payload.ext}`,
          type: format === "srt" ? "application/x-subrip; charset=utf-8" : "text/plain; charset=utf-8",
        });
      }
      return json(res, 200, ctx.asr.get(materialId, version));
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }

  if (pathname === "/api/trackings") {
    if (req.method === "GET") return json(res, 200, ctx.store.listTrackings());
    if (req.method === "POST") {
      const body = await readJson(req);
      const target = ctx.store.getMaterial(body.targetId);
      if (!target) return json(res, 404, { error: "target file not found" });
      const existing = ctx.store.findTrackingByTarget(target.id);
      if (existing) {
        return json(res, 409, {
          error: "这个文件已经在跟踪中",
          tracking: ctx.store.getTracking(existing.id),
        });
      }
      const templateId = TRACKING_TEMPLATES[body.templateId]
        ? body.templateId
        : templateForFile(target.name);
      if (TRACKING_TEMPLATES[templateId].writeMode === "in_place" && !String(target.relPath).startsWith("exports/")) {
        return json(res, 400, {
          error: "原位更新只能跟踪 exports/ 下的产出文件；uploads/ 和 inputs/ 是只读的",
        });
      }
      const schedule = normalizeSchedule(body);
      try {
        const tracking = ctx.store.createTracking({
          targetId: target.id,
          templateId,
          ...schedule,
        });
        broadcastTracking(tracking, ctx.id);
        return json(res, 201, tracking);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
  }

  const trackingMatch = pathname.match(/^\/api\/trackings\/([^/]+)(?:\/(toggle|run|schedule))?$/);
  if (trackingMatch) {
    let trackingId;
    try {
      trackingId = decodeURIComponent(trackingMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid tracking id" });
    }
    const action = trackingMatch[2];

    if (!action && req.method === "GET") {
      const tracking = ctx.store.getTracking(trackingId);
      return tracking ? json(res, 200, tracking) : json(res, 404, { error: "tracking not found" });
    }
    if (action === "toggle" && req.method === "POST") {
      const tracking = ctx.store.toggleTracking(trackingId);
      if (!tracking) return json(res, 404, { error: "tracking not found" });
      broadcastTracking(tracking, ctx.id);
      return json(res, 200, tracking);
    }
    if (action === "schedule" && (req.method === "POST" || req.method === "PATCH")) {
      const body = await readJson(req);
      const tracking = ctx.store.updateTrackingSchedule(trackingId, normalizeSchedule(body));
      if (!tracking) return json(res, 404, { error: "tracking not found" });
      broadcastTracking(tracking, ctx.id);
      return json(res, 200, tracking);
    }
    if (action === "run" && req.method === "POST") {
      try {
        const result = await runTracking(ctx, trackingId, { trigger: "manual" });
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
    if (!action && req.method === "DELETE") {
      const deleted = ctx.store.deleteTracking(trackingId);
      if (!deleted) return json(res, 404, { error: "tracking not found" });
      broadcastGlobal({ type: "tracking.deleted", id: trackingId }, ctx.id);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/plans" && req.method === "GET") {
    return json(res, 200, ctx.store.listPlans());
  }

  const workbookMatch = pathname.match(/^\/api\/materials\/([^/]+)\/(workbook|query)$/);
  if (workbookMatch) {
    if (!WORKBOOK_QUERY) {
      return json(res, 404, { error: "workbook query is disabled", code: "disabled" });
    }
    const materialId = decodeURIComponent(workbookMatch[1]);

    if (workbookMatch[2] === "workbook" && req.method === "GET") {
      try {
        return json(res, 200, await ctx.workbooks.summary(materialId));
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message,
          code: error.code,
        });
      }
    }

    if (workbookMatch[2] === "query" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const result = await ctx.workbooks.queryMaterial(materialId, body.query, {
          maxCells: body.maxCells,
        });
        return json(res, 200, result);
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message,
          code: error.code,
        });
      }
    }
  }

  const pdfMatch = pathname.match(/^\/api\/materials\/([^/]+)\/pdf(?:\/(search))?$/);
  if (pdfMatch) {
    if (!PDF_READ) {
      return json(res, 404, { error: "pdf reading is disabled", code: "disabled" });
    }
    let materialId;
    try {
      materialId = decodeURIComponent(pdfMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    try {
      if (pdfMatch[2] === "search" && req.method === "POST") {
        const body = await readJson(req);
        return json(res, 200, await ctx.pdfs.search(materialId, body.query, {
          maxSnippets: body.maxSnippets,
        }));
      }
      if (!pdfMatch[2] && req.method === "GET") {
        return json(res, 200, await ctx.pdfs.summary(materialId));
      }
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  const versionPdfMatch = pathname.match(/^\/api\/materials\/([^/]+)\/versions\/(\d+)\/pdf$/);
  if (versionPdfMatch) {
    if (!PDF_READ) {
      return json(res, 404, { error: "pdf reading is disabled", code: "disabled" });
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    try {
      materialId = decodeURIComponent(versionPdfMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionPdfMatch[2]);
    const page = url.searchParams.get("page") || "";
    const query = url.searchParams.get("query") || "";
    const maxChars = Math.min(40000, Math.max(1000, Number(url.searchParams.get("maxChars")) || 12000));
    try {
      if (query) {
        return json(res, 200, await ctx.pdfs.search(materialId, query, { versionNumber: version }));
      }
      if (page) {
        return json(res, 200, await ctx.pdfs.readPages(materialId, page, {
          versionNumber: version,
          maxChars,
        }));
      }
      return json(res, 200, await ctx.pdfs.summary(materialId, version));
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }

  const versionPreviewMatch = pathname.match(
    /^\/api\/materials\/([^/]+)\/versions\/(\d+)\/workbook(?:\/sheets\/(.+))?$/,
  );
  if (versionPreviewMatch) {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    let sheetName = null;
    try {
      materialId = decodeURIComponent(versionPreviewMatch[1]);
      sheetName = versionPreviewMatch[3] ? decodeURIComponent(versionPreviewMatch[3]) : null;
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionPreviewMatch[2]);
    try {
      const payload = sheetName
        ? await ctx.previews.sheet(materialId, version, sheetName)
        : await ctx.previews.manifest(materialId, version);
      return json(res, 200, payload);
    } catch (error) {
      return json(res, error.status || 500, {
        error: error.message,
        code: error.code,
      });
    }
  }

  const versionFileMatch = pathname.match(/^\/api\/materials\/([^/]+)\/versions\/(\d+)\/file$/);
  if (versionFileMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "method not allowed" });
    }
    let materialId;
    try {
      materialId = decodeURIComponent(versionFileMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    return serveVersionFile(ctx, req, res, url, materialId, Number(versionFileMatch[2]));
  }

  const materialMatch = pathname.match(/^\/api\/materials\/([^/]+)(?:\/versions\/(\d+)\/restore)?$/);
  if (materialMatch) {
    const materialId = decodeURIComponent(materialMatch[1]);
    const version = materialMatch[2] ? Number(materialMatch[2]) : null;

    if (version && req.method === "POST") {
      let material = ctx.store.restoreVersion(materialId, version);
      if (!material) return json(res, 404, { error: "version not found" });
      material = await warmAsr(ctx, material);
      broadcastMaterial(material, ctx.id);
      warmWorkbook(ctx, material);
      warmPdf(ctx, material);
      return json(res, 200, withAsr(ctx, material));
    }
    if (req.method === "GET") {
      const material = ctx.store.getMaterial(materialId);
      return material
        ? json(res, 200, withAsr(ctx, material))
        : json(res, 404, { error: "material not found" });
    }
    if (req.method === "DELETE") {
      const removed = ctx.store.deleteMaterial(materialId);
      if (!removed) return json(res, 404, { error: "material not found" });
      broadcastGlobal({ type: "material.deleted", id: materialId }, ctx.id);
      return json(res, 200, { ok: true });
    }
  }

  const planMatch = pathname.match(/^\/api\/plans\/([^/]+)\/(toggle|run)$/);
  if (planMatch) {
    const planId = decodeURIComponent(planMatch[1]);
    if (planMatch[2] === "toggle" && req.method === "POST") {
      const plan = ctx.store.togglePlan(planId);
      if (!plan) return json(res, 404, { error: "plan not found" });
      broadcastPlan(plan, ctx.id);
      return json(res, 200, plan);
    }
    if (planMatch[2] === "run" && req.method === "POST") {
      try {
        const result = await runPlan(ctx, planId);
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
  }

  if (pathname === "/api/upload" && req.method === "POST") {
    const rawName = decodeURIComponent(req.headers["x-file-name"] || "upload.bin");
    const base = path.basename(rawName).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 120) || "upload.bin";
    // Two hours of WAV is large; audio gets a higher ceiling than documents.
    const ext = path.extname(base).slice(1).toLowerCase();
    const limit = AUDIO_EXTS.has(ext) ? 120 * 1024 * 1024 : 30 * 1024 * 1024;
    const body = await readBody(req, limit);
    if (!body.length) return json(res, 400, { error: "empty file" });
    const filename = `${Date.now()}-${base}`;
    const target = path.join(ctx.uploadsDir, filename);
    await fsp.writeFile(target, body);
    const rel = path.relative(ctx.root, target).split(path.sep).join("/");
    let material = ctx.store.indexFile(rel, {
      kind: "input",
      source: "upload",
      author: "林默",
      note: "上传",
      status: "synced",
      desc: "本机上传",
    });
    material = await warmAsr(ctx, material);
    broadcastMaterial(material, ctx.id);
    warmWorkbook(ctx, material);
    warmPdf(ctx, material);
    return json(res, 201, {
      name: base,
      path: rel,
      size: body.length,
      material: withAsr(ctx, material),
    });
  }

  if (pathname === "/api/file" && req.method === "GET") {
    const requested = url.searchParams.get("path") || "";
    const absolute = path.resolve(ctx.root, requested);
    if (!absolute.startsWith(ctx.root + path.sep)) return json(res, 403, { error: "forbidden" });
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile()) return json(res, 404, { error: "not a file" });
      const ext = path.extname(absolute).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      const download = url.searchParams.get("download") === "1";
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
        ...(download
          ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}` }
          : {}),
      });
      fs.createReadStream(absolute).pipe(res);
    } catch {
      json(res, 404, { error: "not found" });
    }
    return;
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || "internal error" });
    else res.end();
  }
});

// Large workbooks/audio on a slow link can legitimately take many minutes.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`Workbench listening on http://${HOST}:${PORT}`);
  console.log(`model: ${MODEL_ID} · projects: ${Array.from(contexts.keys()).join(", ")}`);
  console.log(
    `asr: ${ASR_ENABLED ? (ASR_API_KEY ? "enabled" : "enabled (ASR_API_KEY missing)") : "disabled"} · ${ASR_API_BASE}`,
  );
  startTrackingScheduler();
});

function shutdown() {
  for (const ctx of contexts.values()) {
    try {
      ctx.previews.close();
      ctx.workbooks.close?.();
      ctx.asr?.close();
    } catch {
      /* ignore */
    }
  }
  for (const entry of live.values()) {
    try {
      entry.unsubscribe?.();
      entry.session.dispose();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
