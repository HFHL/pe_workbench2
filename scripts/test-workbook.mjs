#!/usr/bin/env node
/**
 * End-to-end test for the workbook query slice.
 *
 *   node scripts/test-workbook.mjs            # fixture only (fast)
 *   node scripts/test-workbook.mjs --real     # also the two real uploads
 *
 * The script creates a throwaway workspace + SQLite DB under os.tmpdir(), so it
 * never touches data/workbench.db or agent-workspace.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store.mjs";
import { WorkbookStore } from "../lib/workbook-store.mjs";
import { ExcelPreviewStore } from "../lib/excel-preview.mjs";
import { createWorkbookTool, workspaceRel } from "../lib/workbook-tool.mjs";
import { tokenize, queryGraph, formatResult } from "../lib/workbook-query.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const FIXTURE_SCRIPT = path.join(HERE, "fixtures", "make-workbook-fixture.py");
const CORRUPT_FIXTURE = path.join(HERE, "fixtures", "make-corrupt-workbook.py");
const PYTHON = process.env.PYTHON_BIN || "python3";
const REAL = process.argv.includes("--real");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
}

function pythonAvailable() {
  const check = spawnSync(PYTHON, ["-c", "import openpyxl"], { encoding: "utf8" });
  if (check.error) return false;
  return check.status === 0;
}

async function main() {
  if (!pythonAvailable()) {
    console.log(`SKIP: ${PYTHON} + openpyxl not available (set PYTHON_BIN to override)`);
    return;
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wb-test-"));
  const workspace = path.join(root, "agent-workspace");
  const dataDir = path.join(root, "data");
  await fsp.mkdir(path.join(workspace, "uploads"), { recursive: true });
  await fsp.mkdir(path.join(dataDir, "blobs"), { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, "workbench.db"));
  const store = new Store(db, { workspace, dataDir });
  store.migrate();
  const workbooks = new WorkbookStore({ store, cacheDir: path.join(dataDir, "doc-cache") });

  try {
    const fixture = path.join(workspace, "uploads", "test-model.xlsx");
    const generated = spawnSync(PYTHON, [FIXTURE_SCRIPT, fixture], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || "fixture generation failed");

    const material = store.indexFile("uploads/test-model.xlsx", {
      kind: "input",
      source: "upload",
      author: "test",
      note: "fixture",
      status: "synced",
      desc: "fixture",
    });
    const version = store.latestVersion(material.id);
    const sha = version.blob_sha256;

    console.log("\nfixture + cache");
    let summary;
    await test("summary parses the fixture", async () => {
      summary = await workbooks.summary(material.id);
      assert.ok(summary.stats.formulaCount >= 10, "formulaCount");
      assert.ok(summary.stats.edgeCount > summary.stats.formulaCount, "edges include inputs");
      assert.ok(summary.sheets.some((sheet) => sheet.name === "模型"));
      assert.ok(summary.outputs.length > 0);
    });

    await test("labels are read from header/label columns", async () => {
      const graph = await workbooks.getGraph(sha, {
        fileName: "test-model.xlsx",
        ext: "xlsx",
        fileType: "excel",
      });
      assert.equal(graph.cells.get("Model!B4").rowLabel, "Gross profit");
      assert.equal(graph.cells.get("Model!B4").colLabel, "2024");
      assert.equal(graph.cells.get("模型!B5").rowLabel, "毛利率");
      assert.equal(graph.cells.get("模型!B5").colLabel, "2025");
    });

    await test("SUM range expands to every intermediate cell", async () => {
      const graph = await workbooks.getGraph(sha, {
        fileName: "test-model.xlsx",
        ext: "xlsx",
        fileType: "excel",
      });
      const inputs = graph.upstream.get("Model!B6") || [];
      for (const id of ["Model!B2", "Model!B3", "Model!B4", "Model!B5"]) {
        assert.ok(inputs.includes(id), `missing dependency ${id}`);
      }
    });

    await test("cross-sheet inputs become graph nodes", async () => {
      const graph = await workbooks.getGraph(sha, {
        fileName: "test-model.xlsx",
        ext: "xlsx",
        fileType: "excel",
      });
      assert.ok(graph.cells.has("Assumption!B2"), "input node");
      assert.equal(graph.cells.get("Assumption!B2").formula, null);
      assert.ok((graph.upstream.get("Model!B7") || []).includes("Assumption!B2"));
    });

    await test("Chinese query returns the expected row", async () => {
      const result = await workbooks.queryMaterial(material.id, "毛利率", { maxCells: 20 });
      assert.ok(result.cells.some((cell) => cell.label.includes("毛利率")), "no 毛利率 cell");
      assert.match(result.text, /毛利率/);
    });

    await test("year + metric query filters by column label", async () => {
      const result = await workbooks.queryMaterial(material.id, "2025 收入", { maxCells: 20 });
      assert.ok(
        result.cells.some((cell) => cell.label.includes("营业收入") && cell.label.includes("2025")),
        "expected 营业收入 / 2025",
      );
    });

    await test("unknown query returns an explicit empty result", async () => {
      const result = await workbooks.queryMaterial(material.id, "zzzz-not-a-metric", { maxCells: 10 });
      assert.equal(result.matchedCells, 0);
      assert.match(result.text, /没有匹配/);
    });

    await test("direct Sheet!A1 returns the cell and its neighbours", async () => {
      const result = await workbooks.queryMaterial(material.id, "Model!B4", { maxCells: 10 });
      assert.ok(result.cells.some((cell) => cell.id === "Model!B4"));
      assert.equal(result.matchedCells, 1);
    });

    console.log("\ncache / restart / concurrency");
    await test("cache survives a new WorkbookStore instance", async () => {
      const first = workbooks.getRecord(sha);
      assert.equal(first.status, "ready");
      assert.ok(fs.existsSync(workbooks.cachePath(sha)));

      workbooks.cache.clear();
      const restarted = new WorkbookStore({ store, cacheDir: path.join(dataDir, "doc-cache") });
      const graph = await restarted.getGraph(sha, { fileName: "test-model.xlsx", ext: "xlsx" });
      assert.ok(graph.cells.has("Model!B5"));
      assert.equal(restarted.getRecord(sha).parsed_at, first.parsed_at);
    });

    await test("concurrent queries parse only once", async () => {
      await workbooks.invalidate(sha);
      let parses = 0;
      const original = workbooks.runParser.bind(workbooks);
      workbooks.runParser = (...args) => {
        parses += 1;
        return original(...args);
      };
      await Promise.all(
        Array.from({ length: 5 }, () => workbooks.queryMaterial(material.id, "收入", { maxCells: 8 })),
      );
      assert.equal(parses, 1);
    });

    console.log("\nfailure modes");
    await test("broken xlsx reports a readable error and records failure", async () => {
      const brokenPath = path.join(workspace, "uploads", "broken.xlsx");
      await fsp.writeFile(brokenPath, "this is not a workbook");
      const broken = store.indexFile("uploads/broken.xlsx", {
        kind: "input",
        source: "upload",
        author: "test",
        note: "broken",
        status: "synced",
      });
      await assert.rejects(
        () => workbooks.summary(broken.id),
        /不是有效的 xlsx|解析失败|加密/,
      );
      const record = workbooks.getRecord(store.latestVersion(broken.id).blob_sha256);
      assert.equal(record.status, "failed");
    });

    await test("empty query is rejected", async () => {
      await assert.rejects(() => workbooks.queryMaterial(material.id, "   "), /query is required/);
    });

    await test("missing python is reported without a crash", async () => {
      const file = path.join(workspace, "uploads", "missing-python.xlsx");
      await fsp.writeFile(file, "not a workbook");
      const missing = store.indexFile("uploads/missing-python.xlsx", {
        kind: "input",
        source: "upload",
        author: "test",
        note: "missing python",
        status: "synced",
      });
      const brokenPython = new WorkbookStore({
        store,
        cacheDir: path.join(dataDir, "doc-cache"),
        pythonBin: "__no_such_python_binary__",
      });
      await assert.rejects(() => brokenPython.summary(missing.id), /未找到|Python/);
    });

    await test("parser timeout is reported and recorded", async () => {
      const slowFile = path.join(workspace, "uploads", "slow.xlsx");
      const generated = spawnSync(PYTHON, [FIXTURE_SCRIPT, slowFile, "101"], { encoding: "utf8" });
      assert.equal(generated.status, 0, generated.stderr);
      const slow = store.indexFile("uploads/slow.xlsx", {
        kind: "input",
        source: "upload",
        author: "test",
        note: "slow",
        status: "synced",
      });
      const impatient = new WorkbookStore({
        store,
        cacheDir: path.join(dataDir, "doc-cache"),
        timeoutMs: 1,
      });
      await assert.rejects(() => impatient.summary(slow.id), /解析超时/);
    });

    await test("legacy .xls is rejected with a clear hint", async () => {
      const xlsPath = path.join(workspace, "uploads", "legacy.xls");
      await fsp.writeFile(xlsPath, "legacy");
      const legacy = store.indexFile("uploads/legacy.xls", {
        kind: "input",
        source: "upload",
        author: "test",
        note: "legacy",
        status: "synced",
      });
      await assert.rejects(() => workbooks.summary(legacy.id), /旧版 \.xls/);
    });

    console.log("\ndamaged optional parts");
    const corruptFixtures = [
      ["emf", /图片/, /ZeroDivisionError/],
      ["drawing", /图形\/图表/, /XML|Premature/],
      ["comments", /辅助部件/, /comments/],
      ["hyperlink", /格式与装饰/, /sheet1\.xml/],
    ];
    const corruptMaterials = new Map();
    for (const [mode, warningPattern, detailPattern] of corruptFixtures) {
      const relPath = `uploads/corrupt-${mode}.xlsx`;
      const absolute = path.join(workspace, relPath);
      const generated = spawnSync(PYTHON, [CORRUPT_FIXTURE, absolute, mode], {
        encoding: "utf8",
      });
      assert.equal(generated.status, 0, generated.stderr || `fixture ${mode} failed`);
      const material = store.indexFile(relPath, {
        kind: "input",
        source: "upload",
        author: "test",
        note: `corrupt ${mode}`,
        status: "synced",
      });
      corruptMaterials.set(mode, material);

      await test(`corrupt ${mode}: cell data survives`, async () => {
        const summary = await workbooks.summary(material.id);
        assert.equal(summary.status, "ready");
        assert.ok(summary.stats.formulaCount >= 6, "formulas");
        assert.ok(
          summary.warnings.some((warning) => warningPattern.test(warning)),
          `expected ${warningPattern} in ${JSON.stringify(summary.warnings)}`,
        );
        assert.ok(
          summary.warnings.some((warning) => detailPattern.test(warning)),
          `expected ${detailPattern} in ${JSON.stringify(summary.warnings)}`,
        );

        const result = await workbooks.queryMaterial(material.id, "Gross margin", {
          maxCells: 8,
        });
        assert.ok(
          result.cells.some((cell) => cell.label.includes("Gross margin")),
          "Gross margin cell missing",
        );
        assert.match(result.text, /注意：/);
        assert.equal(result.warnings.length, summary.warnings.length);
      });
    }

    await test("preview survives the damaged EMF image", async () => {
      const previews = new ExcelPreviewStore({
        store,
        cacheDir: path.join(dataDir, "doc-cache"),
      });
      const material = corruptMaterials.get("emf");
      const version = store.latestVersion(material.id);
      const manifest = await previews.manifest(material.id, version.v);
      assert.equal(manifest.sheets[0].name, "Model");
      assert.ok(manifest.warnings.length > 0, "preview warnings");
      const sheet = await previews.sheet(material.id, version.v, "Model");
      assert.ok(
        sheet.cells.some((cell) => cell[2] === "Gross margin"),
        "preview lost cell data",
      );
    });

    console.log("\ntool + units");
    await test("workbook_query tool works end to end", async () => {
      const tool = createWorkbookTool({ store, workbooks, workspace });
      const result = await tool.execute("call-1", {
        path: "uploads/test-model.xlsx",
        query: "毛利率",
      });
      assert.ok(result.content[0].text.includes("毛利率"));
      assert.equal(result.isError, undefined);
      assert.ok(result.details.materialId);
    });

    await test("workbook_query rejects paths outside the workspace", async () => {
      const tool = createWorkbookTool({ store, workbooks, workspace });
      const result = await tool.execute("call-2", {
        path: "../outside.xlsx",
        query: "收入",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /project/);
    });

    await test("workspaceRel normalises agent-workspace/ prefixes", () => {
      assert.equal(
        workspaceRel(workspace, "agent-workspace/uploads/test-model.xlsx"),
        "uploads/test-model.xlsx",
      );
      assert.throws(() => workspaceRel(workspace, "../x.xlsx"));
    });

    await test("Chinese tokenization keeps 2-char words", () => {
      const tokens = tokenize("2026 收入").map((item) => item.token);
      assert.ok(tokens.includes("2026"));
      assert.ok(tokens.includes("收入"));
      assert.ok(tokens.includes("revenue"));
      const margin = tokenize("毛利率").map((item) => item.token);
      assert.ok(margin.includes("毛利率"));
      assert.ok(margin.includes("毛利"));
    });

    await test("server wiring keeps upload warm-up and the API route", () => {
      const source = [
        "server/create-app.mjs",
        "server/project-context.mjs",
        "server/agent/session-service.mjs",
        "server/routes/materials.mjs",
      ].map((file) => fs.readFileSync(path.join(PROJECT, file), "utf8")).join("\n");
      assert.match(source, /function warmWorkbook\(ctx, material\)/);
      assert.ok((source.match(/warmWorkbook\(ctx, material\);/g) || []).length >= 2);
      assert.match(source, /customTools: ctx\.tools/);
      assert.match(source, /new AsrService/);
      assert.match(source, /warmAsr\(ctx, material\)/);
      assert.ok(source.includes("workbookMatch") && source.includes("workbook|query"));
    });

    await test("formatResult is bounded and has no table", async () => {
      const graph = await workbooks.getGraph(sha, { fileName: "test-model.xlsx", ext: "xlsx" });
      const result = queryGraph(graph, "收入", { maxCells: 5 });
      const text = formatResult(result);
      assert.ok(text.length < 8000);
      assert.ok(!text.includes("| ---"));
    });

    if (REAL) {
      console.log("\nreal models");
      const sourceDir = path.join(PROJECT, "agent-workspace", "uploads");
      const candidates = fs.existsSync(sourceDir)
        ? fs.readdirSync(sourceDir).filter((name) => /\.(xlsx|xlsm)$/i.test(name))
        : [];
      assert.ok(candidates.length > 0, "no real .xlsx/.xlsm uploads found");

      for (const name of candidates) {
        const targetRel = `uploads/${name}`;
        await fsp.copyFile(path.join(sourceDir, name), path.join(workspace, targetRel));
        const real = store.indexFile(targetRel, {
          kind: "input",
          source: "upload",
          author: "test",
          note: "real model",
          status: "synced",
        });
        const started = Date.now();
        const result = await workbooks.queryMaterial(real.id, "2026 收入", { maxCells: 12 });
        const record = workbooks.getRecord(store.latestVersion(real.id).blob_sha256);
        console.log(
          `  ${name}: ${Date.now() - started}ms, formulas=${record.stats_json ? JSON.parse(record.stats_json).formulaCount : "?"}, ` +
            `cache=${record.stats_json ? JSON.parse(record.stats_json).cacheBytes : "?"}B, hits=${result.matchedCells}`,
        );
        assert.ok(result.matchedCells > 0, `${name}: no matches`);
        assert.ok(result.cells.length > 0, `${name}: empty result`);

        if (/HERMES/i.test(name)) {
          assert.ok(
            result.cells.some((cell) => cell.label.includes("Group Sales")),
            "Hermes: expected Group Sales / 2026E",
          );
        }
        if (/Horizon/i.test(name)) {
          const margin = await workbooks.queryMaterial(real.id, "毛利率", { maxCells: 12 });
          assert.ok(
            margin.cells.some((cell) => cell.label.includes("Gross margin")),
            "Horizon: expected Gross margin",
          );
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) {
      console.error(`\n${failure.name}\n${failure.error.stack}`);
    }
    process.exitCode = 1;
  }
}

await main();
