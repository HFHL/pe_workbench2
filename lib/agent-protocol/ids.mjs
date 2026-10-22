/**
 * Identifier rules for the AG-UI bridge.
 *
 * - threadId      = Pi sessionId (stable for the life of the session)
 * - runId         = generated before every prompt
 * - messageId     = Pi message id when it exists, otherwise generated
 * - toolCallId    = Pi toolCallId
 * - eventId       = derived from (runId, sequence), so replay cannot change it
 * - sequence      = per-run counter starting at 1 (allocated by the event log)
 */

import crypto from "node:crypto";

export const ID_PREFIX = Object.freeze({
  run: "run",
  message: "msg",
  toolResultMessage: "msg_tool",
  event: "evt",
});

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function newRunId() {
  return randomId(ID_PREFIX.run);
}

export function newMessageId() {
  return randomId(ID_PREFIX.message);
}

/** Tool result messages need a stable id of their own in AG-UI. */
export function toolResultMessageId(toolCallId) {
  return `${ID_PREFIX.toolResultMessage}_${toolCallId}`;
}

/**
 * Deterministic event id: uniqueness follows from unique(run_id, sequence), and
 * a replayed row keeps the id it was written with.
 */
export function eventIdFor(runId, sequence) {
  const padded = String(sequence).padStart(6, "0");
  return `${ID_PREFIX.event}_${runId}_${padded}`;
}

/** Pi sometimes carries its own message id; prefer it when it is a real string. */
export function messageIdFromPi(message, fallback) {
  const id = message?.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  return fallback;
}
