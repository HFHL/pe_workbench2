#!/usr/bin/env node
/**
 * Model write-back test on a real workbook:
 * prepare working copy -> verify bindings -> write an input -> recalculate ->
 * read the target price -> reject formula cells.
 *
 *   node scripts/test-model-writer.mjs
 *
 * Skips when the real model or LibreOffice is unavailable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../store.mjs";
import { sofficeInfo } from "../lib/calc-engine.mjs";
import { applyModelChanges, prepareWorkingModel } from "../lib/model-writer.mjs";

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

const calc = await sofficeInfo();
if (!calc.available) {
  console.log("跳过：未安装 LibreOffice");
  process.exit(0);
}
if (!fs.existsSync(MODEL)) {
  console.log(`跳过：找不到测试模型 ${MODEL}`);
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-model-writer-"));
const workspace = path.join(root, "projects", "test-project");
fs.mkdirSync(path.join(workspace, "exports", "demo"), { recursive: true });
fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });

try {
  fs.copyFileSync(MODEL, path.join(workspace, "uploads", "model.xlsx"));
  fs.writeFileSync(path.join(workspace, "exports", "demo", "投资框架报告.md"), "# 投资框架报告\n");

  const store = await openStore({
    root,
    workspace,
    projectId: "test-project",
    projectName: "Test",
    seed: false,
  });
  const modelMaterial = store.indexFile("uploads/model.xlsx", { kind: "input" });
  const target = store.indexFile("exports/demo/投资框架报告.md", { kind: "output" });
  const tracking = store.createTracking({
    targetId: target.id,
    templateId: "framework",
    freq: "weekly",
    weekday: 1,
    day: 1,
    time: "09:00",
  });

  const stateRel = "exports/demo/analysis-state.json";
  const state = {
    schema_version: "2.0",
    subject: { company: "长鑫存储", model_file: "uploads/model.xlsx" },
    model: {
      files: [{ absolute_path: "uploads/model.xlsx" }],
      write_enabled: true,
      bindings: [
        { metric: "Beta", sheet: "Discount PE", cell: "H33", verified: true },
        { metric: "目标价", sheet: "Discount PE", cell: "H29", verified: true },
      ],
      outputs: [{ label: "目标价", sheet: "Discount PE", cell: "H29" }],
    },
    falsifiers: [],
    theses: [],
  };
  fs.writeFileSync(path.join(workspace, stateRel), JSON.stringify(state, null, 2));

  const prepared = await prepareWorkingModel({
    ctx: { root: workspace, store },
    tracking,
    state,
    stateRel,
  });
  check("工作模型已准备", fs.existsSync(path.join(workspace, prepared.workingFile)), prepared.workingFile);
  check("状态记录工作模型", state.model.working_file === prepared.workingFile);

  const applied = await applyModelChanges({
    ctx: { root: workspace, store },
    tracking,
    state,
    changes: [{ sheet: "Discount PE", cell: "H33", value: 2.0, note: "Beta 上调" }],
    outputs: [{ label: "目标价", sheet: "Discount PE", cell: "H29" }],
    runId: "run-test-1",
  });
  check("模型写入成功", applied.ok === true, applied.reason || "");
  if (applied.ok) {
    const before = Number(applied.before["Discount PE!H29"]);
    const after = Number(applied.after["Discount PE!H29"]);
    check("目标价已重算", Number.isFinite(after) && after !== before, `${before} -> ${after}`);
    check("写入前已备份", fs.existsSync(path.join(workspace, applied.backupRel)), applied.backupRel);
    check("工作模型产生版本", store.latestVersion(
      store.findMaterialByPath(prepared.workingFile).id,
    )?.reason === "model update");
  }

  const blocked = await applyModelChanges({
    ctx: { root: workspace, store },
    tracking,
    state,
    changes: [{ sheet: "Discount PE", cell: "H29", value: 100, note: "覆盖公式" }],
    outputs: [{ label: "目标价", sheet: "Discount PE", cell: "H29" }],
    runId: "run-test-2",
  });
  check("公式单元格被拒绝", blocked.ok === false && blocked.reason.includes("公式"), blocked.reason || "");
} catch (error) {
  failed += 1;
  console.error("  FAIL", error.stack || error.message);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
