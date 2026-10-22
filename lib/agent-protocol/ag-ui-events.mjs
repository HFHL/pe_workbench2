/**
 * AG-UI wire types used by the Pi adapter.
 *
 * The shapes below follow the AG-UI event schema (type + optional timestamp on
 * every event, lifecycle/tool/text payloads per event type). They are declared
 * locally instead of depending on @ag-ui/core so the workbench gains no new
 * runtime dependency and no unpinned transitive zod version; `test:protocol`
 * asserts the emitted shapes.
 */

export const EventType = Object.freeze({
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  CUSTOM: "CUSTOM",
  RAW: "RAW",
});

export const TERMINAL_EVENT_TYPES = new Set([EventType.RUN_FINISHED, EventType.RUN_ERROR]);

/**
 * Build one protocol event. `type` and `threadId`/`runId` are supplied by the
 * caller; `timestamp` is captured once here so a replayed event is byte-identical
 * to the one that was streamed live.
 */
export function createEvent(type, fields = {}, timestamp = Date.now()) {
  return { type, timestamp, ...fields };
}

/** Text blocks of an AG-UI/Pi message content array. */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * Tool results arrive as `{ content: [...] }` from Pi; they also show up as plain
 * strings in tests and in older session files.
 */
export function toolResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return contentText(result.content);
  if (typeof result.text === "string") return result.text;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}
