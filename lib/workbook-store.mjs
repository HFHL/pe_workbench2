/**
 * sha256-keyed workbook parse cache + graph store.
 *
 * Design notes:
 * - The cache key is the blob sha256, so versions, restored files and repeated
 *   uploads share one parse.
 * - Parsed graphs are gzipped JSON in data/doc-cache; SQLite only stores the
 *   small status/metadata row.
 * - Parsing runs in a Python subprocess through a serial queue: a 4.9 MB model
 *   can peak around 476 MB RSS, so two at once is not acceptable on a laptop.
 * - The same sha is deduplicated through an in-flight map.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { queryGraph, formatResult, indexGraph, summarizeGraph } from "./workbook-query.mjs";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const PARSER_VERSION = 1;
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "workbook",
  "parse_workbook.py",
);
const EXCEL_EXTS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);
const MAX_STDERR = 16 * 1024;

function parseError(message, status = 500, code = "parse_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function extOf(name) {
  return (String(name || "").split(".").pop() || "").toLowerCase();
}

function killTree(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2000);
  timer.unref?.();
}

export class WorkbookStore {
  constructor({
    store,
    pythonBin = process.env.PYTHON_BIN || "python3",
    cacheDir,
    timeoutMs = 120_000,
    maxLoaded = 2,
  }) {
    this.store = store;
    this.db = store.db;
    this.cacheDir = cacheDir || path.join(store.dataDir, "doc-cache");
    this.pythonBin = pythonBin;
    this.timeoutMs = timeoutMs;
    this.maxLoaded = maxLoaded;
    this.cache = new Map();
    this.inflight = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.ensureSchema();
  }

  /* ---------- schema ---------- */

  ensureSchema() {
    this.db.exec(`
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
    `);
  }

  getRecord(sha) {
    return this.db.prepare(`select * from document_parses where blob_sha256 = ?`).get(sha) || null;
  }

  putRecord({ sha, fileName, fileType, status, stats, error, parsedAt }) {
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into document_parses
         (blob_sha256, file_name, file_type, parser_version, status, stats_json, error, parsed_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(blob_sha256) do update set
         file_name = excluded.file_name,
         file_type = excluded.file_type,
         parser_version = excluded.parser_version,
         status = excluded.status,
         stats_json = excluded.stats_json,
         error = excluded.error,
         parsed_at = excluded.parsed_at,
         updated_at = excluded.updated_at`,
    ).run(
      sha,
      fileName,
      fileType,
      PARSER_VERSION,
      status,
      stats ? JSON.stringify(stats) : null,
      error || null,
      parsedAt || null,
      now,
    );
  }

  /* ---------- material resolution ---------- */

  isSupportedName(name) {
    return EXCEL_EXTS.has(extOf(name));
  }

  resolveMaterial(materialId) {
    const material = this.store.getMaterial(materialId);
    if (!material) throw parseError("material not found", 404, "material_not_found");
    const version = this.store.latestVersion(materialId);
    if (!version) throw parseError("material has no versions", 404, "version_not_found");
    const ext = extOf(material.relPath);
    if (!EXCEL_EXTS.has(ext)) {
      const hint =
        ext === "xls"
          ? "旧版 .xls 暂不支持，请在 Excel 中另存为 .xlsx 后重新上传。"
          : `暂不支持 .${ext || "?"} 文件；目前支持 ${[...EXCEL_EXTS].join(" / ")}。`;
      throw parseError(hint, 422, "unsupported_type");
    }
    return {
      material,
      version,
      sha: version.blob_sha256,
      ext,
      fileName: material.name,
      fileType: "excel",
    };
  }

  /* ---------- graph access ---------- */

  cachePath(sha) {
    return path.join(this.cacheDir, `${sha}.json.gz`);
  }

  async loadCached(sha) {
    const file = this.cachePath(sha);
    if (!fs.existsSync(file)) return null;
    try {
      const doc = JSON.parse((await gunzip(await fsp.readFile(file))).toString("utf8"));
      if (!doc || doc.schemaVersion !== 1) return null;
      const graph = indexGraph(doc);
      this.touch(sha, graph);
      return graph;
    } catch {
      return null;
    }
  }

  touch(sha, graph) {
    this.cache.delete(sha);
    this.cache.set(sha, graph);
    while (this.cache.size > this.maxLoaded) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  async writeCache(sha, doc) {
    const payload = await gzip(Buffer.from(JSON.stringify(doc)), { level: 6 });
    const file = this.cachePath(sha);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
    return payload.length;
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async getGraph(sha, meta = {}) {
    const cached = this.cache.get(sha);
    if (cached) {
      this.touch(sha, cached);
      return cached;
    }

    const record = this.getRecord(sha);
    const fileName = meta.fileName || record?.file_name || "workbook.xlsx";
    const fileType = meta.fileType || record?.file_type || "excel";

    if (
      record?.status === "ready" &&
      record.parser_version === PARSER_VERSION &&
      fs.existsSync(this.cachePath(sha))
    ) {
      const graph = await this.loadCached(sha);
      if (graph) return graph;
    }

    if (record?.status === "failed" && record.parser_version === PARSER_VERSION && !meta.force) {
      throw parseError(
        record.error || "该文件上次解析失败，可重新上传或稍后重试。",
        422,
        "parse_failed",
      );
    }

    const running = this.inflight.get(sha);
    if (running) return running;

    const task = this.enqueue(() => this.parse(sha, { fileName, fileType, ...meta }));
    this.inflight.set(sha, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(sha);
    }
  }

  async parse(sha, { fileName, fileType, ext }) {
    const started = Date.now();
    const actualExt = ext || extOf(fileName);
    if (!EXCEL_EXTS.has(actualExt)) {
      throw parseError(`暂不支持 .${actualExt || "?"} 文件。`, 422, "unsupported_type");
    }

    this.putRecord({ sha, fileName, fileType, status: "running" });
    const blob = this.store.blobPath(sha);
    if (!fs.existsSync(blob)) {
      const message = "文件内容不存在（blob 缺失），请重新上传。";
      this.putRecord({ sha, fileName, fileType, status: "failed", error: message });
      throw parseError(message, 404, "blob_missing");
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-parse-"));
    const input = path.join(dir, `model.${actualExt}`);
    const output = path.join(dir, "graph.json");
    try {
      await fsp.copyFile(blob, input);
      await this.runParser(input, output);

      let doc;
      try {
        doc = JSON.parse(await fsp.readFile(output, "utf8"));
      } catch (error) {
        throw parseError(`解析结果无法读取：${error.message}`, 500, "parse_output_invalid");
      }
      if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.cells)) {
        throw parseError("解析结果格式不兼容，请升级解析器或重新上传。", 500, "parse_output_invalid");
      }
      if (doc.parserVersion && doc.parserVersion !== PARSER_VERSION) {
        throw parseError(
          `解析器版本不匹配（结果 ${doc.parserVersion}，期望 ${PARSER_VERSION}），请升级解析器。`,
          500,
          "parser_version_mismatch",
        );
      }

      const cacheBytes = await this.writeCache(sha, doc);
      const stats = {
        ...(doc.stats || {}),
        cacheBytes,
        elapsedMs: Date.now() - started,
      };
      this.putRecord({
        sha,
        fileName,
        fileType,
        status: "ready",
        stats,
        parsedAt: doc.parsedAt || new Date().toISOString(),
      });

      const graph = indexGraph(doc);
      this.touch(sha, graph);
      return graph;
    } catch (error) {
      const message = error?.message || String(error);
      this.putRecord({
        sha,
        fileName,
        fileType,
        status: "failed",
        error: message.slice(0, 2000),
      });
      throw error.status ? error : parseError(message, 500, "parse_failed");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  runParser(input, output) {
    return new Promise((resolve, reject) => {
      let stderr = "";
      let stdout = "";
      let timedOut = false;
      const child = spawn(this.pythonBin, [SCRIPT, input, "--out", output], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk) => {
        if (stdout.length < 4096) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (error.code === "ENOENT") {
          reject(
            parseError(
              `未找到 ${this.pythonBin}，请安装 Python 3 与 openpyxl，或设置 PYTHON_BIN。`,
              503,
              "python_not_found",
            ),
          );
          return;
        }
        reject(parseError(`无法启动解析器：${error.message}`, 500, "parser_spawn_failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            parseError(
              `解析超时（${Math.round(this.timeoutMs / 1000)}s）。模型过大或 Python 卡住。`,
              504,
              "parse_timeout",
            ),
          );
          return;
        }
        if (code === 0 && fs.existsSync(output)) {
          resolve();
          return;
        }

        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        if (/No module named ['"]?openpyxl/i.test(detail)) {
          reject(parseError("缺少 openpyxl：pip install openpyxl 后重试。", 503, "openpyxl_missing"));
          return;
        }
        if (/File is not a zip file|BadZipFile|InvalidFileException/i.test(detail)) {
          reject(
            parseError("文件不是有效的 xlsx/xlsm，可能已加密或损坏。", 422, "invalid_workbook"),
          );
          return;
        }
        if (/unsupported workbook format/i.test(detail)) {
          reject(parseError(detail.split("\n")[0], 422, "unsupported_type"));
          return;
        }
        reject(parseError(`解析失败：${detail.slice(-900)}`, 500, "parse_failed"));
      });
    });
  }

  /* ---------- public operations ---------- */

  async warm(materialId) {
    const info = this.resolveMaterial(materialId);
    const graph = await this.getGraph(info.sha, {
      fileName: info.fileName,
      fileType: "excel",
      ext: info.ext,
    });
    return {
      materialId,
      sha256: info.sha,
      status: "ready",
      stats: graph.doc.stats,
    };
  }

  async queryMaterial(materialId, query, options = {}) {
    const text = String(query || "").trim();
    if (!text) throw parseError("query is required", 400, "query_required");
    if (text.length > 500) throw parseError("query is too long", 400, "query_too_long");

    const info = this.resolveMaterial(materialId);
    const graph = await this.getGraph(info.sha, {
      fileName: info.fileName,
      fileType: "excel",
      ext: info.ext,
    });
    const result = queryGraph(graph, text, {
      maxCells: options.maxCells,
      maxChars: options.maxChars,
    });
    return {
      materialId,
      name: info.material.name,
      path: info.material.relPath,
      sha256: info.sha,
      status: "ready",
      ...result,
      text: formatResult(result, {
        maxCells: options.maxCells,
        maxChars: options.maxChars,
      }),
    };
  }

  async summary(materialId) {
    const info = this.resolveMaterial(materialId);
    const graph = await this.getGraph(info.sha, {
      fileName: info.fileName,
      fileType: "excel",
      ext: info.ext,
    });
    const record = this.getRecord(info.sha);
    return {
      materialId,
      name: info.material.name,
      path: info.material.relPath,
      sha256: info.sha,
      status: record?.status || "ready",
      parserVersion: record?.parser_version || PARSER_VERSION,
      parsedAt: record?.parsed_at || null,
      ...summarizeGraph(graph),
    };
  }

  async invalidate(sha) {
    this.cache.delete(sha);
    await fsp.rm(this.cachePath(sha), { force: true }).catch(() => {});
    this.db.prepare(`delete from document_parses where blob_sha256 = ?`).run(sha);
  }
}

export default WorkbookStore;
