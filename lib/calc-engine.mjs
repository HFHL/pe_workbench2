/**
 * Excel calculation adapter.
 *
 * We deliberately keep this behind a small boundary: reading/writing cells is
 * openpyxl (Python), recalculation is LibreOffice headless. The model writer
 * must never claim an xlsx was updated unless both steps + output verification
 * succeeded.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const VALUES_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../services/workbook/workbook_values.py",
);

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function sofficeCandidates() {
  return [
    process.env.SOFFICE_BIN,
    path.join(os.homedir(), "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
  ].filter(Boolean).map(expandHome);
}

export function findSoffice() {
  return sofficeCandidates().find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

export async function sofficeInfo() {
  const bin = findSoffice();
  if (!bin) return { available: false, bin: null, version: null };
  try {
    const { stdout } = await execFileAsync(bin, ["--headless", "--version"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { available: true, bin, version: String(stdout || "").trim().split("\n")[0] || "" };
  } catch (error) {
    return { available: false, bin, version: null, error: error.message };
  }
}

async function runPython(args, { timeout = 60_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [VALUES_SCRIPT, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.error || "workbook python helper failed");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`未找到 Python（${PYTHON_BIN}），无法读写 Excel 单元格`);
    }
    throw error;
  }
}

export async function readCells(file, refs, { formulas = false } = {}) {
  if (!Array.isArray(refs) || !refs.length) return {};
  const result = await runPython(["read", ...(formulas ? ["--formulas"] : []), file, ...refs]);
  return result.values || {};
}

export async function writeCells(file, out, assignments) {
  if (!Array.isArray(assignments) || !assignments.length) {
    throw new Error("writeCells 需要至少一个 Sheet!A1=value");
  }
  const result = await runPython(["write", file, out, ...assignments]);
  return result.path;
}

/**
 * Recalculate a workbook by loading it in LibreOffice headless and exporting a
 * new xlsx. LibreOffice recalculates formulas on load (verified against a real
 * model: changing Beta 1.49 -> 2.0 moved the target price 129 -> 118).
 */
export async function recalculateXlsx(file, { outDir, timeoutMs = 180_000 } = {}) {
  const bin = findSoffice();
  if (!bin) throw new Error("未找到 LibreOffice（可用 SOFFICE_BIN 指定 soffice 路径）");
  const targetDir = outDir || await fsp.mkdtemp(path.join(os.tmpdir(), "pe-calc-"));
  await fsp.mkdir(targetDir, { recursive: true });
  // Use a throwaway profile so a running desktop LibreOffice (or a stale
  // profile lock) cannot make headless conversion fail with DeploymentException.
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-lo-profile-"));
  try {
    await execFileAsync(bin, [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--headless",
      "--calc",
      "--convert-to",
      "xlsx",
      "--outdir",
      targetDir,
      file,
    ], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  const output = path.join(targetDir, `${path.basename(file, path.extname(file))}.xlsx`);
  if (!fs.existsSync(output)) {
    throw new Error(`LibreOffice 没有生成输出文件：${output}`);
  }
  return output;
}

/**
 * Apply literal cell changes, recalculate, and read the requested outputs.
 * The returned file lives in a temp directory; the caller decides whether to
 * commit it (atomic replace) or discard it.
 */
export async function applyWorkbookCells({
  sourcePath,
  changes = [],
  outputs = [],
  timeoutMs = 180_000,
} = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error("工作模型不存在");
  if (!changes.length) throw new Error("没有要写入的单元格");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-model-write-"));
  const base = path.join(dir, "work.xlsx");
  const edited = path.join(dir, "edited.xlsx");
  await fsp.copyFile(sourcePath, base);
  await writeCells(base, edited, changes);
  const recalculated = await recalculateXlsx(edited, {
    outDir: path.join(dir, "recalc"),
    timeoutMs,
  });
  const values = await readCells(recalculated, outputs);
  return {
    workDir: dir,
    file: recalculated,
    editedFile: edited,
    values,
  };
}
