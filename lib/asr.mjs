/**
 * Background speech-to-text (ASR) for uploaded audio.
 *
 * 17zhiling's audio endpoint takes a public URL, not a file upload. The full
 * flow is therefore three remote calls plus polling:
 *
 *   1. GET  /api/upload/signature        -> S3 form + public fileUrl
 *   2. POST <uploadUrl> (multipart)      -> audio is now publicly reachable
 *   3. POST /api/asr/parse-audio-url-time -> taskId
 *   4. GET  /api/asr/task-status          -> WAIT_HANDLE / ING / SUCCESS / FAIL
 *
 * Everything is persisted in `asr_tasks`, keyed by (workspace_id, blob_sha256),
 * so a restart resumes polling instead of paying for the same audio twice.
 * Uploads are serialized through a small in-process queue; polling is a timer
 * that only touches tasks whose next_poll_at is due.
 *
 * This class deliberately knows nothing about HTTP routing or SSE. The server
 * passes an `onChange(materialId)` callback and re-broadcasts the material DTO.
 */

import fs from "node:fs/promises";
import {
  asrDto,
  extOf,
  isAsrExt,
  isAudioExt,
} from "./asr-status.mjs";

const DEFAULT_API_BASE = "https://api.17zhiling.com";
const CONTENT_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};
const MAX_CONTENT_CHARS = 2_000_000;

function nowIso() {
  return new Date().toISOString();
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function errorWith(message, status = 500, code = "asr_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function clip(text, max = 2_000_000) {
  const value = String(text || "");
  return value.length > max ? value.slice(0, max) : value;
}

function scheduleOf(data) {
  return String(data?.schedule || "").toUpperCase();
}

export class AsrService {
  constructor({
    store,
    apiKey = "",
    apiBase = DEFAULT_API_BASE,
    fetchImpl = globalThis.fetch,
    pollIntervalMs = 4_000,
    tickMs = 1_000,
    concurrency = 2,
    requestTimeoutMs = 20_000,
    uploadTimeoutMs = 180_000,
    maxWaitMs = 60 * 60 * 1000,
    maxPollErrors = 20,
    onChange = () => {},
    autoStart = true,
  } = {}) {
    if (!store) throw new Error("AsrService requires a store");
    this.store = store;
    this.db = store.db;
    this.workspaceId = store.projectId;
    this.apiKey = String(apiKey || "");
    this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.tickMs = tickMs;
    this.concurrency = Math.max(1, concurrency);
    this.requestTimeoutMs = requestTimeoutMs;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this.maxWaitMs = maxWaitMs;
    this.maxPollErrors = maxPollErrors;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.configured = Boolean(this.apiKey);
    this.started = false;
    this.closed = false;
    this.pumping = false;
    this.polling = false;
    this.inflight = new Map();
    this.abort = new AbortController();
    this.timer = null;
    this.ensureSchema();
    this.recover();
    if (autoStart) this.boot();
  }

  /* ---------- schema / persistence ---------- */

  ensureSchema() {
    this.db.exec(`
      create table if not exists asr_tasks (
        workspace_id text not null,
        blob_sha256 text not null,
        material_id text not null,
        version integer not null,
        file_name text not null,
        status text not null,
        detail text,
        task_id text,
        audio_url text,
        content text,
        srt_content text,
        error text,
        poll_errors integer not null default 0,
        created_at text not null,
        updated_at text not null,
        submitted_at text,
        finished_at text,
        next_poll_at text,
        primary key (workspace_id, blob_sha256)
      );
      create index if not exists idx_asr_due on asr_tasks(workspace_id, status, next_poll_at);
    `);
  }

  recover() {
    const now = nowIso();
    this.db.prepare(
      `update asr_tasks
          set status = 'failed', error = ?, finished_at = ?, updated_at = ?, next_poll_at = null
        where workspace_id = ? and status in ('preparing','uploading','submitting')`,
    ).run("服务重启时上传/提交中断，请重试", now, now, this.workspaceId);
    this.db.prepare(
      `update asr_tasks
          set status = 'failed', error = ?, finished_at = ?, updated_at = ?, next_poll_at = null
        where workspace_id = ? and status in ('waiting','processing')
          and (task_id is null or task_id = '')`,
    ).run("服务重启后找不到远程任务 ID，请重试", now, now, this.workspaceId);
    this.db.prepare(
      `update asr_tasks set next_poll_at = ?, updated_at = ? 
        where workspace_id = ? and status in ('waiting','processing')`,
    ).run(now, now, this.workspaceId);
    // A paused task already has a remote taskId (and has been paid for).
    // If the key is available again, resume polling without resubmitting.
    if (this.configured) {
      this.db.prepare(
        `update asr_tasks
            set status = 'waiting', error = null, next_poll_at = ?, updated_at = ?
          where workspace_id = ? and status = 'paused' and task_id is not null`,
      ).run(now, now, this.workspaceId);
    }
  }

  getRecord(sha) {
    return this.db.prepare(
      `select * from asr_tasks where workspace_id = ? and blob_sha256 = ?`,
    ).get(this.workspaceId, sha) || null;
  }

  update(sha, fields = {}) {
    const allowed = new Set([
      "status", "detail", "task_id", "audio_url", "content", "srt_content",
      "error", "poll_errors", "submitted_at", "finished_at", "next_poll_at",
      "material_id", "version", "file_name",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const sets = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(
      `update asr_tasks set ${sets}, updated_at = ? where workspace_id = ? and blob_sha256 = ?`,
    ).run(
      ...entries.map(([, value]) => value),
      nowIso(),
      this.workspaceId,
      sha,
    );
  }

  queueRecord(info, { status = "queued", error = null } = {}) {
    const now = nowIso();
    const existing = this.getRecord(info.sha);
    if (!existing) {
      this.db.prepare(
        `insert into asr_tasks
           (workspace_id, blob_sha256, material_id, version, file_name, status, detail,
            task_id, audio_url, content, srt_content, error, poll_errors,
            created_at, updated_at, submitted_at, finished_at, next_poll_at)
         values (?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, 0, ?, ?, null, null, null)`,
      ).run(
        this.workspaceId, info.sha, info.material.id, info.version.v, info.name,
        status, error, now, now,
      );
      return;
    }
    const cleared = status === "queued";
    this.update(info.sha, {
      material_id: info.material.id,
      version: info.version.v,
      file_name: info.name,
      status,
      error,
      detail: cleared ? null : existing.detail,
      task_id: cleared ? null : existing.task_id,
      audio_url: cleared ? null : existing.audio_url,
      content: cleared ? null : existing.content,
      srt_content: cleared ? null : existing.srt_content,
      poll_errors: 0,
      submitted_at: cleared ? null : existing.submitted_at,
      finished_at: cleared ? null : existing.finished_at,
      next_poll_at: cleared ? null : existing.next_poll_at,
    });
  }

  /* ---------- lifecycle ---------- */

  boot() {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.pump();
      void this.pollDue();
    }, this.tickMs);
    this.timer.unref?.();
    void this.pump();
    void this.pollDue();
  }

  close() {
    this.closed = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.abort.abort();
    } catch {
      /* already aborted */
    }
  }

  kick() {
    if (!this.started || this.closed) return;
    queueMicrotask(() => {
      void this.pump();
    });
  }

  notify(materialId, status = null) {
    if (!materialId) return;
    // The same blob can back several materials (duplicate upload or a restored
    // version). They share one remote task, so refresh every visible alias.
    const ids = new Set([materialId]);
    try {
      const latest = this.db.prepare(
        `select blob_sha256 from material_versions where material_id = ? order by v desc limit 1`,
      ).get(materialId);
      if (latest?.blob_sha256) {
        const aliases = this.db.prepare(
          `select distinct mv.material_id
             from material_versions mv
             join materials m on m.id = mv.material_id
            where mv.blob_sha256 = ? and m.workspace_id = ? and m.deleted_at is null`,
        ).all(latest.blob_sha256, this.workspaceId);
        for (const alias of aliases) ids.add(alias.material_id);
      }
    } catch {
      /* keep the primary id */
    }
    for (const id of ids) {
      try {
        this.onChange(id, status);
      } catch (error) {
        console.warn(`[asr] onChange failed: ${error.message}`);
      }
    }
  }

  /* ---------- material lookups ---------- */

  resolve(materialId, versionNumber = null) {
    const row = this.store.getVersionRow(materialId, versionNumber);
    if (!row) throw errorWith("material not found", 404, "material_not_found");
    const ext = extOf(row.material.path);
    return {
      material: row.material,
      version: row.version,
      sha: row.version.blob_sha256,
      ext,
      name: row.version.displayName || row.material.name,
    };
  }

  isAudio(nameOrPath) {
    return isAudioExt(extOf(nameOrPath));
  }

  isAsr(nameOrPath) {
    return isAsrExt(extOf(nameOrPath));
  }

  normalizedRow(row) {
    // If the key was added later, an old "unconfigured" row becomes actionable
    // without rewriting history.
    if (row?.status === "unconfigured" && this.configured) {
      return { ...row, status: "idle" };
    }
    return row;
  }

  summary(info) {
    const supported = isAsrExt(info.ext);
    const row = this.normalizedRow(this.getRecord(info.sha));
    const dto = asrDto(row, { configured: this.configured, supported });
    return {
      ...dto,
      materialId: info.material.id,
      version: info.version.v,
      sha256: info.sha,
      name: info.name,
      ext: info.ext,
    };
  }

  full(info) {
    const supported = isAsrExt(info.ext);
    const row = this.normalizedRow(this.getRecord(info.sha));
    const dto = asrDto(row, { configured: this.configured, supported, content: true });
    return {
      ...dto,
      materialId: info.material.id,
      version: info.version.v,
      sha256: info.sha,
      name: info.name,
      ext: info.ext,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  attach(material) {
    if (!material) return material;
    const source = material.relPath || material.path || material.name;
    if (!isAudioExt(extOf(source))) return material;
    const latest = this.store.latestVersion(material.id);
    if (!latest) return material;
    const info = {
      material: { id: material.id, name: material.name, path: material.relPath || material.path },
      version: latest,
      sha: latest.blob_sha256,
      ext: extOf(source),
      name: material.name,
    };
    return { ...material, asr: this.summary(info) };
  }

  get(materialId, versionNumber = null) {
    return this.full(this.resolve(materialId, versionNumber));
  }

  /* ---------- public commands ---------- */

  /** Called by the upload / restore pipeline. No-op unless it is audio. */
  async autoStart(materialId, { notify = false } = {}) {
    const info = this.resolve(materialId);
    if (!isAsrExt(info.ext)) return this.summary(info);

    const record = this.getRecord(info.sha);
    if (!this.configured) {
      if (!record) this.queueRecord(info, {
        status: "unconfigured",
        error: null,
      });
      if (notify) this.notify(materialId, "unconfigured");
      return this.summary(info);
    }
    if (!record || record.status === "unconfigured" || record.status === "idle") {
      return this.start(materialId, { notify });
    }
    return this.summary(info);
  }

  /** Start or retry transcription for one material version. */
  start(materialId, { versionNumber = null, force = false, notify = true } = {}) {
    if (!this.configured) {
      throw errorWith(
        "未配置 ASR_API_KEY。请把智凌 API 密钥写入 .env.local 后重启服务。",
        503,
        "asr_unconfigured",
      );
    }
    const info = this.resolve(materialId, versionNumber);
    if (!isAsrExt(info.ext)) {
      throw errorWith(
        `ASR 只支持 MP3 / WAV；当前文件是 .${info.ext || "?"}。`,
        422,
        "asr_unsupported",
      );
    }
    const record = this.getRecord(info.sha);
    if (!force && record?.status === "done") return this.full(info);
    if (!force && record && ["queued", "preparing", "uploading", "submitting", "waiting", "processing"].includes(record.status)) {
      return this.full(info);
    }

    // A paused task already has a remote taskId. Resume polling instead of
    // submitting (and billing) the same audio again.
    if (!force && record?.task_id && record.status === "paused") {
      this.update(info.sha, {
        status: "waiting",
        error: null,
        poll_errors: 0,
        next_poll_at: nowIso(),
      });
      if (notify) this.notify(materialId, "waiting");
      void this.pollDue();
      return this.full(info);
    }

    this.queueRecord(info, { status: "queued" });
    if (notify) this.notify(materialId, "queued");
    this.kick();
    return this.full(info);
  }

  /* ---------- upload queue ---------- */

  async pump() {
    if (!this.started || this.closed || this.pumping) return;
    this.pumping = true;
    try {
      while (this.inflight.size < this.concurrency) {
        const rows = this.db.prepare(
          `select * from asr_tasks
            where workspace_id = ? and status = 'queued'
            order by created_at asc limit 10`,
        ).all(this.workspaceId);
        const row = rows.find((item) => !this.inflight.has(item.blob_sha256));
        if (!row) break;
        const sha = row.blob_sha256;
        const task = this.run(row)
          .catch((error) => {
            console.warn(`[asr] task ${sha.slice(0, 10)} failed: ${error.message}`);
          })
          .finally(() => {
            this.inflight.delete(sha);
            this.kick();
          });
        this.inflight.set(sha, task);
      }
    } finally {
      this.pumping = false;
    }
  }

  async run(row) {
    if (!this.configured) {
      this.update(row.blob_sha256, { status: "unconfigured", error: null, next_poll_at: null });
      this.notify(row.material_id, "unconfigured");
      return;
    }
    const current = this.getRecord(row.blob_sha256);
    if (!current || current.status !== "queued") return;

    let info;
    try {
      info = this.resolve(current.material_id, current.version);
    } catch (error) {
      this.fail(current, `找不到对应文件：${error.message}`);
      return;
    }

    this.update(info.sha, { status: "preparing", detail: null, error: null });
    this.notify(info.material.id, "preparing");

    let buffer;
    try {
      buffer = await fs.readFile(this.store.blobPath(info.sha));
    } catch (error) {
      this.fail(current, `读取音频失败：${error.message}`);
      return;
    }

    let signature;
    try {
      signature = await this.requestSignature(info);
    } catch (error) {
      this.fail(current, error.message);
      return;
    }

    this.update(info.sha, { status: "uploading" });
    this.notify(info.material.id, "uploading");

    let audioUrl;
    try {
      audioUrl = await this.uploadAudio(info, signature, buffer);
    } catch (error) {
      this.fail(current, `上传音频失败：${error.message}`);
      return;
    }

    this.update(info.sha, { status: "submitting", audio_url: audioUrl });
    this.notify(info.material.id, "submitting");

    let submitted;
    try {
      submitted = await this.submitAudio(info, audioUrl);
    } catch (error) {
      this.fail(current, `提交转写任务失败：${error.message}`);
      return;
    }

    const at = nowIso();
    this.update(info.sha, {
      status: "waiting",
      task_id: submitted.taskId,
      audio_url: audioUrl,
      error: null,
      detail: null,
      poll_errors: 0,
      submitted_at: at,
      next_poll_at: futureIso(Math.min(this.pollIntervalMs, 5_000)),
    });
    this.notify(info.material.id, "waiting");
  }

  fail(row, message) {
    const now = nowIso();
    this.update(row.blob_sha256, {
      status: "failed",
      error: clip(message, 2_000),
      finished_at: now,
      next_poll_at: null,
    });
    this.notify(row.material_id, "failed");
  }

  /* ---------- remote API ---------- */

  async request(url, options = {}, timeoutMs = this.requestTimeoutMs) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.abort.signal) signals.push(this.abort.signal);
    const response = await this.fetchImpl(url, {
      ...options,
      signal: AbortSignal.any(signals),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { code: response.status, msg: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw errorWith(
        body?.msg || body?.error || `HTTP ${response.status}`,
        response.status >= 500 ? 502 : response.status,
        "asr_http_error",
      );
    }
    return body;
  }

  async requestSignature(info) {
    const fileName = `${info.sha.slice(0, 12)}.${info.ext}`;
    const contentType = CONTENT_TYPES[info.ext] || "application/octet-stream";
    const query = new URLSearchParams({
      key: this.apiKey,
      fileName,
      contentType,
      expiresIn: "900",
    });
    const body = await this.request(`${this.apiBase}/api/upload/signature?${query}`);
    if (Number(body?.code) !== 200 || !body?.data?.uploadUrl) {
      throw errorWith(body?.msg || "获取上传签名失败", 502, "asr_signature_failed");
    }
    return {
      ...body.data,
      fileName,
      contentType,
    };
  }

  async uploadAudio(info, signature, buffer) {
    const form = new FormData();
    for (const [key, value] of Object.entries(signature.formFields || {})) {
      form.append(key, String(value));
    }
    const blob = new Blob([buffer], { type: signature.contentType });
    form.append("file", blob, signature.fileName);

    let response;
    try {
      response = await this.fetchImpl(signature.uploadUrl, {
        method: signature.method || "POST",
        body: form,
        signal: AbortSignal.any([
          AbortSignal.timeout(this.uploadTimeoutMs),
          this.abort.signal,
        ]),
      });
    } catch (error) {
      throw new Error(`网络错误：${error.message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`对象存储返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`);
    }
    if (!signature.fileUrl) {
      throw new Error("上传签名没有返回 fileUrl");
    }
    return signature.fileUrl;
  }

  async submitAudio(info, audioUrl) {
    const endpoint = `${this.apiBase}/api/asr/parse-audio-url-time`;
    const form = new URLSearchParams({
      key: this.apiKey,
      audioUrl,
      needSrt: "true",
    });
    const first = await this.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form.toString(),
    });
    if (Number(first?.code) === 200) {
      const taskId = typeof first.data === "string" ? first.data : first.data?.taskId || first.data?.id;
      if (taskId) return { taskId, payload: first };
      throw errorWith("提交成功但没有返回 taskId", 502, "asr_no_task_id");
    }

    // Some deployments only accept JSON for this endpoint. Retry once with the
    // documented URL-encoded audioUrl form.
    try {
      const alt = await this.request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          key: this.apiKey,
          audioUrl: encodeURIComponent(audioUrl),
          needSrt: true,
        }),
      });
      if (Number(alt?.code) === 200) {
        const taskId = typeof alt.data === "string" ? alt.data : alt.data?.taskId || alt.data?.id;
        if (taskId) return { taskId, payload: alt };
      }
      throw errorWith(alt?.msg || "提交转写任务失败", 502, "asr_submit_failed");
    } catch (error) {
      throw errorWith(
        `${first?.msg || "提交转写任务失败"}（JSON 重试：${error.message}）`,
        502,
        "asr_submit_failed",
      );
    }
  }

  async pollStatus(taskId) {
    const query = new URLSearchParams({ key: this.apiKey, taskId });
    const body = await this.request(`${this.apiBase}/api/asr/task-status?${query}`);
    if (Number(body?.code) !== 200) {
      throw errorWith(body?.msg || "查询转写任务失败", 502, "asr_poll_failed");
    }
    return body.data || {};
  }

  /* ---------- polling ---------- */

  async pollDue() {
    if (!this.started || this.closed || this.polling) return;
    this.polling = true;
    try {
      const now = nowIso();
      const rows = this.db.prepare(
        `select * from asr_tasks
          where workspace_id = ? and status in ('waiting','processing')
            and (next_poll_at is null or next_poll_at <= ?)
          order by next_poll_at asc limit 4`,
      ).all(this.workspaceId, now);
      await Promise.all(rows.map((row) => this.pollTask(row)));
    } finally {
      this.polling = false;
    }
  }

  async pollTask(row) {
    const current = this.getRecord(row.blob_sha256);
    if (
      !current
      || !["waiting", "processing"].includes(current.status)
      || current.task_id !== row.task_id
    ) {
      return;
    }
    if (!this.configured) {
      this.update(row.blob_sha256, {
        status: "paused",
        error: "未配置 ASR_API_KEY，轮询已暂停",
        next_poll_at: null,
      });
      this.notify(row.material_id, "paused");
      return;
    }
    if (row.created_at && Date.now() - Date.parse(row.created_at) > this.maxWaitMs) {
      this.fail(row, "转写超时，请重试。");
      return;
    }

    let data;
    try {
      data = await this.pollStatus(row.task_id);
    } catch (error) {
      this.handlePollError(row, error);
      return;
    }

    const latest = this.getRecord(row.blob_sha256);
    if (
      !latest
      || latest.task_id !== row.task_id
      || !["waiting", "processing"].includes(latest.status)
    ) {
      return;
    }

    const schedule = scheduleOf(data);
    const at = nowIso();
    if (schedule === "SUCCESS") {
      const content = clip(data.content || data.text || "");
      const srt = clip(data.srtContent || data.srt || "");
      this.update(row.blob_sha256, {
        status: "done",
        content,
        srt_content: srt,
        detail: data.scheduleDesc || "处理成功",
        error: null,
        poll_errors: 0,
        finished_at: at,
        next_poll_at: null,
      });
      this.notify(row.material_id, "done");
      return;
    }
    if (schedule === "FAIL") {
      this.fail(row, data.scheduleDesc || data.content || "转写服务返回失败");
      return;
    }

    const nextStatus = schedule === "ING" ? "processing" : "waiting";
    this.update(row.blob_sha256, {
      status: nextStatus,
      detail: data.scheduleDesc || null,
      error: null,
      poll_errors: 0,
      next_poll_at: futureIso(this.pollIntervalMs),
    });
    if (row.status !== nextStatus) this.notify(row.material_id, nextStatus);
  }

  handlePollError(row, error) {
    const current = this.getRecord(row.blob_sha256);
    if (
      !current
      || current.task_id !== row.task_id
      || !["waiting", "processing"].includes(current.status)
    ) {
      return;
    }
    const errors = Number(current.poll_errors || 0) + 1;
    if (errors >= this.maxPollErrors) {
      this.fail(row, `查询转写结果连续失败 ${errors} 次：${error.message}`);
      return;
    }
    const backoff = Math.min(60_000, Math.max(this.pollIntervalMs, errors * 8_000));
    this.update(row.blob_sha256, {
      poll_errors: errors,
      error: clip(error.message, 1_000),
      next_poll_at: futureIso(backoff),
    });
    if (errors === 1) this.notify(row.material_id, row.status);
  }

  /* ---------- content helpers ---------- */

  contentText(materialId, versionNumber = null, format = "txt") {
    const info = this.resolve(materialId, versionNumber);
    const dto = this.full(info);
    if (dto.status !== "done") {
      throw errorWith("转写还没有完成。", 409, "asr_not_done");
    }
    if (format === "srt") {
      if (!dto.srt) throw errorWith("这次转写没有生成 SRT。", 404, "asr_no_srt");
      return { text: dto.srt, ext: "srt", name: dto.name, dto };
    }
    return { text: dto.content, ext: "txt", name: dto.name, dto };
  }

  /** Stats used by /api/health; never leaks the API key. */
  stats() {
    const rows = this.db.prepare(
      `select status, count(*) as n from asr_tasks where workspace_id = ? group by status`,
    ).all(this.workspaceId);
    return {
      configured: this.configured,
      apiBase: this.apiBase,
      counts: Object.fromEntries(rows.map((row) => [row.status, row.n])),
    };
  }
}

export default AsrService;
