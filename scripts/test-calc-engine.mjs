#!/usr/bin/env node
/**
 * LibreOffice / openpyxl calculation spike.
 *
 *   node scripts/test-calc-engine.mjs
 *
 * Uses the real CXMT model when present; skips cleanly otherwise. Never touches
 * the original upload: it works on a temp copy.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyWorkbookCells,
  readCells,
  sofficeInfo,
} from "../lib/calc-engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.MODEL_TEST_FILE
  || path.join(ROOT, "projects/p-c1db281e/uploads/1792408641276-高盛-长鑫-Model-20260904.xlsx");

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const info = await sofficeInfo();
console.log(`LibreOffice: ${info.available ? info.version : "not found"}`);
if (!info.available) {
  console.log("跳过：未安装 LibreOffice（设置 SOFFICE_BIN 后重试）");
  process.exit(0);
}
if (!fs.existsSync(MODEL)) {
  console.log(`跳过：找不到测试模型 ${MODEL}`);
  process.exit(0);
}

try {
  const before = await readCells(MODEL, ["Discount PE!H29", "Discount PE!H36", "Discount PE!H33"]);
  check("读取原始目标价", Number(before["Discount PE!H29"]) > 0, JSON.stringify(before));

  const result = await applyWorkbookCells({
    sourcePath: MODEL,
    changes: ["Discount PE!H33=2.0"],
    outputs: ["Discount PE!H29", "Discount PE!H36", "Discount PE!H33"],
  });
  const after = result.values;
  check("Beta 写入生效", Number(after["Discount PE!H33"]) === 2, JSON.stringify(after));
  check("COE 已重算", Math.abs(Number(after["Discount PE!H36"]) - 0.16) < 0.005, JSON.stringify(after));
  check(
    "目标价已重算且发生变化",
    Number(after["Discount PE!H29"]) > 0 && Number(after["Discount PE!H29"]) !== Number(before["Discount PE!H29"]),
    `before=${before["Discount PE!H29"]} after=${after["Discount PE!H29"]}`,
  );
  console.log(`  info 目标价：${before["Discount PE!H29"]} → ${after["Discount PE!H29"]}`);
  fs.rmSync(result.workDir, { recursive: true, force: true });
} catch (error) {
  failed += 1;
  console.error("  FAIL", error.stack || error.message);
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
