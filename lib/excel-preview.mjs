/**
 * sha256-keyed Excel preview cache.
 *
 * `services/workbook/export_preview.py` loads the workbook with openpyxl and
 * writes a gzipped JSON document containing every sheet's display values,
 * formulas, styles and layout. This module serialises those exports (a large
 * model peaks around a few hundred MB RSS) and keeps the parsed document in an
 * LRU so scrolling/chunk requests never touch Python again.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const gunzip = promisify(zlib.gunzip);

export const PREVIEW_PARSER_VERSION = 2;
const SCHEMA_VERSION = 1;
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "workbook",
  "export_preview.py",
);
const EXCEL_EXTS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);
const MAX_STDERR = 16 * 1024;

function extOf(name) {
  return (String(name || "").split(".").pop() || "").toLowerCase();
}

function previewError(message, status = 500, code = "preview_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
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

export class ExcelPreviewStore {
  constructor({
    store,
    pythonBin = process.env.PYTHON_BIN || "python3",
    cacheDir,
    timeoutMs = 120_000,
    maxLoaded = 2,
  }) {
    this.store = store;
    this.cacheDir = cacheDir || path.join(store.dataDir, "doc-cache");
    this.pythonBin = pythonBin;
    this.timeoutMs = timeoutMs;
    this.maxLoaded = maxLoaded;
    this.cache = new Map();
    this.inflight = new Map();
    this.children = new Set();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /* ---------- cache ---------- */

  cachePath(sha) {
    return path.join(
      this.cacheDir,
      `${sha}.preview.v${PREVIEW_PARSER_VERSION}.json.gz`,
    );
  }

  touch(sha, doc) {
    this.cache.delete(sha);
    this.cache.set(sha, doc);
    while (this.cache.size > this.maxLoaded) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  async loadCached(sha) {
    const file = this.cachePath(sha);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = await gunzip(await fsp.readFile(file));
      const doc = JSON.parse(raw.toString("utf8"));
      if (
        !doc ||
        doc.schemaVersion !== SCHEMA_VERSION ||
        doc.parserVersion !== PREVIEW_PARSER_VERSION ||
        !Array.isArray(doc.sheets)
      ) {
        return null;
      }
      this.touch(sha, doc);
      return doc;
    } catch {
      await fsp.rm(file, { force: true }).catch(() => {});
      return null;
    }
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /* ---------- material resolution ---------- */

  resolve(materialId, version) {
    const row = this.store.getVersionRow(materialId, version);
    if (!row) throw previewError("material version not found", 404, "version_not_found");
    const ext = extOf(row.material.path);
    if (!EXCEL_EXTS.has(ext)) {
      const hint =
        ext === "xls"
          ? "旧版 .xls 暂不支持预览，请在 Excel 中另存为 .xlsx 后重新上传。"
          : `暂不支持 .${ext || "?"} 文件的表格预览；目前支持 ${[...EXCEL_EXTS].join(" / ")}。`;
      throw previewError(hint, 422, "unsupported_type");
    }
    return {
      material: row.material,
      version: row.version,
      sha: row.version.blob_sha256,
      ext,
      fileName: row.version.displayName,
    };
  }

  async getDoc(sha, meta = {}) {
    const cached = this.cache.get(sha);
    if (cached) {
      this.touch(sha, cached);
      return cached;
    }

    const onDisk = await this.loadCached(sha);
    if (onDisk) return onDisk;

    const running = this.inflight.get(sha);
    if (running) return running;

    const task = this.enqueue(() => this.parse(sha, meta));
    this.inflight.set(sha, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(sha);
    }
  }

  async parse(sha, { fileName, ext }) {
    const blob = this.store.blobPath(sha);
    if (!fs.existsSync(blob)) {
      throw previewError("文件内容不存在（blob 缺失），请重新上传。", 404, "blob_missing");
    }

    const actualExt = ext || extOf(fileName);
    if (!EXCEL_EXTS.has(actualExt)) {
      throw previewError(`暂不支持 .${actualExt || "?"} 文件。`, 422, "unsupported_type");
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-preview-"));
    const input = path.join(dir, `model.${actualExt}`);
    const output = path.join(dir, "preview.json.gz");
    try {
      await fsp.copyFile(blob, input);
      await this.runParser(input, output);

      let doc;
      try {
        const raw = await gunzip(await fsp.readFile(output));
        doc = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        throw previewError(`预览数据无法读取：${error.message}`, 500, "preview_output_invalid");
      }
      if (
        !doc ||
        doc.schemaVersion !== SCHEMA_VERSION ||
        doc.parserVersion !== PREVIEW_PARSER_VERSION ||
        !Array.isArray(doc.sheets)
      ) {
        throw previewError("预览数据格式不兼容，请升级解析器或重新上传。", 500, "preview_output_invalid");
      }

      const target = this.cachePath(sha);
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fsp.copyFile(output, tmp);
      await fsp.rename(tmp, target);

      this.touch(sha, doc);
      return doc;
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
      this.children.add(child);

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
        this.children.delete(child);
        if (error.code === "ENOENT") {
          reject(
            previewError(
              `未找到 ${this.pythonBin}，请安装 Python 3 与 openpyxl，或设置 PYTHON_BIN。`,
              503,
              "python_not_found",
            ),
          );
          return;
        }
        reject(previewError(`无法启动预览解析器：${error.message}`, 500, "parser_spawn_failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (timedOut) {
          reject(
            previewError(
              `工作簿预览解析超时（${Math.round(this.timeoutMs / 1000)}s）。模型过大或 Python 卡住。`,
              504,
              "preview_timeout",
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
          reject(previewError("缺少 openpyxl：pip install openpyxl 后重试。", 503, "openpyxl_missing"));
          return;
        }
        if (/File is not a zip file|BadZipFile|InvalidFileException/i.test(detail)) {
          reject(previewError("文件不是有效的 xlsx/xlsm，可能已加密或损坏。", 422, "invalid_workbook"));
          return;
        }
        reject(previewError(`工作簿预览解析失败：${detail.slice(-900)}`, 500, "preview_failed"));
      });
    });
  }

  /* ---------- public API ---------- */

  async manifest(materialId, version) {
    const info = this.resolve(materialId, version);
    const started = Date.now();
    const doc = await this.getDoc(info.sha, { fileName: info.fileName, ext: info.ext });
    const active = doc.sheets.find(
      (sheet) => sheet.name === doc.props?.activeSheet && sheet.state !== "veryHidden",
    );
    const fallback = doc.sheets.find((sheet) => sheet.state === "visible") || doc.sheets[0];

    return {
      type: "excel",
      schemaVersion: doc.schemaVersion,
      parserVersion: doc.parserVersion,
      fileName: info.fileName,
      props: doc.props,
      styles: doc.styles,
      stats: {
        ...doc.stats,
        cacheBytes: fs.existsSync(this.cachePath(info.sha))
          ? fs.statSync(this.cachePath(info.sha)).size
          : null,
        elapsedMs: Date.now() - started,
      },
      warnings: doc.warnings || [],
      activeSheet: (active || fallback)?.name || null,
      sheets: doc.sheets.map(({ cells, merges, cols, rows, ...summary }) => ({
        ...summary,
        cellCount: cells.length,
        mergeCount: merges.length,
        colStyleCount: Object.keys(cols).length,
        rowStyleCount: Object.keys(rows).length,
      })),
    };
  }

  async sheet(materialId, version, sheetName) {
    const info = this.resolve(materialId, version);
    const doc = await this.getDoc(info.sha, { fileName: info.fileName, ext: info.ext });
    const name = String(sheetName || "");
    const sheet = doc.sheets.find((item) => item.name === name);
    if (!sheet) throw previewError("工作表不存在", 404, "sheet_not_found");
    return {
      ...sheet,
      type: "sheet",
      cellCount: sheet.cells.length,
    };
  }

  close() {
    for (const child of this.children) killTree(child);
    this.children.clear();
  }
}
