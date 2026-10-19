/**
 * End-to-end ASR test against a local fake 17zhiling server.
 *
 * It exercises the real upload/signature/submit/poll flow, SQLite persistence,
 * status transitions, transcript content and the unsupported/unconfigured
 * branches. No network access and no API key are required.
 *
 *   npm run test:asr
 */

import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { openStore } from "../store.mjs";
import { AsrService } from "../lib/asr.mjs";

const calls = {
  signature: 0,
  uploads: 0,
  submits: [],
  polls: 0,
  uploadBytes: 0,
};
const tasks = new Map();

const CONTENT = "这是识别结果。\n第二段：ASR 端到端测试。";
const SRT = "1\n00:00:00,000 --> 00:00:04,000\n这是识别结果。\n";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname === "/api/upload/signature" && req.method === "GET") {
      calls.signature += 1;
      assert.equal(url.searchParams.get("key"), "test-key");
      assert.match(url.searchParams.get("fileName") || "", /\.mp3$/);
      return json(res, 200, {
        code: 200,
        msg: "success",
        data: {
          uploadUrl: `${base}/upload`,
          method: "POST",
          formFields: {
            key: "remote/key.mp3",
            "Content-Type": "audio/mpeg",
            "x-amz-algorithm": "AWS4-HMAC-SHA256",
            "x-amz-signature": "fake",
          },
          objectKey: `remote/${url.searchParams.get("fileName")}`,
          fileUrl: `${base}/temp/${url.searchParams.get("fileName")}`,
          bucketName: "temp",
          expiresIn: 900,
        },
      });
    }

    if (url.pathname === "/upload" && req.method === "POST") {
      const body = await readBody(req);
      calls.uploads += 1;
      calls.uploadBytes = body.length;
      assert.match(req.headers["content-type"] || "", /multipart\/form-data/);
      assert.match(body.toString("latin1"), /name="file"/);
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === "/api/asr/parse-audio-url-time" && req.method === "POST") {
      const body = (await readBody(req)).toString("utf8");
      const type = req.headers["content-type"] || "";
      let params;
      if (type.includes("application/json")) params = JSON.parse(body);
      else params = Object.fromEntries(new URLSearchParams(body));
      calls.submits.push({ type, params });
      assert.equal(params.key, "test-key");
      assert.ok(params.audioUrl, "audioUrl is required");
      const taskId = `task-${calls.submits.length}`;
      tasks.set(taskId, { polls: 0, audioUrl: params.audioUrl, seq: calls.submits.length });
      return json(res, 200, { code: 200, msg: "success", data: taskId });
    }

    if (url.pathname === "/api/asr/task-status" && req.method === "GET") {
      calls.polls += 1;
      const taskId = url.searchParams.get("taskId");
      const task = tasks.get(taskId);
      assert.ok(task, `unknown taskId ${taskId}`);
      task.polls += 1;
      const willFail = task.seq === 2;
      const schedule = willFail
        ? "FAIL"
        : task.polls <= 1 ? "WAIT_HANDLE" : task.polls === 2 ? "ING" : "SUCCESS";
      return json(res, 200, {
        code: 200,
        msg: "success",
        data: {
          schedule,
          scheduleDesc: schedule === "SUCCESS" ? "处理成功" : schedule === "FAIL" ? "转写失败：音频无法识别" : "处理中",
          id: taskId,
          content: schedule === "SUCCESS" ? CONTENT : "",
          srtContent: schedule === "SUCCESS" ? SRT : "",
        },
      });
    }

    return json(res, 404, { code: 404, msg: `not found: ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitFor(fn, { timeoutMs = 6_000, intervalMs = 40 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const server = await startMock();
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-asr-"));
  const workspace = path.join(tmp, "project");
  await fsp.mkdir(path.join(workspace, "uploads"), { recursive: true });
  const store = await openStore({
    root: tmp,
    workspace,
    projectId: "asr-test",
    projectName: "ASR Test",
    seed: false,
  });

  const changes = [];
  const service = new AsrService({
    store,
    apiKey: "test-key",
    apiBase: base,
    pollIntervalMs: 30,
    tickMs: 20,
    onChange: (materialId, status) => changes.push(status),
  });

  try {
    const audioPath = path.join(workspace, "uploads", "1700000000000-meeting.mp3");
    const audio = Buffer.from("fake-mp3-bytes-for-asr-test");
    await fsp.writeFile(audioPath, audio);
    let material = store.indexFile("uploads/1700000000000-meeting.mp3", {
      kind: "input",
      source: "upload",
      status: "synced",
    });
    const audioMaterialId = material.id;

    const initial = service.attach(material);
    assert.equal(initial.asr.status, "idle");
    assert.equal(initial.asr.canStart, true);

    const queued = await service.autoStart(material.id);
    assert.ok(["queued", "preparing", "uploading", "submitting", "waiting"].includes(queued.status));

    const done = await waitFor(() => {
      const current = service.get(material.id);
      return current.status === "done" ? current : null;
    });
    assert.equal(done.content, CONTENT);
    assert.equal(done.srt, SRT);
    assert.equal(done.chars, [...CONTENT].length);
    assert.equal(done.hasSrt, true);
    assert.equal(done.progress, 100);
    assert.match(done.taskId, /^task-/);

    assert.ok(calls.signature >= 1, "signature requested");
    assert.equal(calls.uploads, 1, "audio uploaded once");
    assert.ok(calls.uploadBytes > 100, "multipart body contains the file");
    assert.equal(calls.submits.length, 1, "submitted once");
    assert.equal(calls.submits[0].type, "application/x-www-form-urlencoded; charset=utf-8");
    assert.ok(calls.submits[0].params.audioUrl.includes("/temp/"));
    assert.equal(calls.submits[0].params.needSrt, "true");
    assert.ok(calls.polls >= 3, "polled until completion");

    for (const status of ["preparing", "uploading", "submitting", "waiting", "done"]) {
      assert.ok(changes.includes(status), `change broadcast includes ${status}`);
    }

    // The lightweight DTO used by lists/SSE must not carry the transcript.
    const attached = service.attach(store.getMaterial(material.id));
    assert.equal(attached.asr.status, "done");
    assert.equal(attached.asr.hasContent, true);
    assert.equal("content" in attached.asr, false);

    // Transcript downloads.
    const txt = service.contentText(material.id, null, "txt");
    assert.equal(txt.text, CONTENT);
    const srt = service.contentText(material.id, null, "srt");
    assert.equal(srt.text, SRT);
    assert.equal(srt.ext, "srt");

    // Remote failure is a terminal, retryable state.
    const failPath = path.join(workspace, "uploads", "1700000000003-fail.mp3");
    await fsp.writeFile(failPath, Buffer.from("fake-fail-mp3"));
    const failMaterial = store.indexFile("uploads/1700000000003-fail.mp3", {
      kind: "input",
      source: "upload",
      status: "synced",
    });
    service.start(failMaterial.id);
    const failed = await waitFor(() => {
      const current = service.get(failMaterial.id);
      return current.status === "failed" ? current : null;
    });
    assert.match(failed.error, /音频无法识别/);
    assert.equal(failed.canRetry, true);
    assert.equal(failed.progress, 100);

    // Unsupported audio format: still playable, never submitted.
    const m4aPath = path.join(workspace, "uploads", "1700000000001-call.m4a");
    await fsp.writeFile(m4aPath, Buffer.from("fake-m4a"));
    material = store.indexFile("uploads/1700000000001-call.m4a", {
      kind: "input",
      source: "upload",
      status: "synced",
    });
    const unsupported = service.attach(material);
    assert.equal(unsupported.asr.status, "unsupported");
    assert.equal(unsupported.asr.supported, false);
    assert.equal(unsupported.asr.canStart, false);
    assert.throws(() => service.start(material.id), /只支持 MP3/);

    // Missing key: uploaded audio is persisted as unconfigured, with no call.
    const offline = new AsrService({
      store,
      apiKey: "",
      apiBase: base,
      pollIntervalMs: 30,
      tickMs: 20,
    });
    try {
      const wavPath = path.join(workspace, "uploads", "1700000000002-voice.wav");
      await fsp.writeFile(wavPath, Buffer.from("fake-wav"));
      const wav = store.indexFile("uploads/1700000000002-voice.wav", {
        kind: "input",
        source: "upload",
        status: "synced",
      });
      const offlineDone = await offline.autoStart(wav.id);
      assert.equal(offlineDone.status, "unconfigured");
      assert.equal(offlineDone.configured, false);
      assert.throws(() => offline.start(wav.id), /ASR_API_KEY/);
    } finally {
      offline.close();
    }

    // Restart resume: a waiting task should keep its taskId and finish without
    // re-uploading or re-submitting the audio.
    service.close();
    const now = new Date().toISOString();
    store.db.prepare(
      `update asr_tasks
          set status = 'waiting', content = null, srt_content = null,
              finished_at = null, next_poll_at = ?, updated_at = ?
        where workspace_id = ? and blob_sha256 = ?`,
    ).run(now, now, store.projectId, done.sha256);
    const resumed = new AsrService({
      store,
      apiKey: "test-key",
      apiBase: base,
      pollIntervalMs: 30,
      tickMs: 20,
    });
    try {
      const again = await waitFor(() => {
        const current = resumed.get(audioMaterialId);
        return current.status === "done" && current.content ? current : null;
      });
      assert.equal(again.content, CONTENT);
      assert.equal(again.taskId, done.taskId);
      assert.equal(calls.submits.length, 2, "restart did not submit again");
    } finally {
      resumed.close();
    }

    console.log("test:asr ok");
    console.log(`  signature=${calls.signature} uploads=${calls.uploads} submits=${calls.submits.length} polls=${calls.polls}`);
    console.log(`  states=${[...new Set(changes)].join(" -> ")}`);
    console.log(`  transcript=${done.chars} chars, srt=${done.srt ? "yes" : "no"}`);
  } finally {
    service.close();
    store.db.close();
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("test:asr failed");
  console.error(error);
  process.exitCode = 1;
});
