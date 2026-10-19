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

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`alter table ${table} add column ${column} ${definition}`);
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

      create index if not exists idx_materials_updated on materials(workspace_id, updated_at desc);
      create index if not exists idx_versions_material on material_versions(material_id, v desc);
      create index if not exists idx_runs_plan on plan_runs(plan_id, started_at desc);
      create index if not exists idx_trackings_next on trackings(enabled, next_run_at);
      create index if not exists idx_tracking_runs on tracking_runs(tracking_id, started_at desc);
    `);

    // Older databases predate the project metadata columns.
    this.ensureColumn("workspaces", "note", "text not null default ''");
    this.ensureColumn("workspaces", "accent", "text not null default 'slate'");
    this.ensureColumn("workspaces", "updated_at", "text");
    this.ensureColumn("workspaces", "last_opened_at", "text");

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
        `insert into material_versions (material_id, v, blob_sha256, size, note, author, created_at, preview_json)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, v, sha, stat.size,
        options.note || (v === 1 ? "项目文件" : "更新"),
        options.author || "Workbench",
        options.at || now,
        JSON.stringify(this.previewFor(normalized, content)),
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
  }) {
    const ended = nowIso();
    this.db.prepare(
      `update tracking_runs set ended_at = ?, status = ?, result_version = ?, result_json = ?, message = ?, session_id = ? where id = ?`,
    ).run(
      ended, status, resultVersion ?? null,
      result ? JSON.stringify(result) : null,
      message || "", sessionId, runId,
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

