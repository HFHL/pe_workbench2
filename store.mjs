import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  computeNextRun as computeTrackingNextRun,
  formatNextLabel,
  scheduleLabel as trackingScheduleLabel,
  scheduleShort as trackingScheduleShort,
} from "./lib/tracking.mjs";

export const DEFAULT_PROJECT_ID = "product-eng";
const WORKSPACE_ID = DEFAULT_PROJECT_ID;
const PROJECT_ACCENTS = ["amber", "blue", "green", "violet", "rose", "slate"];

const TEXT_EXTS = new Set([
  "md", "txt", "csv", "json", "html", "xml", "yml", "yaml", "js", "ts", "css", "log", "sh",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

function extOf(name) {
  return (name.split(".").pop() || "").toLowerCase();
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatWhen(iso) {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

function dayTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return { day: "今天", time: hm };
  if (date.toDateString() === yesterday.toDateString()) return { day: "昨天", time: hm };
  return { day: "更早", time: `${date.getMonth() + 1}/${date.getDate()}` };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export class Store {
  constructor(db, { workspace, dataDir, projectId = WORKSPACE_ID, projectName = "Product Eng", projectNote = "" }) {
    this.db = db;
    this.workspace = workspace;
    this.dataDir = dataDir;
    this.blobsDir = path.join(dataDir, "blobs");
    this.projectId = projectId;
    this.projectName = projectName;
    this.projectNote = projectNote;
    // Where this project's root sits relative to the repository root, for display.
    this.projectLabel = path.relative(path.dirname(dataDir), workspace).split(path.sep).join("/");
    if (!this.projectLabel || this.projectLabel.startsWith("..")) {
      this.projectLabel = path.basename(workspace);
    }
  }

  /* ---------- schema ---------- */

  withImmediateTransaction(callback) {
    if (typeof callback !== "function") throw new Error("transaction callback is required");
    this.db.exec("begin immediate");
    try {
      const value = callback();
      this.db.exec("commit");
      return value;
    } catch (error) {
      try {
        this.db.exec("rollback");
      } catch {
        /* preserve the original transaction error */
      }
      throw error;
    }
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  /**
   * Early P0 builds gave monitor_items a global primary key on `id`, which
   * collides when two frameworks both use MON1. Monitor IDs are only unique
   * inside a tracking, so rebuild the table with (tracking_id, id).
   */
  migrateMonitorItemsKey() {
    const row = this.db.prepare(
      `select sql from sqlite_master where type = 'table' and name = 'monitor_items'`,
    ).get();
    if (!row?.sql || !/id\s+text\s+primary\s+key/i.test(row.sql)) return;
    try {
      this.db.exec(`
      begin;
      drop table if exists monitor_items_v2;
      create table monitor_items_v2 (
        id text not null,
        workspace_id text not null,
        tracking_id text not null references trackings(id) on delete cascade,
        falsifier_id text not null default '',
        thesis_id text not null default '',
        metric text not null default '',
        operator text not null default '',
        warning text not null default '',
        threshold text not null default '',
        unit text not null default '',
        frequency text not null default 'monthly',
        source_json text not null default '{}',
        action text not null default '',
        rationale text not null default '',
        status text not null default 'armed',
        last_observed text not null default '',
        last_checked_at text,
        next_check_at text,
        autonomy text not null default 'auto_notify',
        created_at text not null,
        updated_at text not null,
        primary key (tracking_id, id)
      );
      insert or replace into monitor_items_v2 (
        id, workspace_id, tracking_id, falsifier_id, thesis_id, metric, operator,
        warning, threshold, unit, frequency, source_json, action, rationale, status,
        last_observed, last_checked_at, next_check_at, autonomy, created_at, updated_at
      ) select
        id, workspace_id, tracking_id, falsifier_id, thesis_id, metric, operator,
        warning, threshold, unit, frequency, source_json, action, rationale, status,
        last_observed, last_checked_at, next_check_at, autonomy, created_at, updated_at
      from monitor_items;
      drop table monitor_items;
      alter table monitor_items_v2 rename to monitor_items;
      create index if not exists idx_monitor_items_tracking on monitor_items(tracking_id);
      create index if not exists idx_monitor_items_due on monitor_items(status, next_check_at);
      commit;
    `);
    } catch (error) {
      try {
        this.db.exec("rollback");
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      create table if not exists meta (
        key text primary key,
        value text not null
      );

      create table if not exists workspaces (
        id text primary key,
        name text not null,
        root_path text not null,
        created_at text not null,
        note text not null default '',
        accent text not null default 'slate',
        updated_at text,
        last_opened_at text
      );

      create table if not exists materials (
        id text primary key,
        workspace_id text not null,
        name text not null,
        path text not null,
        kind text not null,
        source text not null,
        status text not null,
        description text not null default '',
        origin text,
        session_id text,
        created_at text not null,
        updated_at text not null,
        deleted_at text,
        unique (workspace_id, path)
      );

      create table if not exists material_versions (
        material_id text not null references materials(id) on delete cascade,
        v integer not null,
        blob_sha256 text not null,
        size integer not null,
        note text not null default '',
        author text not null,
        created_at text not null,
        preview_json text,
        primary key (material_id, v)
      );

      create table if not exists material_links (
        material_id text not null references materials(id) on delete cascade,
        input_id text not null references materials(id) on delete cascade,
        primary key (material_id, input_id)
      );

      create table if not exists plans (
        id text primary key,
        workspace_id text not null,
        name text not null,
        description text not null default '',
        prompt text not null default '',
        schedule_label text not null,
        freq text not null,
        at_time text not null,
        weekday integer,
        timezone text not null default 'Asia/Shanghai',
        enabled integer not null default 1,
        target_id text,
        next_run_at text,
        last_run_at text,
        created_at text not null
      );

      create table if not exists plan_inputs (
        plan_id text not null references plans(id) on delete cascade,
        material_id text not null references materials(id) on delete cascade,
        primary key (plan_id, material_id)
      );

      create table if not exists plan_runs (
        id text primary key,
        plan_id text not null references plans(id) on delete cascade,
        started_at text not null,
        ended_at text,
        status text not null,
        version integer,
        message text
      );

      create table if not exists trackings (
        id text primary key,
        workspace_id text not null,
        name text not null,
        target_id text not null references materials(id) on delete cascade,
        template_id text not null,
        schedule_label text not null,
        freq text not null,
        at_time text not null,
        weekday integer,
        day integer,
        timezone text not null default 'Asia/Shanghai',
        enabled integer not null default 1,
        next_run_at text,
        last_run_at text,
        lease_until text,
        created_at text not null
      );

      create table if not exists tracking_runs (
        id text primary key,
        tracking_id text not null references trackings(id) on delete cascade,
        trigger text not null default 'schedule',
        started_at text not null,
        ended_at text,
        status text not null,
        base_version integer,
        result_version integer,
        result_json text,
        message text,
        session_id text,
        scheduled_for text
      );

      create table if not exists monitor_items (
        id text not null,
        workspace_id text not null,
        tracking_id text not null references trackings(id) on delete cascade,
        falsifier_id text not null default '',
        thesis_id text not null default '',
        metric text not null default '',
        operator text not null default '',
        warning text not null default '',
        threshold text not null default '',
        unit text not null default '',
        frequency text not null default 'monthly',
        source_json text not null default '{}',
        action text not null default '',
        rationale text not null default '',
        status text not null default 'armed',
        last_observed text not null default '',
        last_checked_at text,
        next_check_at text,
        autonomy text not null default 'auto_notify',
        created_at text not null,
        updated_at text not null,
        primary key (tracking_id, id)
      );

      create table if not exists source_bindings (
        id text primary key,
        workspace_id text not null,
        tracking_id text not null references trackings(id) on delete cascade,
        monitor_item_id text,
        adapter text not null,
        query text not null default '',
        source_tier integer not null default 3,
        interval_minutes integer not null default 360,
        next_poll_at text,
        last_polled_at text,
        enabled integer not null default 1,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists source_events (
        id text primary key,
        workspace_id text not null,
        tracking_id text,
        monitor_item_id text,
        adapter text not null,
        source_tier integer not null default 2,
        domain text not null default '',
        url text not null default '',
        title text not null default '',
        published_at text,
        fetched_at text not null,
        content_hash text not null default '',
        payload_json text,
        triage_status text not null default 'new',
        relevance text not null default '',
        used_in_run_id text,
        created_at text not null
      );

      create table if not exists notifications (
        id text primary key,
        workspace_id text not null,
        tracking_id text,
        run_id text,
        severity text not null default 'info',
        title text not null,
        body text not null default '',
        changes_json text,
        actions_json text,
        read_at text,
        created_at text not null
      );

      create table if not exists run_changes (
        id text primary key,
        workspace_id text not null,
        run_id text not null,
        object_type text not null,
        object_id text not null default '',
        before_json text,
        after_json text,
        evidence_ids text,
        applied integer not null default 0,
        created_at text not null
      );

      create table if not exists document_parses (
        blob_sha256 text primary key,
        file_name text not null,
        file_type text not null,
        parser_version integer not null,
        status text not null,
        stats_json text,
        error text,
        parsed_at text,
        updated_at text not null
      );

      -- Transport-level AG-UI event log per thread. It exists so an SSE client
      -- can replay missed events after a reconnect. It is not a second source
      -- of truth: conversation history stays in the Pi JSONL session file, and
      -- domain events (material/tracking/plan/notification) never land here.
      create table if not exists agent_events (
        event_id text primary key,
        workspace_id text not null,
        thread_id text not null,
        run_id text not null,
        sequence integer not null,
        ordinal integer not null,
        event_type text not null,
        payload_json text not null,
        created_at text not null,
        unique (run_id, sequence),
        unique (ordinal)
      );

      -- UI-only payload for a tool call. Pi's JSONL is conversation truth, but
      -- details are not guaranteed to survive there; the host persists them so a
      -- refreshed page can rebuild a rich card. Never injected into agent text.
      create table if not exists tool_presentations (
        tool_call_id text not null,
        workspace_id text not null,
        thread_id text not null,
        run_id text not null default '',
        tool_name text not null default '',
        schema_name text not null,
        schema_version integer not null,
        payload_json text not null,
        created_at text not null,
        primary key (workspace_id, tool_call_id)
      );

      -- A model write is blocked until a human approves the exact proposal.
      create table if not exists approval_requests (
        id text primary key,
        workspace_id text not null,
        thread_id text not null default '',
        run_id text not null default '',
        tracking_id text not null default '',
        kind text not null,
        payload_json text not null,
        status text not null,
        decision_json text,
        created_at text not null,
        decided_at text,
        applied_at text,
        updated_at text not null
      );

      create index if not exists idx_materials_updated on materials(workspace_id, updated_at desc);
      create index if not exists idx_versions_material on material_versions(material_id, v desc);
      create index if not exists idx_runs_plan on plan_runs(plan_id, started_at desc);
      create index if not exists idx_trackings_next on trackings(enabled, next_run_at);
      create index if not exists idx_tracking_runs on tracking_runs(tracking_id, started_at desc);
      create index if not exists idx_monitor_items_tracking on monitor_items(tracking_id);
      create index if not exists idx_monitor_items_due on monitor_items(status, next_check_at);
      create index if not exists idx_source_events_tracking on source_events(tracking_id, created_at desc);
      create index if not exists idx_source_bindings_due on source_bindings(enabled, next_poll_at);
      create index if not exists idx_source_bindings_tracking on source_bindings(tracking_id);
      create index if not exists idx_notifications_created on notifications(workspace_id, created_at desc);
      create index if not exists idx_agent_events_thread on agent_events(workspace_id, thread_id, ordinal);
      create index if not exists idx_tool_presentations_thread on tool_presentations(workspace_id, thread_id, created_at desc);
      create index if not exists idx_approvals_thread on approval_requests(workspace_id, thread_id, created_at desc);
      create index if not exists idx_approvals_status on approval_requests(workspace_id, status, created_at desc);
      create index if not exists idx_approvals_tracking on approval_requests(tracking_id);
    `);

    // Older databases predate the project metadata columns.
    this.ensureColumn("workspaces", "note", "text not null default ''");
    this.ensureColumn("workspaces", "accent", "text not null default 'slate'");
    this.ensureColumn("workspaces", "updated_at", "text");
    this.ensureColumn("workspaces", "last_opened_at", "text");

    // Monitoring / quiet revisions are additive migrations so existing
    // databases keep working without a manual reset.
    this.ensureColumn("trackings", "mode", "text not null default 'monitor'");
    this.ensureColumn("trackings", "autonomy_default", "text not null default 'auto_notify'");
    this.ensureColumn("trackings", "notification_policy", "text not null default 'in_app'");
    this.ensureColumn("trackings", "contract_version", "integer not null default 0");
    this.ensureColumn("material_versions", "visibility", "text not null default 'checkpoint'");
    this.ensureColumn("material_versions", "run_id", "text");
    this.ensureColumn("material_versions", "reason", "text");
    this.ensureColumn("tracking_runs", "decision_class", "text");
    this.ensureColumn("tracking_runs", "confidence", "text");
    this.ensureColumn("tracking_runs", "checkpoint_id", "text");
    this.ensureColumn("tracking_runs", "notification_id", "text");
    this.ensureColumn("tracking_runs", "verification_json", "text");
    this.migrateMonitorItemsKey();

    const now = nowIso();
    this.db.prepare(
      `insert or ignore into workspaces (id, name, root_path, created_at, note, accent, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.projectId, this.projectName, this.workspace, now, this.projectNote || "个人项目", "slate", now);

    // Keep the physical project root in sync with the layout the server uses.
    this.db.prepare(
      `update workspaces set root_path = ? where id = ? and root_path != ?`,
    ).run(this.workspace, this.projectId, this.workspace);
    this.db.prepare(
      `update workspaces set note = '个人项目' where note is null or note = ''`,
    ).run();

    // normalize upload display names written before this rule existed
    this.db.prepare(
      `update materials set name = substr(name, 15)
       where path like 'uploads/%' and length(name) > 14 and substr(name, 14, 1) = '-'`,
    ).run();
    this.db.prepare(
      `update materials set kind = 'input', status = 'synced'
       where path = 'pricing-matrix.csv' and kind = 'output'`,
    ).run();
  }

  recoverPlanRuns() {
    return this.db.prepare(
      `update plan_runs set status = 'failed', ended_at = ?, message = '进程重启中断'
       where status = 'running'`,
    ).run(nowIso()).changes;
  }

  /* ---------- agent protocol event log (transport only) ---------- */

  /**
   * Append one AG-UI transport event. `sequence` starts at 1 per run and is
   * allocated by the caller (see lib/agent-protocol/event-log.mjs) so the
   * event id can embed it; `ordinal` is a monotonic counter used to replay a
   * whole thread in order. Counters live in SQLite, so a restart resumes where
   * it stopped. Every project shares data/workbench.db, so workspace_id is part
   * of every read and uniqueness only needs to hold inside a run/thread.
   */
  appendAgentEvent({ eventId, workspaceId, threadId, runId, sequence, eventType, payload }) {
    const createdAt = nowIso();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ordinal = this.db.prepare(
        `select coalesce(max(ordinal), 0) + 1 as value from agent_events`,
      ).get().value;
      try {
        this.db.prepare(
          `insert into agent_events
             (event_id, workspace_id, thread_id, run_id, sequence, ordinal, event_type, payload_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          workspaceId,
          threadId,
          runId,
          sequence,
          ordinal,
          eventType,
          JSON.stringify(payload ?? {}),
          createdAt,
        );
        return {
          eventId,
          workspaceId,
          threadId,
          runId,
          sequence,
          ordinal,
          eventType,
          payload,
          createdAt,
        };
      } catch (error) {
        // A concurrent writer (another process on the same DB) can slip in
        // between the max() read and the insert; the unique constraints are the
        // authority, so recompute the ordinal and retry.
        if (attempt === 2 || !/UNIQUE constraint failed/i.test(String(error?.message))) throw error;
      }
    }
    return null;
  }

  nextAgentSequence(runId, { workspaceId } = {}) {
    return workspaceId
      ? this.db.prepare(
          `select coalesce(max(sequence), 0) + 1 as value from agent_events where run_id = ? and workspace_id = ?`,
        ).get(runId, workspaceId).value
      : this.db.prepare(
          `select coalesce(max(sequence), 0) + 1 as value from agent_events where run_id = ?`,
        ).get(runId).value;
  }

  deleteAgentEvents({ workspaceId, threadId, runId }) {
    if (!workspaceId || !threadId || !runId) return 0;
    return this.db.prepare(
      `delete from agent_events where workspace_id = ? and thread_id = ? and run_id = ?`,
    ).run(workspaceId, threadId, runId).changes;
  }

  hasAgentTerminal({ workspaceId, threadId, runId }) {
    if (!workspaceId || !threadId || !runId) return false;
    return Boolean(this.db.prepare(
      `select 1 from agent_events
       where workspace_id = ? and thread_id = ? and run_id = ?
         and event_type in ('RUN_FINISHED', 'RUN_ERROR')
       limit 1`,
    ).get(workspaceId, threadId, runId));
  }

  /**
   * Read transport events for replay. With `runId` the cursor is the run-local
   * `sequence`; without it the cursor is the thread-wide `ordinal`.
   */
  listAgentEvents({ workspaceId, threadId, runId = null, afterSequence = 0, afterOrdinal = 0, limit = 2000 } = {}) {
    const rows = runId
      ? this.db.prepare(
          `select * from agent_events
           where run_id = ? and workspace_id = ? and sequence > ?
           order by sequence asc limit ?`,
        ).all(runId, workspaceId, Number(afterSequence) || 0, limit)
      : this.db.prepare(
          `select * from agent_events
           where workspace_id = ? and thread_id = ? and ordinal > ?
           order by ordinal asc limit ?`,
        ).all(workspaceId, threadId, Number(afterOrdinal) || 0, limit);
    return rows.map((row) => this.agentEventRecord(row));
  }

  getAgentEvent(eventId, { workspaceId } = {}) {
    const row = workspaceId
      ? this.db.prepare(`select * from agent_events where event_id = ? and workspace_id = ?`).get(eventId, workspaceId)
      : this.db.prepare(`select * from agent_events where event_id = ?`).get(eventId);
    return row ? this.agentEventRecord(row) : null;
  }

  agentEventRecord(row) {
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }
    return {
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      runId: row.run_id,
      sequence: row.sequence,
      ordinal: row.ordinal,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  }

  /* ---------- tool presentations (UI-only payloads) ---------- */

  saveToolPresentation({
    toolCallId,
    threadId,
    runId = "",
    toolName = "",
    schemaName,
    schemaVersion,
    payload,
    createdAt = nowIso(),
  }) {
    if (!toolCallId || !threadId || !schemaName) {
      throw new Error("saveToolPresentation requires toolCallId, threadId and schemaName");
    }
    this.db.prepare(
      `insert into tool_presentations (
         tool_call_id, workspace_id, thread_id, run_id, tool_name,
         schema_name, schema_version, payload_json, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (workspace_id, tool_call_id) do update set
         thread_id = excluded.thread_id,
         run_id = excluded.run_id,
         tool_name = excluded.tool_name,
         schema_name = excluded.schema_name,
         schema_version = excluded.schema_version,
         payload_json = excluded.payload_json,
         created_at = excluded.created_at`,
    ).run(
      String(toolCallId),
      this.projectId,
      String(threadId),
      String(runId || ""),
      String(toolName || ""),
      String(schemaName),
      Number(schemaVersion) || 0,
      JSON.stringify(payload ?? null),
      createdAt,
    );
    return this.getToolPresentation(toolCallId);
  }

  toolPresentationRecord(row) {
    let payload = null;
    let corrupt = false;
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    } catch {
      corrupt = true;
    }
    return {
      toolCallId: row.tool_call_id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      runId: row.run_id,
      toolName: row.tool_name,
      schemaName: row.schema_name,
      schemaVersion: row.schema_version,
      payload,
      corrupt,
      createdAt: row.created_at,
    };
  }

  getToolPresentation(toolCallId) {
    const row = this.db.prepare(
      `select * from tool_presentations where workspace_id = ? and tool_call_id = ?`,
    ).get(this.projectId, String(toolCallId));
    return row ? this.toolPresentationRecord(row) : null;
  }

  listToolPresentations({ threadId = null, toolCallIds = null, limit = 500 } = {}) {
    if (Array.isArray(toolCallIds)) {
      if (!toolCallIds.length) return [];
      const placeholders = toolCallIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `select * from tool_presentations
         where workspace_id = ? and tool_call_id in (${placeholders})`,
      ).all(this.projectId, ...toolCallIds.map(String));
      return rows.map((row) => this.toolPresentationRecord(row));
    }
    const rows = threadId
      ? this.db.prepare(
          `select * from tool_presentations
           where workspace_id = ? and thread_id = ?
           order by created_at asc limit ?`,
        ).all(this.projectId, String(threadId), Math.max(1, Math.min(1000, Number(limit) || 500)))
      : this.db.prepare(
          `select * from tool_presentations
           where workspace_id = ? order by created_at asc limit ?`,
        ).all(this.projectId, Math.max(1, Math.min(1000, Number(limit) || 500)));
    return rows.map((row) => this.toolPresentationRecord(row));
  }

  /* ---------- approval requests ---------- */

  createApprovalRequest({
    id = null,
    threadId = "",
    runId = "",
    trackingId = "",
    kind,
    payload,
    status = "pending_approval",
    createdAt = nowIso(),
  }) {
    if (!kind) throw new Error("createApprovalRequest requires a kind");
    const approvalId = id || `apr_${uuid()}`;
    this.db.prepare(
      `insert into approval_requests (
         id, workspace_id, thread_id, run_id, tracking_id, kind, payload_json,
         status, decision_json, created_at, decided_at, applied_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, null, ?)`,
    ).run(
      approvalId,
      this.projectId,
      String(threadId || ""),
      String(runId || ""),
      String(trackingId || ""),
      String(kind),
      JSON.stringify(payload ?? null),
      String(status),
      createdAt,
      createdAt,
    );
    return this.getApprovalRequest(approvalId);
  }

  approvalRecord(row) {
    let payload = null;
    let decision = null;
    let corrupt = false;
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    } catch {
      corrupt = true;
    }
    try {
      decision = row.decision_json ? JSON.parse(row.decision_json) : null;
    } catch {
      decision = { parseError: true };
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      runId: row.run_id,
      trackingId: row.tracking_id,
      kind: row.kind,
      payload,
      status: row.status,
      decision,
      corrupt,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      appliedAt: row.applied_at,
      updatedAt: row.updated_at,
    };
  }

  getApprovalRequest(id) {
    const row = this.db.prepare(
      `select * from approval_requests where id = ? and workspace_id = ?`,
    ).get(String(id), this.projectId);
    return row ? this.approvalRecord(row) : null;
  }

  listApprovalRequests({ threadId = null, trackingId = null, status = null, limit = 100 } = {}) {
    const clauses = ["workspace_id = ?"];
    const values = [this.projectId];
    if (threadId) {
      clauses.push("thread_id = ?");
      values.push(String(threadId));
    }
    if (trackingId) {
      clauses.push("tracking_id = ?");
      values.push(String(trackingId));
    }
    if (status) {
      clauses.push("status = ?");
      values.push(String(status));
    }
    values.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const rows = this.db.prepare(
      `select * from approval_requests where ${clauses.join(" and ")}
       order by created_at desc limit ?`,
    ).all(...values);
    return rows.map((row) => this.approvalRecord(row));
  }

  /**
   * Atomic compare-and-set used by approve/reject. Returns the updated DTO, or
   * null when another request already moved the row out of `fromStatuses`.
   */
  transitionApproval(id, {
    fromStatuses,
    status,
    decision = null,
    decidedAt = null,
    appliedAt = null,
    payload = undefined,
  }) {
    const now = nowIso();
    const allowed = (Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses]).filter(Boolean);
    if (!allowed.length) throw new Error("transitionApproval requires fromStatuses");
    const existing = this.getApprovalRequest(id);
    const decided = decidedAt
      || (["applying", "applied"].includes(status) ? existing?.decidedAt || now : now);
    const placeholders = allowed.map(() => "?").join(",");
    const setPayload = payload !== undefined ? ", payload_json = ?" : "";
    const values = [
      String(status),
      decision === null ? null : JSON.stringify(decision),
      decided,
      appliedAt,
      now,
      ...(payload !== undefined ? [JSON.stringify(payload)] : []),
      String(id),
      this.projectId,
      ...allowed,
    ];
    const result = this.db.prepare(
      `update approval_requests set
         status = ?, decision_json = ?, decided_at = ?, applied_at = ?, updated_at = ?${setPayload}
       where id = ? and workspace_id = ? and status in (${placeholders})`,
    ).run(...values);
    return result.changes > 0 ? this.getApprovalRequest(id) : null;
  }

  /** After a crash, an `applying` row must never be retried automatically. */
  recoverApplyingApprovals() {
    return this.db.prepare(
      `update approval_requests set
         status = 'failed',
         decision_json = ?,
         decided_at = coalesce(decided_at, ?),
         updated_at = ?
       where workspace_id = ? and status = 'applying'`,
    ).run(
      JSON.stringify({ reason: "server restarted while applying; regenerate the proposal" }),
      nowIso(),
      nowIso(),
      this.projectId,
    ).changes;
  }

  updateTrackingRunResult(runId, {
    status,
    message = null,
    result = null,
    resultVersion = undefined,
  } = {}) {
    const row = this.getTrackingRun(runId);
    if (!row) return null;
    this.db.prepare(
      `update tracking_runs set
         status = coalesce(?, status),
         message = coalesce(?, message),
         result_json = coalesce(?, result_json),
         result_version = coalesce(?, result_version)
       where id = ?`,
    ).run(
      status || null,
      message,
      result ? JSON.stringify(result) : null,
      resultVersion === undefined ? null : resultVersion,
      String(runId),
    );
    return this.getTrackingRun(runId);
  }

  /* ---------- helpers ---------- */

  blobPath(sha) {
    return path.join(this.blobsDir, sha.slice(0, 2), sha);
  }

  ensureBlob(content, sha) {
    const target = this.blobPath(sha);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return target;
  }

  previewFor(rel, content) {
    const ext = extOf(rel);
    if (TEXT_EXTS.has(ext)) {
      return { type: "text", text: content.toString("utf8").slice(0, 20000) };
    }
    if (IMAGE_EXTS.has(ext)) {
      return { type: "image", path: rel };
    }
    return { type: "none" };
  }

  /* ---------- projects ---------- */

  projectDto(row) {
    const repoRoot = path.dirname(this.dataDir);
    const root = path.relative(repoRoot, row.root_path).split(path.sep).join("/");
    return {
      id: row.id,
      name: row.name,
      note: row.note || "",
      accent: row.accent || "slate",
      root: !root || root.startsWith("..") ? path.basename(row.root_path) : root,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  }

  listProjects() {
    return this.db.prepare(`select * from workspaces order by created_at asc`).all()
      .map((row) => this.projectDto(row));
  }

  listProjectRows() {
    return this.db.prepare(`select * from workspaces order by created_at asc`).all();
  }

  getProject(id) {
    const row = this.db.prepare(`select * from workspaces where id = ?`).get(id);
    return row ? this.projectDto(row) : null;
  }

  getProjectRow(id) {
    return this.db.prepare(`select * from workspaces where id = ?`).get(id) || null;
  }

  createProject({ id, name, note = "", rootPath, accent = null }) {
    const now = nowIso();
    const count = this.db.prepare(`select count(*) as n from workspaces`).get().n;
    const chosen = accent || PROJECT_ACCENTS[count % PROJECT_ACCENTS.length];
    this.db.prepare(
      `insert into workspaces (id, name, root_path, created_at, note, accent, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, rootPath, now, note, chosen, now);
    return this.getProject(id);
  }

  updateProject(id, { name, note, accent } = {}) {
    const row = this.db.prepare(`select * from workspaces where id = ?`).get(id);
    if (!row) return null;
    this.db.prepare(
      `update workspaces set name = ?, note = ?, accent = ?, updated_at = ? where id = ?`,
    ).run(
      name != null ? name : row.name,
      note != null ? note : row.note,
      accent != null ? accent : row.accent,
      nowIso(),
      id,
    );
    return this.getProject(id);
  }

  /* ---------- materials ---------- */

  indexFile(rel, options = {}) {
    const normalized = rel.split(path.sep).join("/");
    const absolute = path.join(this.workspace, normalized);
    if (!absolute.startsWith(this.workspace + path.sep)) throw new Error("path outside workspace");

    const stat = fs.statSync(absolute);
    const content = fs.readFileSync(absolute);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    this.ensureBlob(content, sha);

    const isInput = normalized.startsWith("uploads/") || normalized.startsWith("inputs/");
    const kind = options.kind || (isInput ? "input" : "output");
    const source = options.source || (normalized.startsWith("uploads/") ? "upload" : "agent");
    const status = options.status || (kind === "input" ? "synced" : "draft");
    const storedName = path.basename(normalized);
    const name = normalized.startsWith("uploads/") ? storedName.replace(/^\d{13}-/, "") : storedName;
    const now = nowIso();

    let row = this.db.prepare(`select * from materials where path = ? and workspace_id = ?`).get(normalized, this.projectId);
    if (!row) {
      const id = uuid();
      this.db.prepare(
        `insert into materials (id, workspace_id, name, path, kind, source, status, description, origin, session_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, this.projectId, name, normalized, kind, source, status,
        options.desc || (isInput ? "项目资料" : "项目产出"),
        options.origin || null, options.sessionId || null, now, now,
      );
      row = this.db.prepare(`select * from materials where id = ?`).get(id);
    } else if (row.deleted_at) {
      this.db.prepare(`update materials set deleted_at = null where id = ?`).run(row.id);
      row.deleted_at = null;
    }

    const latest = this.db.prepare(
      `select * from material_versions where material_id = ? order by v desc limit 1`,
    ).get(row.id);

    const changed = !latest || latest.blob_sha256 !== sha || options.forceVersion;
    if (changed) {
      const v = (latest?.v || 0) + 1;
      this.db.prepare(
        `insert into material_versions (
          material_id, v, blob_sha256, size, note, author, created_at, preview_json,
          visibility, run_id, reason
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, v, sha, stat.size,
        options.note || (v === 1 ? "项目文件" : "更新"),
        options.author || "Workbench",
        options.at || now,
        JSON.stringify(this.previewFor(normalized, content)),
        options.visibility === "internal" ? "internal" : "checkpoint",
        options.runId || null,
        options.reason || null,
      );
    }

    this.db.prepare(
      `update materials set updated_at = ?, name = ?, kind = ?, source = ?, status = ?, description = coalesce(?, description), origin = coalesce(?, origin) where id = ?`,
    ).run(
      options.at || now, name, kind, source,
      options.status || row.status,
      options.desc || null, options.origin || null, row.id,
    );

    return this.getMaterial(row.id);
  }

  getMaterial(id) {
    const row = this.db.prepare(`select * from materials where id = ? and workspace_id = ? and deleted_at is null`).get(id, this.projectId);
    if (!row) return null;

    const versions = this.db.prepare(
      `select * from material_versions where material_id = ? order by v desc`,
    ).all(row.id).map((version) => {
      const preview = version.preview_json ? JSON.parse(version.preview_json) : { type: "none" };
      if (preview.type === "image" && preview.path) {
        preview.url = `/api/file?path=${encodeURIComponent(preview.path)}`;
        delete preview.path;
      }
      return {
        v: version.v,
        at: formatWhen(version.created_at),
        createdAt: version.created_at,
        by: version.author,
        note: version.note,
        size: version.size,
        sha256: version.blob_sha256,
        visibility: version.visibility || "checkpoint",
        runId: version.run_id || null,
        reason: version.reason || null,
        preview,
      };
    });

    const when = dayTime(row.updated_at);
    const targetPlan = this.db.prepare(`select id from plans where target_id = ? limit 1`).get(row.id);
    const inputPlan = this.db.prepare(`select plan_id as id from plan_inputs where material_id = ? limit 1`).get(row.id);
    const links = this.db.prepare(`select input_id from material_links where material_id = ?`).all(row.id);

    return {
      id: row.id,
      projectId: row.workspace_id,
      name: row.path.startsWith("uploads/") ? row.name.replace(/^\d{13}-/, "") : row.name,
      path: `${this.projectLabel}/${row.path}`,
      relPath: row.path,
      kind: row.kind,
      source: row.source,
      status: row.status,
      desc: row.description,
      origin: row.origin || undefined,
      day: when.day,
      time: when.time,
      updatedAt: row.updated_at,
      taskId: targetPlan?.id || inputPlan?.id || undefined,
      derivedFrom: links.map((link) => link.input_id),
      versions,
    };
  }

  latestVersion(id) {
    return this.db.prepare(
      `select * from material_versions where material_id = ? order by v desc limit 1`,
    ).get(id) || null;
  }

  /**
   * Resolve one material version (or the latest when v is omitted) together
   * with the material's relative path and display name. The preview and
   * versioned-file endpoints use the immutable blob rather than whatever
   * happens to be on disk now.
   */
  getVersionRow(id, v = null) {
    const material = this.db.prepare(
      `select id, name, path, kind, source from materials where id = ? and workspace_id = ? and deleted_at is null`,
    ).get(id, this.projectId);
    if (!material) return null;
    const version = v
      ? this.db.prepare(
          `select * from material_versions where material_id = ? and v = ?`,
        ).get(id, Number(v))
      : this.latestVersion(id);
    if (!version) return null;
    return {
      material,
      version: {
        ...version,
        displayName: material.path.startsWith("uploads/")
          ? material.name.replace(/^\d{13}-/, "")
          : material.name,
      },
    };
  }

  listMaterials() {
    const rows = this.db.prepare(
      `select id from materials where workspace_id = ? and deleted_at is null order by updated_at desc`,
    ).all(this.projectId);
    return rows.map((row) => this.getMaterial(row.id)).filter(Boolean);
  }

  restoreVersion(id, v) {
    const row = this.db.prepare(`select * from materials where id = ? and workspace_id = ? and deleted_at is null`).get(id, this.projectId);
    if (!row) return null;
    const version = this.db.prepare(
      `select * from material_versions where material_id = ? and v = ?`,
    ).get(id, v);
    if (!version) return null;

    const blob = this.blobPath(version.blob_sha256);
    const target = path.join(this.workspace, row.path);
    fs.copyFileSync(blob, target);

    return this.indexFile(row.path, {
      note: `恢复自 v${v}`,
      author: "林默",
      status: "draft",
      forceVersion: true,
    });
  }

  deleteMaterial(id) {
    const row = this.db.prepare(`select * from materials where id = ? and workspace_id = ? and deleted_at is null`).get(id, this.projectId);
    if (!row) return false;
    this.db.prepare(`update materials set deleted_at = ? where id = ?`).run(nowIso(), id);
    return true;
  }

  findMaterialByPath(rel) {
    const row = this.db.prepare(
      `select id from materials where path = ? and workspace_id = ? and deleted_at is null`,
    ).get(rel, this.projectId);
    return row ? this.getMaterial(row.id) : null;
  }

  /* ---------- plans ---------- */

  getPlanRow(id) {
    return this.db.prepare(`select * from plans where id = ? and workspace_id = ?`).get(id, this.projectId);
  }

  getPlan(id) {
    const row = this.getPlanRow(id);
    if (!row) return null;
    return this.planDto(row);
  }

  listPlans() {
    return this.db.prepare(`select * from plans where workspace_id = ? order by created_at asc`).all(this.projectId)
      .map((row) => this.planDto(row));
  }

  planDto(row) {
    const inputs = this.db.prepare(`select material_id from plan_inputs where plan_id = ?`).all(row.id)
      .map((item) => item.material_id);
    const runs = this.db.prepare(
      `select * from plan_runs where plan_id = ? order by started_at desc limit 10`,
    ).all(row.id);
    const running = runs.some((run) => run.status === "running");
    const lastRun = runs.find((run) => run.status !== "running") || runs[0];

    return {
      id: row.id,
      projectId: row.workspace_id,
      name: row.name,
      desc: row.description,
      prompt: row.prompt,
      schedule: row.schedule_label,
      scheduleShort: row.schedule_label,
      enabled: !!row.enabled,
      running,
      nextRun: row.next_run_at ? formatWhen(row.next_run_at) : "—",
      nextRunAt: row.next_run_at,
      targetId: row.target_id || undefined,
      inputIds: inputs,
      lastRun: lastRun
        ? {
            at: formatWhen(lastRun.started_at),
            ok: lastRun.status === "ok",
            version: lastRun.version ?? null,
          }
        : { at: "—", ok: true, version: null },
      history: runs.map((run) => ({
        at: formatWhen(run.started_at),
        ok: run.status === "ok",
        note: run.message || (run.status === "running" ? "运行中…" : run.status === "ok" ? "成功" : "失败"),
        version: run.version ?? null,
      })),
    };
  }

  togglePlan(id) {
    const row = this.getPlanRow(id);
    if (!row) return null;
    this.db.prepare(`update plans set enabled = ? where id = ?`).run(row.enabled ? 0 : 1, id);
    return this.getPlan(id);
  }

  startPlanRun(planId) {
    const id = uuid();
    const started = nowIso();
    this.db.prepare(
      `insert into plan_runs (id, plan_id, started_at, status) values (?, ?, ?, 'running')`,
    ).run(id, planId, started);
    return { id, startedAt: started };
  }

  finishPlanRun(planId, runId, { ok, message, version }) {
    const ended = nowIso();
    this.db.prepare(
      `update plan_runs set ended_at = ?, status = ?, message = ?, version = ? where id = ?`,
    ).run(ended, ok ? "ok" : "failed", message || (ok ? "运行完成" : "运行失败"), version ?? null, runId);

    const plan = this.getPlanRow(planId);
    const next = plan ? this.computeNextRun(plan, new Date(ended)) : null;
    this.db.prepare(`update plans set last_run_at = ?, next_run_at = ? where id = ?`)
      .run(ended, next?.toISOString() || null, planId);
    return this.getPlan(planId);
  }

  computeNextRun(row, from = new Date()) {
    const [hour, minute] = String(row.at_time || "09:00").split(":").map(Number);
    const at = new Date(from);
    at.setSeconds(0, 0);
    at.setHours(hour, minute, 0, 0);
    if (row.freq === "weekly") {
      const weekday = Number(row.weekday ?? 5);
      for (let offset = 0; offset < 8; offset += 1) {
        const candidate = addDays(at, offset);
        if (candidate.getDay() === weekday && candidate > from) return candidate;
      }
      return addDays(at, 7);
    }
    if (at <= from) return addDays(at, 1);
    return at;
  }

  setPlanNextRun(planId, date) {
    this.db.prepare(`update plans set next_run_at = ? where id = ?`).run(date?.toISOString() || null, planId);
  }

  /* ---------- trackings ---------- */

  getTrackingRun(id) {
    return this.db.prepare(
      `select tr.* from tracking_runs tr
       join trackings t on t.id = tr.tracking_id
       where tr.id = ? and t.workspace_id = ?`,
    ).get(id, this.projectId) || null;
  }

  /** Raw run rows (newest first) for read-only historical views. */
  listTrackingRuns(trackingId, limit = 50) {
    return this.db.prepare(
      `select tr.* from tracking_runs tr
       join trackings t on t.id = tr.tracking_id
       where tr.tracking_id = ? and t.workspace_id = ?
       order by tr.started_at desc
       limit ?`,
    ).all(trackingId, this.projectId, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  getTrackingRow(id) {
    return this.db.prepare(`select * from trackings where id = ? and workspace_id = ?`).get(id, this.projectId);
  }

  getTracking(id) {
    const row = this.getTrackingRow(id);
    return row ? this.trackingDto(row) : null;
  }

  listTrackings() {
    return this.db.prepare(
      `select * from trackings where workspace_id = ? order by created_at asc`,
    ).all(this.projectId).map((row) => this.trackingDto(row));
  }

  findTrackingByTarget(targetId) {
    return this.db.prepare(
      `select * from trackings where workspace_id = ? and target_id = ? limit 1`,
    ).get(this.projectId, targetId) || null;
  }

  trackingDto(row) {
    const target = this.getMaterial(row.target_id);
    const runs = this.db.prepare(
      `select * from tracking_runs where tracking_id = ? order by started_at desc limit 10`,
    ).all(row.id);
    const running = runs.some((run) => run.status === "running");
    const lastRun = runs.find((run) => run.status !== "running") || runs[0] || null;
    const parsed = (run) => {
      if (!run?.result_json) return null;
      try {
        return JSON.parse(run.result_json);
      } catch {
        return null;
      }
    };
    const resultRun = runs.find((run) => run.result_json) || null;
    const result = parsed(resultRun);
    const schedule = {
      freq: row.freq,
      weekday: row.weekday ?? 1,
      day: row.day ?? 1,
      time: row.at_time,
    };
    const success = new Set(["updated", "no_change", "needs_review", "baseline"]);
    const duration = (run) => {
      if (!run?.ended_at) return "";
      const seconds = Math.max(1, Math.round((new Date(run.ended_at) - new Date(run.started_at)) / 1000));
      if (seconds < 60) return `${seconds}s`;
      return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    };
    const runDto = (run) => {
      const runResult = parsed(run);
      return {
        at: formatWhen(run.started_at),
        full: run.started_at,
        status: run.status,
        ok: success.has(run.status),
        version: run.result_version ?? null,
        conclusion: runResult?.conclusion || run.message || (run.status === "running" ? "运行中…" : "运行完成"),
        duration: duration(run),
        trigger: run.trigger,
      };
    };

    return {
      id: row.id,
      projectId: row.workspace_id,
      targetId: row.target_id,
      relPath: target?.relPath,
      targetPath: target?.relPath,
      targetName: target?.name || row.name,
      targetVersion: target?.versions?.[0]?.v ?? null,
      targetKind: target?.kind,
      template: row.template_id,
      enabled: !!row.enabled,
      running,
      schedule,
      scheduleLabel: row.schedule_label,
      scheduleShort: trackingScheduleShort(schedule),
      nextRunAt: row.next_run_at,
      nextRunLabel: row.enabled && row.next_run_at ? formatNextLabel(row.next_run_at) : "已暂停",
      lastRunAt: row.last_run_at,
      baseVersion: lastRun?.base_version ?? target?.versions?.[0]?.v ?? null,
      lastRun: lastRun ? runDto(lastRun) : null,
      runs: runs.map(runDto),
      result,
      mode: row.mode || "monitor",
      autonomyDefault: row.autonomy_default || "auto_notify",
      notificationPolicy: row.notification_policy || "in_app",
      contractVersion: row.contract_version ?? 0,
      monitors: this.listMonitorItems(row.id),
      notifications: this.listNotifications({ trackingId: row.id, limit: 5 }),
      approvals: this.listApprovalRequests({ trackingId: row.id, limit: 10 }),
    };
  }

  createTracking({ targetId, templateId, freq, weekday, day, time, name }) {
    const target = this.getMaterial(targetId);
    if (!target) throw Object.assign(new Error("target material not found"), { status: 404 });
    const schedule = {
      freq,
      weekday: Number(weekday) || 1,
      day: Number(day) || 1,
      time: time || "09:00",
    };
    const id = uuid();
    const now = nowIso();
    const next = computeTrackingNextRun(schedule);
    this.db.prepare(
      `insert into trackings (
        id, workspace_id, name, target_id, template_id, schedule_label,
        freq, at_time, weekday, day, timezone, enabled, next_run_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', 1, ?, ?)`,
    ).run(
      id, this.projectId, name || target.name, targetId, templateId,
      trackingScheduleLabel(schedule),
      schedule.freq, schedule.time, schedule.weekday, schedule.day,
      next.toISOString(), now,
    );
    return this.getTracking(id);
  }

  toggleTracking(id) {
    const row = this.getTrackingRow(id);
    if (!row) return null;
    const enabled = row.enabled ? 0 : 1;
    const schedule = {
      freq: row.freq,
      weekday: row.weekday ?? 1,
      day: row.day ?? 1,
      time: row.at_time,
    };
    const next = enabled ? computeTrackingNextRun(schedule) : null;
    this.db.prepare(
      `update trackings set enabled = ?, next_run_at = ?, lease_until = null where id = ?`,
    ).run(enabled, next?.toISOString() || null, id);
    return this.getTracking(id);
  }

  updateTrackingSchedule(id, input) {
    const row = this.getTrackingRow(id);
    if (!row) return null;
    const schedule = {
      freq: input.freq,
      weekday: Number(input.weekday) || 1,
      day: Number(input.day) || 1,
      time: input.time || "09:00",
    };
    const next = row.enabled ? computeTrackingNextRun(schedule) : null;
    this.db.prepare(
      `update trackings set schedule_label = ?, freq = ?, at_time = ?, weekday = ?, day = ?, next_run_at = ? where id = ?`,
    ).run(
      trackingScheduleLabel(schedule), schedule.freq, schedule.time,
      schedule.weekday, schedule.day, next?.toISOString() || null, id,
    );
    return this.getTracking(id);
  }

  deleteTracking(id) {
    this.db.prepare(`delete from source_events where tracking_id = ? and workspace_id = ?`).run(id, this.projectId);
    this.db.prepare(`delete from notifications where tracking_id = ? and workspace_id = ?`).run(id, this.projectId);
    this.db.prepare(
      `delete from run_changes where workspace_id = ?
       and run_id in (select id from tracking_runs where tracking_id = ?)`,
    ).run(this.projectId, id);
    const result = this.db.prepare(`delete from trackings where id = ?`).run(id);
    return result.changes > 0;
  }

  startTrackingRun(trackingId, { trigger = "manual", baseVersion = null, scheduledFor = null } = {}) {
    const id = uuid();
    const started = nowIso();
    this.db.prepare(
      `insert into tracking_runs (
        id, tracking_id, trigger, started_at, status, base_version, scheduled_for
      ) values (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(id, trackingId, trigger, started, baseVersion, scheduledFor);
    return { id, startedAt: started };
  }

  finishTrackingRun(trackingId, runId, {
    status,
    message,
    resultVersion = null,
    result = null,
    sessionId = null,
    notificationId = null,
    decisionClass = null,
    confidence = null,
  }) {
    const ended = nowIso();
    this.db.prepare(
      `update tracking_runs set ended_at = ?, status = ?, result_version = ?, result_json = ?, message = ?, session_id = ?, notification_id = ?, decision_class = ?, confidence = ? where id = ?`,
    ).run(
      ended, status, resultVersion ?? null,
      result ? JSON.stringify(result) : null,
      message || "", sessionId, notificationId, decisionClass, confidence, runId,
    );
    const row = this.getTrackingRow(trackingId);
    let next = null;
    if (row) {
      const schedule = {
        freq: row.freq,
        weekday: row.weekday ?? 1,
        day: row.day ?? 1,
        time: row.at_time,
      };
      next = row.enabled ? computeTrackingNextRun(schedule, new Date(ended)) : null;
      this.db.prepare(
        `update trackings set last_run_at = ?, next_run_at = ?, lease_until = null where id = ?`,
      ).run(ended, next?.toISOString() || null, trackingId);
    }
    return this.getTracking(trackingId);
  }

  recoverTrackingRuns() {
    const now = nowIso();
    const interrupted = this.db.prepare(
      `update tracking_runs set ended_at = ?, status = 'failed', message = '服务重启中断' where status = 'running'`,
    ).run(now);
    this.db.prepare(`update trackings set lease_until = null where lease_until is not null`).run();
    return interrupted.changes;
  }

  listDueTrackings(now = new Date()) {
    const iso = now.toISOString();
    return this.db.prepare(
      `select * from trackings
       where workspace_id = ? and enabled = 1 and next_run_at is not null and next_run_at <= ?
         and (lease_until is null or lease_until < ?)
         and not exists (
           select 1 from tracking_runs
           where tracking_runs.tracking_id = trackings.id and tracking_runs.status = 'running'
         )
       order by next_run_at asc limit 5`,
    ).all(this.projectId, iso, iso);
  }

  claimTracking(id, leaseUntil) {
    const now = nowIso();
    const result = this.db.prepare(
      `update trackings set lease_until = ? where id = ? and (lease_until is null or lease_until < ?)`,
    ).run(leaseUntil.toISOString(), id, now);
    return result.changes > 0;
  }

  clearTrackingLease(id) {
    this.db.prepare(`update trackings set lease_until = null where id = ?`).run(id);
  }

  /* ---------- monitor items ---------- */

  monitorItemDto(row) {
    let source = {};
    try {
      source = row.source_json ? JSON.parse(row.source_json) : {};
    } catch {
      source = { text: String(row.source_json || "") };
    }
    return {
      id: row.id,
      trackingId: row.tracking_id,
      falsifierId: row.falsifier_id,
      thesisId: row.thesis_id,
      metric: row.metric,
      operator: row.operator,
      warning: row.warning,
      threshold: row.threshold,
      unit: row.unit,
      frequency: row.frequency,
      source,
      action: row.action,
      rationale: row.rationale,
      status: row.status,
      lastObserved: row.last_observed,
      lastCheckedAt: row.last_checked_at,
      nextCheckAt: row.next_check_at,
      autonomy: row.autonomy,
      updatedAt: row.updated_at,
    };
  }

  listMonitorItems(trackingId = null) {
    const rows = trackingId
      ? this.db.prepare(
          `select * from monitor_items where workspace_id = ? and tracking_id = ? order by id asc`,
        ).all(this.projectId, trackingId)
      : this.db.prepare(
          `select * from monitor_items where workspace_id = ? order by id asc`,
        ).all(this.projectId);
    return rows.map((row) => this.monitorItemDto(row));
  }

  listDueMonitorItems(now = new Date(), limit = 20) {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const rows = this.db.prepare(
      `select mi.* from monitor_items mi
       join trackings t on t.id = mi.tracking_id
       where mi.workspace_id = ?
         and t.workspace_id = mi.workspace_id
         and t.enabled = 1
         and mi.status in ('armed', 'warning', 'unknown')
         and mi.frequency != 'event'
         and mi.next_check_at is not null
         and mi.next_check_at <= ?
         and not exists (
           select 1 from tracking_runs tr
           where tr.tracking_id = mi.tracking_id and tr.status = 'running'
         )
       order by mi.next_check_at asc, mi.id asc
       limit ?`,
    ).all(this.projectId, day, Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map((row) => this.monitorItemDto(row));
  }

  getMonitorItem(id, trackingId = null) {
    const row = trackingId
      ? this.db.prepare(
          `select * from monitor_items where id = ? and workspace_id = ? and tracking_id = ?`,
        ).get(id, this.projectId, trackingId)
      : this.db.prepare(
          `select * from monitor_items where id = ? and workspace_id = ? limit 1`,
        ).get(id, this.projectId);
    return row ? this.monitorItemDto(row) : null;
  }

  replaceMonitorItems(trackingId, items) {
    const now = nowIso();
    this.db.exec("begin");
    try {
      this.db.prepare(
        `delete from monitor_items where tracking_id = ? and workspace_id = ?`,
      ).run(trackingId, this.projectId);
      const insert = this.db.prepare(
        `insert into monitor_items (
          id, workspace_id, tracking_id, falsifier_id, thesis_id, metric, operator,
          warning, threshold, unit, frequency, source_json, action, rationale, status,
          last_observed, last_checked_at, next_check_at, autonomy, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insert.run(
          item.id, this.projectId, trackingId, item.falsifier_id || "", item.thesis_id || "",
          item.metric || "", item.operator || "", item.warning || "", item.threshold || "",
          item.unit || "", item.frequency || "monthly",
          JSON.stringify(item.source || {}), item.action || "", item.rationale || "",
          item.status || "armed", item.last_observed || "", item.last_checked_at || null,
          item.next_check_at || null, item.autonomy || "auto_notify", now, now,
        );
      }
      this.db.prepare(
        `update trackings set contract_version = contract_version + 1 where id = ? and workspace_id = ?`,
      ).run(trackingId, this.projectId);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.listMonitorItems(trackingId);
  }

  updateMonitorItem(id, patch = {}, trackingId = null) {
    const row = this.getMonitorItem(id, trackingId);
    if (!row) return null;
    const next = {
      ...row,
      ...patch,
      thesisId: patch.thesis_id ?? patch.thesisId ?? row.thesisId,
      lastObserved: patch.last_observed ?? patch.lastObserved ?? row.lastObserved,
      lastCheckedAt: patch.last_checked_at ?? patch.lastCheckedAt ?? row.lastCheckedAt,
      nextCheckAt: patch.next_check_at ?? patch.nextCheckAt ?? row.nextCheckAt,
    };
    this.db.prepare(
      `update monitor_items set thesis_id = ?, metric = ?, operator = ?, warning = ?,
         threshold = ?, unit = ?, frequency = ?, source_json = ?, action = ?, rationale = ?,
         status = ?, last_observed = ?, last_checked_at = ?, next_check_at = ?, autonomy = ?,
         updated_at = ? where id = ? and workspace_id = ? and tracking_id = ?`,
    ).run(
      next.thesisId || "", next.metric || "", next.operator || "", next.warning || "",
      next.threshold || "", next.unit || "", next.frequency || "monthly",
      JSON.stringify(next.source || {}), next.action || "", next.rationale || "",
      next.status || "armed", next.lastObserved || "", next.lastCheckedAt || null,
      next.nextCheckAt || null, next.autonomy || "auto_notify", nowIso(), id, this.projectId,
      row.trackingId,
    );
    return this.getMonitorItem(id, row.trackingId);
  }

  /* ---------- source bindings / events ---------- */

  sourceBindingDto(row) {
    return {
      id: row.id,
      trackingId: row.tracking_id,
      monitorItemId: row.monitor_item_id,
      adapter: row.adapter,
      query: row.query,
      sourceTier: row.source_tier,
      intervalMinutes: row.interval_minutes,
      nextPollAt: row.next_poll_at,
      lastPolledAt: row.last_polled_at,
      enabled: !!row.enabled,
    };
  }

  listSourceBindings(trackingId = null) {
    const rows = trackingId
      ? this.db.prepare(`select * from source_bindings where workspace_id = ? and tracking_id = ? order by created_at asc`).all(this.projectId, trackingId)
      : this.db.prepare(`select * from source_bindings where workspace_id = ? order by created_at asc`).all(this.projectId);
    return rows.map((row) => this.sourceBindingDto(row));
  }

  replaceSourceBindings(trackingId, bindings = []) {
    const now = nowIso();
    this.db.exec("begin");
    try {
      this.db.prepare(`delete from source_bindings where tracking_id = ? and workspace_id = ?`).run(trackingId, this.projectId);
      const insert = this.db.prepare(
        `insert into source_bindings (
          id, workspace_id, tracking_id, monitor_item_id, adapter, query, source_tier,
          interval_minutes, next_poll_at, last_polled_at, enabled, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)`,
      );
      for (const binding of bindings) {
        insert.run(
          uuid(), this.projectId, trackingId, binding.monitorItemId || null,
          binding.adapter || "anysearch", binding.query || "", Number(binding.sourceTier) || 3,
          Math.max(30, Number(binding.intervalMinutes) || 360),
          binding.nextPollAt || now, binding.enabled === false ? 0 : 1, now, now,
        );
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.listSourceBindings(trackingId);
  }

  listDueSourceBindings(now = new Date(), limit = 5) {
    const rows = this.db.prepare(
      `select sb.* from source_bindings sb
       join trackings t on t.id = sb.tracking_id
       where sb.workspace_id = ? and sb.enabled = 1 and t.enabled = 1
         and sb.next_poll_at is not null and sb.next_poll_at <= ?
       order by sb.next_poll_at asc limit ?`,
    ).all(this.projectId, now.toISOString(), Math.max(1, Math.min(50, Number(limit) || 5)));
    return rows.map((row) => this.sourceBindingDto(row));
  }

  updateSourceBinding(id, { nextPollAt = null, lastPolledAt = null } = {}) {
    const now = nowIso();
    this.db.prepare(
      `update source_bindings set next_poll_at = coalesce(?, next_poll_at),
         last_polled_at = coalesce(?, last_polled_at), updated_at = ? where id = ? and workspace_id = ?`,
    ).run(nextPollAt, lastPolledAt, now, id, this.projectId);
    const row = this.db.prepare(`select * from source_bindings where id = ? and workspace_id = ?`).get(id, this.projectId);
    return row ? this.sourceBindingDto(row) : null;
  }

  createSourceEvent({
    trackingId = null,
    monitorItemId = null,
    adapter = "anysearch",
    sourceTier = 3,
    domain = "",
    url = "",
    title = "",
    publishedAt = null,
    contentHash = "",
    payload = null,
    triageStatus = "new",
    relevance = "",
  } = {}) {
    const hash = contentHash
      || crypto.createHash("sha256").update(`${url}\n${title}`).digest("hex");
    const existing = this.db.prepare(
      `select * from source_events where workspace_id = ? and content_hash = ? limit 1`,
    ).get(this.projectId, hash);
    if (existing) return { ...this.sourceEventDto(existing), duplicate: true };
    const id = uuid();
    const now = nowIso();
    this.db.prepare(
      `insert into source_events (
        id, workspace_id, tracking_id, monitor_item_id, adapter, source_tier, domain,
        url, title, published_at, fetched_at, content_hash, payload_json,
        triage_status, relevance, used_in_run_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
    ).run(
      id, this.projectId, trackingId, monitorItemId, adapter, Number(sourceTier) || 3, domain,
      url, title, publishedAt, now, hash, payload ? JSON.stringify(payload) : null,
      triageStatus, relevance, now,
    );
    return this.sourceEventDto(this.db.prepare(`select * from source_events where id = ?`).get(id));
  }

  sourceEventDto(row) {
    let payload = null;
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    } catch {
      payload = null;
    }
    return {
      id: row.id,
      trackingId: row.tracking_id,
      monitorItemId: row.monitor_item_id,
      adapter: row.adapter,
      sourceTier: row.source_tier,
      domain: row.domain,
      url: row.url,
      title: row.title,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      triageStatus: row.triage_status,
      relevance: row.relevance,
      usedInRunId: row.used_in_run_id,
      payload,
    };
  }

  listSourceEvents({ trackingId = null, limit = 30, pendingOnly = false } = {}) {
    const clauses = ["workspace_id = ?"];
    const params = [this.projectId];
    if (trackingId) {
      clauses.push("tracking_id = ?");
      params.push(trackingId);
    }
    if (pendingOnly) clauses.push("triage_status = 'relevant' and used_in_run_id is null");
    const rows = this.db.prepare(
      `select * from source_events where ${clauses.join(" and ")}
       order by created_at desc limit ?`,
    ).all(...params, Math.max(1, Math.min(200, Number(limit) || 30)));
    return rows.map((row) => this.sourceEventDto(row));
  }

  listPendingRelevantEvents(limit = 20) {
    const rows = this.db.prepare(
      `select se.* from source_events se
       join trackings t on t.id = se.tracking_id
       where se.workspace_id = ? and se.triage_status = 'relevant'
         and se.used_in_run_id is null and t.enabled = 1
       order by se.created_at asc limit ?`,
    ).all(this.projectId, Math.max(1, Math.min(100, Number(limit) || 20)));
    return rows.map((row) => this.sourceEventDto(row));
  }

  markSourceEventsUsed(ids = [], runId = "") {
    if (!ids.length || !runId) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this.db.prepare(
      `update source_events set used_in_run_id = ? where workspace_id = ? and id in (${placeholders})`,
    ).run(runId, this.projectId, ...ids);
    return result.changes;
  }

  /* ---------- run changes (undo) ---------- */

  recordRunChange({
    runId,
    objectType,
    objectId = "",
    before = null,
    after = null,
    evidenceIds = [],
    applied = true,
  }) {
    const id = uuid();
    this.db.prepare(
      `insert into run_changes (
        id, workspace_id, run_id, object_type, object_id, before_json, after_json,
        evidence_ids, applied, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, this.projectId, runId, objectType, objectId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      evidenceIds.length ? JSON.stringify(evidenceIds) : null,
      applied ? 1 : 0, nowIso(),
    );
    return { id, runId, objectType, objectId, before, after };
  }

  listRunChanges(runId) {
    const rows = this.db.prepare(
      `select * from run_changes where workspace_id = ? and run_id = ? order by created_at asc`,
    ).all(this.projectId, runId);
    const parse = (value) => {
      try {
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    };
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      objectType: row.object_type,
      objectId: row.object_id,
      before: parse(row.before_json),
      after: parse(row.after_json),
      evidenceIds: parse(row.evidence_ids) || [],
      applied: !!row.applied,
      createdAt: row.created_at,
    }));
  }

  markRunChangesReverted(runId) {
    return this.db.prepare(
      `update run_changes set applied = 0 where workspace_id = ? and run_id = ?`,
    ).run(this.projectId, runId).changes;
  }

  /* ---------- notifications ---------- */

  notificationDto(row) {
    const parse = (value, fallback) => {
      try {
        return value ? JSON.parse(value) : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      id: row.id,
      trackingId: row.tracking_id,
      runId: row.run_id,
      severity: row.severity,
      title: row.title,
      body: row.body,
      changes: parse(row.changes_json, []),
      actions: parse(row.actions_json, []),
      readAt: row.read_at,
      createdAt: row.created_at,
    };
  }

  createNotification({
    trackingId = null,
    runId = null,
    severity = "info",
    title,
    body = "",
    changes = [],
    actions = [],
  } = {}) {
    if (!title) throw new Error("notification title is required");
    const id = uuid();
    this.db.prepare(
      `insert into notifications (
        id, workspace_id, tracking_id, run_id, severity, title, body,
        changes_json, actions_json, read_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
    ).run(
      id, this.projectId, trackingId, runId, severity, title, body,
      JSON.stringify(changes || []), JSON.stringify(actions || []), nowIso(),
    );
    return this.notificationDto(
      this.db.prepare(`select * from notifications where id = ?`).get(id),
    );
  }

  listNotifications({ limit = 30, unreadOnly = false, trackingId = null } = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 30));
    const clauses = ["workspace_id = ?"];
    const params = [this.projectId];
    if (unreadOnly) clauses.push("read_at is null");
    if (trackingId) {
      clauses.push("tracking_id = ?");
      params.push(trackingId);
    }
    const rows = this.db.prepare(
      `select * from notifications where ${clauses.join(" and ")}
       order by created_at desc limit ?`,
    ).all(...params, max);
    return rows.map((row) => this.notificationDto(row));
  }

  markNotificationRead(id) {
    const result = this.db.prepare(
      `update notifications set read_at = ? where id = ? and workspace_id = ? and read_at is null`,
    ).run(nowIso(), id, this.projectId);
    if (!result.changes) {
      const row = this.db.prepare(
        `select * from notifications where id = ? and workspace_id = ?`,
      ).get(id, this.projectId);
      return row ? this.notificationDto(row) : null;
    }
    const row = this.db.prepare(`select * from notifications where id = ?`).get(id);
    return row ? this.notificationDto(row) : null;
  }

  seedTrackings() {
    const count = this.db.prepare(`select count(*) as n from trackings`).get().n;
    if (count > 0) return 0;
    const seeds = [
      {
        path: "exports/investment-model/长鑫存储高盛模型/投资框架报告.md",
        templateId: "framework",
        schedule: { freq: "weekly", weekday: 1, day: 1, time: "09:00" },
      },
      {
        path: "uploads/1792400627391-高盛-长鑫-Model-20260904.xlsx",
        templateId: "model",
        schedule: { freq: "monthly", weekday: 1, day: 1, time: "09:00" },
      },
      {
        path: "exports/investment-model/长鑫存储高盛模型/同行行情.md",
        templateId: "generic",
        schedule: { freq: "weekly", weekday: 5, day: 1, time: "18:00" },
      },
    ];
    let created = 0;
    for (const seed of seeds) {
      const target = this.findMaterialByPath(seed.path);
      if (!target) continue;
      if (this.findTrackingByTarget(target.id)) continue;
      try {
        this.createTracking({
          targetId: target.id,
          templateId: seed.templateId,
          ...seed.schedule,
        });
        created += 1;
      } catch {
        /* a seed must not prevent startup */
      }
    }
    return created;
  }

  /* ---------- seed ---------- */

  async seed() {
    const seeded = this.db.prepare(`select value from meta where key = 'seeded'`).get();
    if (seeded?.value === "1") return;
    const count = this.db.prepare(`select count(*) as n from materials`).get().n;
    if (count > 0) {
      this.db.prepare(`insert or replace into meta (key, value) values ('seeded', '1')`).run();
      return;
    }

    const seedFiles = {
      "exports/竞品周报.md": `# 竞品定价周报 · 2026-W42

## 本周变化
- Linear：Business 年付折扣 20% → 25%
- Figma：新增 Organization 档，$55 / 席位

## 解读
Linear 在 50 人以上区间的年付价已经低于 Team 档月付折算，销售侧需要准备对标话术。
`,
      "inputs/竞品定价页快照.html": `<section class="plan" data-vendor="linear">
  <h3>Linear</h3>
  <p>Business — $14 / user / month</p>
  <p class="discount">年付折扣 25%</p>
</section>

<section class="plan" data-vendor="figma">
  <h3>Figma</h3>
  <p>Organization — $55 / seat / month</p>
</section>
`,
      "inputs/访谈手记.md": `# 访谈手记

- P3：文件最后存在哪里说不清
- P5：会话多了找不到上次结论
- P6：希望能按项目归档
`,
      "exports/客户访谈摘要.md": `# 客户访谈摘要（10 月）

## 共同问题
- 不知道文件最终存在哪里
- 会话多了以后找不到上次的结论
`,
    };

    for (const [rel, content] of Object.entries(seedFiles)) {
      const target = path.join(this.workspace, rel);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }

    const descriptions = {
      "pricing-matrix.csv": "三档定价的字段源表。",
      "exports/定价摘要.md": "三档定价的对比摘要，供定价页与销售使用。",
      "exports/定价页文案.md": "定价页的正文与标题文案。",
      "exports/竞品周报.md": "每周汇总三家竞品的定价变化。",
      "inputs/竞品定价页快照.html": "三家竞品定价页的抓取快照。",
      "inputs/访谈手记.md": "访谈现场记录，按场次整理。",
      "exports/客户访谈摘要.md": "六场访谈的共同问题与原文摘录。",
      "uploads/q4-goal.md": "Q4 目标与席位区间的补充说明。",
      "uploads/ui-upload.md": "测试上传文件。",
    };
    const origins = {
      "inputs/竞品定价页快照.html": "linear.com/pricing · figma.com/pricing · notion.so/pricing",
    };
    const statuses = {
      "exports/定价摘要.md": "final",
      "exports/定价页文案.md": "final",
      "exports/竞品周报.md": "live",
      "exports/客户访谈摘要.md": "draft",
    };

    const files = [];
    const walk = (relDir) => {
      const absolute = path.join(this.workspace, relDir);
      if (!fs.existsSync(absolute)) return;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "backups") continue;
        const rel = path.join(relDir, entry.name).split(path.sep).join("/");
        if (entry.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    for (const dir of ["exports", "inputs", "uploads"]) walk(dir);
    for (const entry of fs.readdirSync(this.workspace, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith(".") && entry.name !== "AGENTS.md") files.push(entry.name);
    }

    const byPath = new Map();
    for (const rel of files) {
      const isUpload = rel.startsWith("uploads/");
      const stat = fs.statSync(path.join(this.workspace, rel));
      const material = this.indexFile(rel, {
        source: isUpload ? "upload" : "agent",
        author: isUpload ? "林默" : "Workbench",
        note: isUpload ? "上传" : "项目文件",
        kind: rel === "pricing-matrix.csv" ? "input" : undefined,
        status: rel === "pricing-matrix.csv" ? "synced" : statuses[rel] || (isUpload || rel.startsWith("inputs/") ? "synced" : "draft"),
        desc: descriptions[rel],
        origin: origins[rel],
        at: stat.mtime.toISOString(),
      });
      byPath.set(rel, material);
    }

    const planSeeds = [
      {
        name: "竞品周报自动更新",
        description: "抓取竞品定价页，有变化时重写周报并生成新版本。",
        prompt: "读取 inputs/竞品定价页快照.html 和 pricing-matrix.csv，更新 exports/竞品周报.md：先写本周变化，再写解读，三节以内。有变化才更新，没变化就说明原因。",
        schedule: "每周五 09:00", freq: "weekly", weekday: 5, atTime: "09:00",
        target: "exports/竞品周报.md",
        inputs: ["inputs/竞品定价页快照.html", "pricing-matrix.csv"],
        enabled: 1,
        history: [
          { daysAgo: 3, status: "ok", version: 1, message: "成功 · 1m12s" },
          { daysAgo: 10, status: "ok", version: 1, message: "成功 · 58s" },
        ],
      },
      {
        name: "定价页同步校验",
        description: "检查定价表是否变化，有变化时同步更新摘要并记一个新版本。",
        prompt: "读取 pricing-matrix.csv 和 exports/定价摘要.md，如果定价表有变化就更新摘要，保持三行以内；没有变化就说明无变化，不要写文件。",
        schedule: "每天 18:00", freq: "daily", weekday: null, atTime: "18:00",
        target: "exports/定价摘要.md",
        inputs: ["pricing-matrix.csv"],
        enabled: 1,
        history: [
          { daysAgo: 1, status: "ok", version: 1, message: "成功 · 24s" },
          { daysAgo: 2, status: "ok", version: 1, message: "跳过 · 无变化" },
        ],
      },
      {
        name: "客户访谈归档",
        description: "把访谈手记合并进月度摘要，并标注新增结论。",
        prompt: "读取 inputs/访谈手记.md 和 exports/客户访谈摘要.md，把新结论合并进摘要，保留原文引用。",
        schedule: "每周一 10:00", freq: "weekly", weekday: 1, atTime: "10:00",
        target: "exports/客户访谈摘要.md",
        inputs: ["inputs/访谈手记.md"],
        enabled: 0,
        history: [
          { daysAgo: 6, status: "ok", version: 1, message: "成功 · 31s" },
        ],
      },
    ];

    for (const seed of planSeeds) {
      const target = byPath.get(seed.target);
      const planId = uuid();
      const nextRun = this.computeNextRun(
        { freq: seed.freq, at_time: seed.atTime, weekday: seed.weekday },
        new Date(),
      );
      this.db.prepare(
        `insert into plans (id, workspace_id, name, description, prompt, schedule_label, freq, at_time, weekday, enabled, target_id, next_run_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        planId, this.projectId, seed.name, seed.description, seed.prompt,
        seed.schedule, seed.freq, seed.atTime, seed.weekday,
        seed.enabled, target?.id || null, nextRun.toISOString(), nowIso(),
      );
      for (const rel of seed.inputs) {
        const input = byPath.get(rel);
        if (!input) continue;
        this.db.prepare(`insert or ignore into plan_inputs (plan_id, material_id) values (?, ?)`).run(planId, input.id);
        if (target) {
          this.db.prepare(`insert or ignore into material_links (material_id, input_id) values (?, ?)`).run(target.id, input.id);
        }
      }
      for (const run of seed.history) {
        const started = addDays(new Date(), -run.daysAgo).toISOString();
        this.db.prepare(
          `insert into plan_runs (id, plan_id, started_at, ended_at, status, version, message) values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(uuid(), planId, started, started, run.status, run.version, run.message);
      }
    }

    this.db.prepare(`insert or replace into meta (key, value) values ('seeded', '1')`).run();
  }
}

export async function openStore({
  root,
  workspace,
  projectId = WORKSPACE_ID,
  projectName = "Product Eng",
  projectNote = "",
  seed = true,
}) {
  const dataDir = path.join(root, "data");
  await fsp.mkdir(path.join(dataDir, "blobs"), { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "workbench.db"));
  const store = new Store(db, { workspace, dataDir, projectId, projectName, projectNote });
  store.migrate();
  if (seed) await store.seed();
  return store;
}

