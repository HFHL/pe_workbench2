#!/usr/bin/env node
/**
 * End-to-end test for the PDF reading slice.
 *
 *   node scripts/test-pdf.mjs
 *   node scripts/test-pdf.mjs --file /path/to/real.pdf
 *
 * A throwaway workspace + SQLite DB is created under os.tmpdir(), so the test
 * never touches data/workbench.db. Requires python3 + pdfplumber + reportlab.
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
import { PdfStore } from "../lib/pdf-store.mjs";
import { createPdfTool } from "../lib/pdf-tool.mjs";
import { parsePageSpec } from "../lib/pdf-query.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT = path.join(HERE, "fixtures", "make-pdf-fixture.py");
const PYTHON = process.env.PYTHON_BIN || "python3";
const fileFlag = process.argv.indexOf("--file");
const REAL_FILE = fileFlag !== -1 ? process.argv[fileFlag + 1] : "";

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
  const check = spawnSync(PYTHON, ["-c", "import pdfplumber, reportlab"], { encoding: "utf8" });
  return !check.error && check.status === 0;
}

async function main() {
  if (!pythonAvailable()) {
    console.log(`SKIP: ${PYTHON} + pdfplumber + reportlab not available (set PYTHON_BIN to override)`);
    return;
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pdf-test-"));
  const workspace = path.join(root, "agent-workspace");
  const dataDir = path.join(root, "data");
  await fsp.mkdir(path.join(workspace, "uploads"), { recursive: true });
  await fsp.mkdir(path.join(dataDir, "blobs"), { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, "workbench.db"));
  const store = new Store(db, { workspace, dataDir });
  store.migrate();
  const pdfs = new PdfStore({ store, cacheDir: path.join(dataDir, "doc-cache", "pdf") });

  try {
    const fixture = path.join(workspace, "uploads", "test-report.pdf");
    const generated = spawnSync(PYTHON, [FIXTURE_SCRIPT, fixture], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr || "fixture generation failed");

    const material = store.indexFile("uploads/test-report.pdf", {
      kind: "input",
      source: "upload",
      author: "test",
      note: "fixture",
      status: "synced",
    });

    await test("summary reports pages, chars and scanned pages", async () => {
      const summary = await pdfs.summary(material.id);
      assert.equal(summary.pages, 3);
      assert.ok(summary.chars > 200, `chars=${summary.chars}`);
      assert.deepEqual(summary.scannedPages, [1]);
      assert.ok(summary.headings.length >= 2);
      assert.equal(summary.status, "ready");
      assert.equal(summary.pageStats.length, 3);
    });

    await test("outline lists headings and page map", async () => {
      const outline = await pdfs.outline(material.id);
      assert.match(outline.text, /行业概览/);
      assert.match(outline.text, /p\.1/);
      assert.match(outline.text, /无文字页/);
    });

    await test("search finds a keyword and cites its page", async () => {
      const result = await pdfs.search(material.id, "毛利率");
      assert.ok(result.hits.length > 0, "expected hits");
      assert.ok(result.pages.includes(2), `pages=${result.pages}`);
      assert.match(result.text, /毛利率/);
      assert.match(result.text, /p\.2/);
    });

    await test("readPages returns page-addressed blocks", async () => {
      const result = await pdfs.readPages(material.id, "2-3");
      assert.deepEqual(result.pages, [2, 3]);
      assert.equal(result.blocks.length, 2);
      assert.equal(result.blocks[0].page, 2);
      assert.match(result.text, /行业概览/);
      assert.match(result.text, /财务口径/);
      assert.equal(result.truncated, false);
    });

    await test("readPages truncates on the char budget and suggests the next page", async () => {
      const result = await pdfs.readPages(material.id, "2-3", { maxChars: 180 });
      assert.equal(result.truncated, true);
      assert.deepEqual(result.pages, [2]);
      assert.match(result.text, /继续用 page="3"/);
    });

    await test("a single oversized page is returned whole, never falsely truncated", async () => {
      const result = await pdfs.readPages(material.id, "2", { maxChars: 100 });
      assert.equal(result.truncated, false);
      assert.deepEqual(result.pages, [2]);
      assert.match(result.text, /财务口径/);
      assert.doesNotMatch(result.text, /输出已截断/);
    });

    await test("scanned page is reported instead of silently empty", async () => {
      const result = await pdfs.readPages(material.id, "1");
      assert.equal(result.blocks[0].scanned, true);
      assert.match(result.text, /OCR/);
    });

    await test("tables mode extracts the ruled table", async () => {
      const result = await pdfs.tables(material.id, "3");
      assert.ok(result.tables.length >= 1, "expected a table");
      assert.match(result.text, /毛利率/);
      assert.equal(result.tables[0].page, 3);
    });

    await test("bad page spec is rejected with a helpful message", async () => {
      assert.throws(() => parsePageSpec("abc", 3), /无法识别的页码/);
      assert.deepEqual(parsePageSpec("2-1", 3), [1, 2]);
      assert.deepEqual(parsePageSpec("1,3", 3), [1, 3]);
    });

    await test("parse cache is keyed by blob sha and reused", async () => {
      const blob = store.blobPath(store.latestVersion(material.id).blob_sha256);
      const sha = store.latestVersion(material.id).blob_sha256;
      assert.ok(fs.existsSync(blob));
      assert.ok(fs.existsSync(path.join(dataDir, "doc-cache", "pdf", `${sha}.json.gz`)));
      const record = pdfs.getRecord(sha);
      assert.equal(record.status, "ready");
      assert.equal(record.file_type, "pdf");
      const again = await pdfs.summary(material.id);
      assert.equal(again.pages, 3);
    });

    await test("pdf_read tool resolves a workspace path and returns text", async () => {
      const tool = createPdfTool({ store, pdfs, workspace });
      const outline = await tool.execute("t1", { path: "uploads/test-report.pdf" });
      assert.equal(outline.isError, undefined);
      assert.match(outline.content[0].text, /行业概览/);
      const pages = await tool.execute("t2", { path: "uploads/test-report.pdf", page: "2" });
      assert.match(pages.content[0].text, /财务口径/);
      const search = await tool.execute("t3", { path: "uploads/test-report.pdf", query: "毛利率" });
      assert.match(search.content[0].text, /p\.2/);
    });

    await test("pdf_read rejects a missing or non-PDF path", async () => {
      const tool = createPdfTool({ store, pdfs, workspace });
      const missing = await tool.execute("t4", { path: "uploads/nope.pdf" });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /文件不存在/);

      await fsp.writeFile(path.join(workspace, "uploads", "note.txt"), "hello");
      const wrong = await tool.execute("t5", { path: "uploads/note.txt" });
      assert.equal(wrong.isError, true);
      assert.match(wrong.content[0].text, /只能读取 \.pdf/);
    });

    if (REAL_FILE) {
      await test(`real PDF smoke test: ${path.basename(REAL_FILE)}`, async () => {
        const target = path.join(workspace, "uploads", path.basename(REAL_FILE));
        fs.copyFileSync(REAL_FILE, target);
        const item = store.indexFile(`uploads/${path.basename(REAL_FILE)}`, { kind: "input" });
        const summary = await pdfs.summary(item.id);
        assert.ok(summary.pages > 0);
        assert.ok(summary.chars > 0);
        const outline = await pdfs.outline(item.id);
        assert.match(outline.text, /页概览/);
      });
    }

    if (failures.length) {
      console.error(`\n${failures.length} failed, ${passed} passed`);
      for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`);
      process.exitCode = 1;
    } else {
      console.log(`\n${passed} passed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
