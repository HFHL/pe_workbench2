/**
 * Pi session events -> browser SSE + durable tool presentations.
 *
 * The bridge is the only place that turns a tool result into a UI payload. It
 * persists the validated payload before broadcasting it, so a refresh sees the
 * same card even when Pi's JSONL never stored `details`.
 */

import path from "node:path";

import { newRunId } from "../../lib/agent-protocol/ids.mjs";
import { extractPresentation } from "../../lib/contracts/index.mjs";
import { resultText, toolDetail } from "./snapshot.mjs";

export function attachSessionEvents(entry, { bus, onMaterialSaved = () => {}, onRunSettled = () => {} }) {
  entry.unsubscribe = entry.session.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        entry.localRunId = newRunId();
        entry.traceChangedFiles = [];
        entry.traceRunStartedAt = new Date().toISOString();
        bus.broadcast(entry, { type: "run.started" });
        break;
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") {
          bus.broadcast(entry, { type: "assistant.delta", delta: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start": {
        entry.toolArgs.set(event.toolCallId, event.args || {});
        bus.broadcast(entry, {
          type: "tool.started",
          id: event.toolCallId,
          name: event.toolName,
          detail: toolDetail(entry.ctx, event.toolName, event.args || {}),
        });
        break;
      }
      case "tool_execution_update":
        bus.broadcast(entry, {
          type: "tool.updated",
          id: event.toolCallId,
          output: resultText(event.partialResult).slice(0, 800),
        });
        break;
      case "tool_execution_end": {
        const args = entry.toolArgs.get(event.toolCallId) || {};
        entry.toolArgs.delete(event.toolCallId);
        const extracted = extractPresentation(event.result);
        let presentation = null;
        let presentationError = "";
        if (extracted.ok) {
          try {
            entry.ctx.store.saveToolPresentation({
              toolCallId: event.toolCallId,
              threadId: entry.id,
              runId: entry.agui?.activeRunId || entry.localRunId || "",
              toolName: event.toolName,
              schemaName: extracted.schemaName,
              schemaVersion: extracted.schemaVersion,
              payload: extracted.payload,
            });
            presentation = {
              schema: { name: extracted.schemaName, version: extracted.schemaVersion },
              payload: extracted.payload,
            };
          } catch (error) {
            presentationError = `工具结果持久化失败：${error.message}`;
          }
        } else if (
          event.result?.details?.presentation
          || event.result?.details?.structuredContent
          || event.result?.structuredContent
        ) {
          presentationError = extracted.error || "工具结果展示数据不可用";
          // Persist the failure too: after a refresh the card must still show
          // an error placeholder rather than silently degrading to a plain row.
          try {
            entry.ctx.store.saveToolPresentation({
              toolCallId: event.toolCallId,
              threadId: entry.id,
              runId: entry.agui?.activeRunId || entry.localRunId || "",
              toolName: event.toolName,
              schemaName: "presentation.error",
              schemaVersion: 0,
              payload: { error: presentationError },
            });
          } catch {
            /* live error placeholder still works */
          }
        }
        bus.broadcast(entry, {
          type: "tool.completed",
          id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? "error" : "done",
          detail: toolDetail(entry.ctx, event.toolName, args),
          output: resultText(event.result).slice(0, 4000),
          ...(presentation ? { presentation } : {}),
          ...(presentationError ? { presentationError } : {}),
        });
        onMaterialSaved(entry, event.toolName, args);
        if (["write", "edit"].includes(event.toolName) && typeof args.path === "string") {
          const root = path.resolve(entry.ctx.root);
          const absolute = path.resolve(root, args.path);
          if (absolute.startsWith(root + path.sep)) {
            const rel = path.relative(root, absolute).split(path.sep).join("/");
            if (
              rel
              && !rel.startsWith(".tracking/")
              && !rel.includes("/backups/")
              && Array.isArray(entry.traceChangedFiles)
              && !entry.traceChangedFiles.includes(rel)
            ) {
              entry.traceChangedFiles.push(rel);
            }
          }
        }
        break;
      }
      case "agent_settled": {
        entry.updatedAt = new Date().toISOString();
        const title = entry.session.sessionName || entry.title;
        entry.title = title;
        const changedFiles = Array.isArray(entry.traceChangedFiles) ? [...entry.traceChangedFiles] : [];
        entry.traceChangedFiles = [];
        bus.broadcast(entry, { type: "run.settled", aborted: event.aborted });
        bus.broadcast(entry, {
          type: "session.updated",
          id: entry.id,
          title,
          messageCount: entry.session.messages.length,
          updatedAt: entry.updatedAt,
        });
        void Promise.resolve(onRunSettled(entry, {
          changedFiles,
          aborted: event.aborted,
          startedAt: entry.traceRunStartedAt || null,
          runId: entry.agui?.activeRunId || entry.localRunId || null,
        })).catch(() => {});
        break;
      }
    }
  });
  return () => {
    try {
      entry.unsubscribe?.();
    } catch {
      /* ignored */
    }
  };
}
