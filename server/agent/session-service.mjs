/**
 * Session lifecycle and persistence.
 *
 * One entry = one Pi session (or a deterministic fake session in tests). The
 * service owns streaming entries, session listing and the AG-UI adapter; route
 * handlers only parse HTTP input and call these methods.
 */

import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { PiAgUiAdapter } from "../../lib/agent-protocol/pi-ag-ui-adapter.mjs";
import { createFakeSession } from "./fake-agent.mjs";
import { attachSessionEvents } from "./event-bridge.mjs";
import {
  makeTitle,
  serializeSession,
  titleFromMessages,
} from "./snapshot.mjs";
import { systemHint } from "../project-context.mjs";

export function createSessionService({
  config,
  bus,
  projectManager,
  live,
  onMaterialSaved = () => {},
  onRunSettled = () => {},
}) {
  if (!config || !bus || !projectManager || !live) {
    throw new Error("createSessionService requires config, bus, projectManager and live");
  }

  function isProjectSkill(skill, ctx) {
    const file = path.resolve(skill.filePath);
    const roots = [
      path.join(ctx.root, ".agents", "skills"),
      path.join(ctx.root, ".pi", "skills"),
      path.join(config.agentDir, "skills"),
      config.skillsDir,
    ];
    return roots.some((root) => file === root || file.startsWith(root + path.sep));
  }

  function makeLoader(ctx) {
    return new DefaultResourceLoader({
      cwd: ctx.root,
      agentDir: config.agentDir,
      additionalSkillPaths: [config.skillsDir],
      appendSystemPromptOverride: (base) => [...base, systemHint(ctx, config)],
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => isProjectSkill(skill, ctx)),
        diagnostics: base.diagnostics,
      }),
    });
  }

  function blockOutsideProject(ctx, toolName, args) {
    if (!args || typeof args !== "object") return null;
    if (
      toolName === "bash"
      && typeof args.command === "string"
      && /(?:^|[/\s])model[/\\][^\s]+\.(?:xlsx|xlsm)|工作模型\.xlsx/i.test(args.command)
    ) {
      return { block: true, reason: "工作模型只能通过人工审批写入" };
    }
    const candidate = args.path;
    if (typeof candidate !== "string" || !candidate) return null;
    const root = path.resolve(ctx.root);
    const absolute = path.resolve(root, candidate);
    const inside = absolute === root || absolute.startsWith(root + path.sep);
    if (inside) {
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      // The prepared working model must only change through the approval path.
      // Blocking direct write/edit keeps a prompt-injected agent from bypassing
      // backup, recalculation and human review.
      if (
        ["write", "edit"].includes(toolName)
        && /(?:^|\/)model\/[^/]+\.(?:xlsx|xlsm)$/i.test(rel)
      ) {
        return { block: true, reason: "工作模型只能通过人工审批写入" };
      }
      return null;
    }
    if (["read", "grep", "find", "ls"].includes(toolName) && absolute.startsWith(config.skillsDir + path.sep)) {
      return null;
    }
    return { block: true, reason: `${toolName} 只能访问当前项目内的路径` };
  }

  /**
   * Optional per-session write scope: when `writeRoots` is provided, write/edit
   * may only target those project-relative prefixes. The watcher uses this to
   * stay read-only: it can write its result JSON under `.watch/` but never the
   * report, state file or model.
   */
  function blockOutsideWriteRoots(ctx, toolName, args, writeRoots) {
    if (!Array.isArray(writeRoots) || !writeRoots.length) return null;
    if (!["write", "edit"].includes(toolName)) return null;
    const candidate = args?.path;
    if (typeof candidate !== "string" || !candidate) {
      return { block: true, reason: "「盯」是只读的：写操作必须给出项目内路径" };
    }
    const root = path.resolve(ctx.root);
    const absolute = path.resolve(root, candidate);
    const rel = path.relative(root, absolute).split(path.sep).join("/");
    const allowed = writeRoots.some((scope) => {
      const prefix = String(scope || "").replace(/^\/+/, "").replace(/\/+$/, "");
      return prefix && (rel === prefix || rel.startsWith(`${prefix}/`));
    });
    if (allowed) return null;
    return { block: true, reason: `「盯」是只读的：只能写 ${writeRoots.join("、")} 下的结果文件` };
  }

  async function createEntry({ id, file, ctx, writeRoots = null }) {
    if (!ctx) throw Object.assign(new Error("project not found"), { status: 404 });

    let session;
    if (config.fakeAgent) {
      session = await createFakeSession({ id: id || undefined, ctx, config });
    } else {
      const sessionManager = file
        ? SessionManager.open(file, ctx.sessionsDir)
        : SessionManager.create(ctx.root, ctx.sessionsDir, id ? { id } : undefined);
      const loader = makeLoader(ctx);
      await loader.reload();
      const created = await createAgentSession({
        cwd: ctx.root,
        agentDir: config.agentDir,
        model: config.model,
        thinkingLevel: "off",
        sessionManager,
        resourceLoader: loader,
        tools: config.toolNames,
        customTools: ctx.tools,
      });
      session = created.session;
    }

    session.agent.beforeToolCall = async ({ toolCall, args }) => {
      const outside = blockOutsideProject(ctx, toolCall.name, args);
      if (outside) return outside;
      return blockOutsideWriteRoots(ctx, toolCall.name, args, writeRoots) ?? undefined;
    };

    const entry = {
      id: session.sessionId,
      session,
      ctx,
      clients: new Set(),
      toolArgs: new Map(),
      title: session.sessionName || titleFromMessages(session),
      modelId: config.modelId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      unsubscribe: null,
      localRunId: null,
    };
    entry.snapshot = () => serializeSession(entry);
    attachSessionEvents(entry, { bus, onMaterialSaved, onRunSettled });
    entry.agui = new PiAgUiAdapter({
      session,
      threadId: entry.id,
      workspaceId: ctx.id,
      log: ctx.agentEvents,
    });
    entry.agui.attach();
    live.set(entry.id, entry);
    return entry;
  }

  async function ensureEntry(id, ctx = null) {
    const existing = live.get(id);
    if (existing) {
      if (ctx && existing.ctx.id !== ctx.id) return null;
      return existing;
    }
    if (config.fakeAgent) return null;
    const candidates = ctx ? [ctx] : projectManager.list();
    for (const candidate of candidates) {
      const file = SessionManager.findById(candidate.root, id, candidate.sessionsDir);
      if (file) return createEntry({ id, file, ctx: candidate });
    }
    return null;
  }

  async function listSessions(ctx) {
    const infos = config.fakeAgent ? [] : await SessionManager.list(ctx.root, ctx.sessionsDir);
    const items = infos
      .filter((info) => !/^\[(计划|跟踪|盯)\]/.test(String(info.name || "")))
      .map((info) => ({
        id: info.id,
        title: info.name || makeTitle(info.firstMessage) || "未命名会话",
        messageCount: info.messageCount,
        updatedAt: info.modified.toISOString(),
      }));

    for (const entry of live.values()) {
      if (entry.ctx.id !== ctx.id) continue;
      if (/^\[(计划|跟踪|盯)\]/.test(String(entry.session.sessionName || entry.title || ""))) continue;
      const item = {
        id: entry.id,
        title: entry.session.sessionName || entry.title || "新会话",
        messageCount: entry.session.messages.length,
        updatedAt: entry.updatedAt,
      };
      const index = items.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) items[index] = item;
      else items.unshift(item);
    }
    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function close() {
    for (const entry of live.values()) {
      try {
        entry.unsubscribe?.();
        entry.agui?.detach();
        entry.session.dispose?.();
      } catch {
        /* ignored */
      }
    }
    live.clear();
  }

  return { createEntry, ensureEntry, listSessions, close };
}
