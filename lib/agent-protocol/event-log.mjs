/**
 * Durable AG-UI transport log.
 *
 * Rows in `agent_events` are the replay buffer for SSE reconnects, not session
 * history: Pi's JSONL file remains the conversation truth, and this log never
 * stores material/tracking/plan/notification domain events.
 *
 * Two implementations share the same interface so the adapter and the endpoint
 * can be tested with no database:
 *   - AgentEventLog       — SQLite (node:sqlite via Store), survives restarts
 *   - MemoryAgentEventLog — in-process, for protocol tests
 */

import { eventIdFor } from "./ids.mjs";

function toRecord(row) {
  return {
    eventId: row.eventId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    runId: row.runId,
    sequence: row.sequence,
    ordinal: row.ordinal,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

export class AgentEventLog {
  constructor({ store, workspaceId }) {
    if (!store) throw new Error("AgentEventLog requires a store");
    if (!workspaceId) throw new Error("AgentEventLog requires a workspaceId");
    this.store = store;
    this.workspaceId = workspaceId;
  }

  /**
   * Append one event and return the stored record. The event id is derived from
   * (runId, sequence) once and then persisted, so replay returns the same ids.
   */
  append({ threadId, runId, eventType, event }) {
    if (!threadId || !runId || !eventType) {
      throw new Error("append requires threadId, runId and eventType");
    }
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Another process may allocate the same sequence between these two calls;
      // unique(run_id, sequence) rejects it and we recompute.
      const sequence = this.store.nextAgentSequence(runId, { workspaceId: this.workspaceId });
      try {
        const record = this.store.appendAgentEvent({
          eventId: eventIdFor(runId, sequence),
          workspaceId: this.workspaceId,
          threadId,
          runId,
          sequence,
          eventType,
          payload: event,
        });
        if (record) return toRecord(record);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`could not append AG-UI event for run ${runId}`);
  }

  /** `runId` replays by run-local sequence; otherwise by thread-wide ordinal. */
  list({ threadId, runId = null, afterSequence = 0, afterOrdinal = 0, limit = 2000 } = {}) {
    return this.store.listAgentEvents({
      workspaceId: this.workspaceId,
      threadId,
      runId,
      afterSequence,
      afterOrdinal,
      limit,
    });
  }

  locate(eventId) {
    return this.store.getAgentEvent(eventId, { workspaceId: this.workspaceId });
  }

  /** Remove an incomplete run after any append failure. */
  discardRun({ threadId, runId }) {
    return this.store.deleteAgentEvents({ workspaceId: this.workspaceId, threadId, runId });
  }
}

export class MemoryAgentEventLog {
  constructor({ workspaceId }) {
    if (!workspaceId) throw new Error("MemoryAgentEventLog requires a workspaceId");
    this.workspaceId = workspaceId;
    this.records = [];
    this.byId = new Map();
  }

  append({ threadId, runId, eventType, event }) {
    const sequence = this.nextSequence(runId);
    const record = {
      eventId: eventIdFor(runId, sequence),
      workspaceId: this.workspaceId,
      threadId,
      runId,
      sequence,
      ordinal: this.records.length + 1,
      eventType,
      payload: event,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    this.byId.set(record.eventId, record);
    return record;
  }

  nextSequence(runId) {
    let max = 0;
    for (const record of this.records) {
      if (record.runId === runId && record.sequence > max) max = record.sequence;
    }
    return max + 1;
  }

  list({ threadId, runId = null, afterSequence = 0, afterOrdinal = 0, limit = 2000 } = {}) {
    return this.records
      .filter((record) => {
        if (record.workspaceId !== this.workspaceId) return false;
        if (runId) return record.runId === runId && record.sequence > afterSequence;
        return record.threadId === threadId && record.ordinal > afterOrdinal;
      })
      .slice(0, limit);
  }

  locate(eventId) {
    const record = this.byId.get(eventId);
    return record && record.workspaceId === this.workspaceId ? record : null;
  }

  discardRun({ threadId, runId }) {
    let removed = 0;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      const matches = record.workspaceId === this.workspaceId
        && record.threadId === threadId
        && record.runId === runId;
      if (matches) {
        this.byId.delete(record.eventId);
        this.records.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }
}
