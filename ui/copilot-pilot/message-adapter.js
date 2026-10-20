/**
 * CopilotKit/AG-UI -> workbench view model.
 *
 * This module only translates protocol values into the shapes the existing
 * renderer already understands. It owns no run state and never writes to the
 * legacy SSE transport.
 */

export function toolDetail(name, args = {}) {
  const value = args && typeof args === "object" ? args : {};
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return String(value.path || ".");
    case "grep":
    case "find":
      return String(value.pattern || "");
    case "bash":
      return String(value.command || "");
    case "workbook_query":
      return `${String(value.path || "")} · ${String(value.query || "")}`.trim();
    case "asr_read":
      return String(value.path || "");
    case "westock_query":
      return Array.isArray(value.args) ? value.args.join(" ").slice(0, 120) : "";
    case "anysearch_search":
      return String(value.query || "").slice(0, 120);
    case "web_fetch":
      return String(value.url || "").slice(0, 200);
    default:
      try {
        return JSON.stringify(value).slice(0, 80);
      } catch {
        return "";
      }
  }
}

export function resultText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n\n");
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toolStatusFromResult(content, isError = false) {
  if (isError) return "error";
  const text = String(content || "").trim();
  if (/^(?:error|failed|失败)|isError/i.test(text)) return "error";
  return "done";
}

export function nowHM(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `pilot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/** Build the single user message sent to the runtime for one turn. */
export function userMessage(text) {
  return {
    id: newId(),
    role: "user",
    content: String(text || ""),
  };
}

export function parseArgs(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function metricsSnapshot(metrics) {
  const copy = { ...metrics };
  if (copy.firstTextAt && copy.sendStartedAt) copy.firstTextMs = Math.round(copy.firstTextAt - copy.sendStartedAt);
  if (copy.completedAt && copy.sendStartedAt) copy.completedMs = Math.round(copy.completedAt - copy.sendStartedAt);
  delete copy.sendStartedAt;
  delete copy.firstTextAt;
  delete copy.completedAt;
  return copy;
}
