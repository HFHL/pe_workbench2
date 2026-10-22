/**
 * Conversation snapshot: Pi session messages -> the compact DTO the browser
 * renders. Tool presentations are joined from the host's durable table, never
 * parsed out of Markdown or model text.
 */

import path from "node:path";

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

export function shortPath(ctx, value) {
  if (typeof value !== "string") return "";
  const rel = path.relative(ctx.root, path.resolve(ctx.root, value));
  if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
  return value;
}

export function toolDetail(ctx, name, args = {}) {
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
    case "anysearch_search":
      return String(args.query || "").slice(0, 120);
    case "web_fetch":
      return String(args.url || "").slice(0, 200);
    default:
      return JSON.stringify(args || {}).slice(0, 80);
  }
}

export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return textOfContent(result.content);
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return "";
  }
}

export function hm(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function makeTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "新会话";
  const first = clean.split(/[，。！？；,.!?;\n]/)[0].trim() || clean;
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

export function titleFromMessages(session) {
  const firstUser = session.messages.find((message) => message.role === "user");
  return makeTitle(firstUser ? textOfContent(firstUser.content) : "");
}

export function lastAssistantText(session) {
  const messages = session?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function snapshotMessages(session, ctx, entry = null) {
  const results = new Map();
  for (const message of session.messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const presentations = new Map();
  if (entry) {
    for (const record of ctx.store.listToolPresentations({ threadId: entry.id })) {
      presentations.set(record.toolCallId, record);
    }
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
      const record = presentations.get(block.id);
      const presentation = record && !record.corrupt && record.payload
        && record.schemaName !== "presentation.error"
        ? {
            schema: { name: record.schemaName, version: record.schemaVersion },
            payload: record.payload,
          }
        : null;
      const presentationError = record?.corrupt
        ? "工具结果展示数据损坏"
        : record?.schemaName === "presentation.error"
          ? String(record.payload?.error || "工具结果展示数据不可用")
          : "";
      current.segments.push({ type: "tool" });
      current.tools.push({
        id: block.id,
        name: block.name,
        detail: toolDetail(ctx, block.name, block.arguments || {}),
        status: result ? (result.isError ? "error" : "done") : "done",
        output: result ? resultText(result).slice(0, 4000) : "",
        ...(presentation ? { presentation } : {}),
        ...(presentationError ? { presentationError } : {}),
      });
    }
  }
  flush();
  return out;
}

export function serializeSession(entry) {
  return {
    type: "snapshot",
    sessionId: entry.id,
    title: entry.title,
    messages: snapshotMessages(entry.session, entry.ctx, entry),
    streaming: entry.session.isStreaming,
    model: entry.modelId,
    projectId: entry.ctx.id,
    approvals: entry.ctx.store.listApprovalRequests({ threadId: entry.id, limit: 50 }),
  };
}
