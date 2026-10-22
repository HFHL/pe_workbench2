#!/usr/bin/env node
/**
 * Contract tests for structured tool results.
 *
 * The schemas are the single source of truth: producers validate before they
 * emit, consumers validate before they render or persist. These tests exercise
 * both ends of that contract and the presentation envelope the host stores.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";

import {
  MODEL_CHANGE_PROPOSAL,
  TOOL_PRESENTATION_SCHEMAS,
  TRACKING_RESULT,
  WORKBOOK_QUERY_RESULT,
  contractFor,
  extractPresentation,
  presentationSchema,
  validateContract,
} from "../lib/contracts/index.mjs";
import {
  formatResult,
  queryGraph,
} from "../lib/workbook-query.mjs";
import {
  normalizeTrackingResult,
} from "../lib/tracking.mjs";
import {
  workbookPresentationFromQuery,
} from "../lib/workbook-presentation.mjs";

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  fail ${name}`);
    console.error(`       ${error.stack || error.message}`);
    failed += 1;
  }
}

function workbookFixture() {
  const doc = {
    schemaVersion: 1,
    fileName: "model.xlsx",
    fileSha256: "a".repeat(64),
    sheets: [{ name: "Model", formulaCount: 2, rows: 4, cols: 3 }],
    stats: { cells: 4, formulas: 2, edges: 3 },
    cells: [
      ["Model!B2", null, 100, 2, 2, "Revenue", "2024"],
      ["Model!C2", null, 110, 2, 3, "Revenue", "2025"],
      ["Model!B3", null, 40, 3, 2, "COGS", "2024"],
      ["Model!B4", "=B2-B3", 60, 4, 2, "Gross profit", "2024"],
    ],
    edges: [
      ["Model!B2", "Model!B4"],
      ["Model!B3", "Model!B4"],
      ["Model!B4", "Model!B2"],
    ],
  };
  return doc;
}

function queryResult() {
  return queryGraph(workbookFixture(), "Revenue");
}

function presentationFixture() {
  return workbookPresentationFromQuery(queryResult(), {
    material: {
      id: "mat_1",
      path: "uploads/model.xlsx",
      version: 3,
      sha256: "a".repeat(64),
    },
  });
}

function proposalFixture() {
  return {
    schema: { name: "pe.model-change.proposal", version: 1 },
    proposalId: "prop_1",
    projectId: "product-eng",
    threadId: "thread_1",
    runId: "run_1",
    trackingId: "track_1",
    workingModel: {
      materialId: "mat_1",
      path: "exports/investment/model/工作模型.xlsx",
      baseVersion: 2,
      baseSha256: "b".repeat(64),
    },
    changes: [
      {
        metric: "WACC",
        ref: "Assumption!B2",
        from: 0.1,
        to: 0.09,
        bindingVerified: true,
        formulaCell: false,
        reason: "risk-free rate update",
        source: "Rates.md",
      },
    ],
    outputsToVerify: [{ label: "Target price", ref: "Model!B20" }],
    validation: {
      writeEnabled: true,
      allBindingsVerified: true,
      allTargetsAreLiteralInputs: true,
      libreOfficeAvailable: true,
    },
    status: "pending_approval",
    createdAt: "2026-10-20T00:00:00.000Z",
  };
}

console.log("\ncontract registry");
await run("registers all three v1 contracts", () => {
  assert.equal(WORKBOOK_QUERY_RESULT.name, "pe.workbook-query.result");
  assert.equal(MODEL_CHANGE_PROPOSAL.name, "pe.model-change.proposal");
  assert.equal(TRACKING_RESULT.name, "pe.tracking-result");
  for (const contract of TOOL_PRESENTATION_SCHEMAS) {
    assert.equal(contract.version, 1);
    assert.ok(contractFor(contract.name, contract.version));
  }
});

await run("rejects unknown schema or version", () => {
  assert.equal(contractFor("pe.nope", 1), null);
  assert.equal(contractFor("pe.workbook-query.result", 2), null);
  const result = validateContract("pe.workbook-query.result", 2, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown schema/i);
});

console.log("\nworkbook query result v1");
await run("workbook producer output validates", () => {
  const value = presentationFixture();
  const result = WORKBOOK_QUERY_RESULT.validate(value);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(value.cells.length > 0, true);
  const cell = value.cells.find((item) => item.ref === "Model!B2");
  assert.ok(cell);
  assert.equal(cell.relation, "seed");
  assert.equal(cell.value.raw, 100);
  assert.equal(cell.value.display, "100");
  assert.ok(Array.isArray(cell.upstreamRefs));
  assert.ok(cell.downstreamRefs.includes("Model!B4"));
  assert.equal(value.summary.truncated, false);
});

await run("workbook summary and text stay bounded", () => {
  const query = queryResult();
  const text = formatResult(query, { maxChars: 1200 });
  assert.ok(text.length <= 1400, `text length ${text.length}`);
  const payload = presentationFixture();
  assert.equal(payload.summary.returnedCells, payload.cells.length);
  assert.equal(payload.summary.matchedCells, query.matchedCells);
});

await run("workbook schema rejects a missing baseline material", () => {
  const value = presentationFixture();
  delete value.material.sha256;
  assert.equal(WORKBOOK_QUERY_RESULT.validate(value).ok, false);
});

await run("workbook schema rejects an unknown relation", () => {
  const value = presentationFixture();
  value.cells[0].relation = "sideways";
  assert.equal(WORKBOOK_QUERY_RESULT.validate(value).ok, false);
});

await run("workbook schema rejects a missing value display", () => {
  const value = presentationFixture();
  delete value.cells[0].value.display;
  assert.equal(WORKBOOK_QUERY_RESULT.validate(value).ok, false);
});

console.log("\nmodel change proposal v1");
await run("proposal fixture validates", () => {
  const result = MODEL_CHANGE_PROPOSAL.validate(proposalFixture());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

await run("proposal allows every defined status", () => {
  for (const status of [
    "pending_approval",
    "approved",
    "applying",
    "applied",
    "rejected",
    "conflict",
    "failed",
  ]) {
    const value = proposalFixture();
    value.status = status;
    assert.equal(MODEL_CHANGE_PROPOSAL.validate(value).ok, true, status);
  }
});

await run("proposal rejects an unknown status", () => {
  const value = proposalFixture();
  value.status = "auto_applied";
  assert.equal(MODEL_CHANGE_PROPOSAL.validate(value).ok, false);
});

await run("proposal requires a full baseline", () => {
  const value = proposalFixture();
  delete value.workingModel.baseSha256;
  assert.equal(MODEL_CHANGE_PROPOSAL.validate(value).ok, false);
});

await run("proposal rejects a change without a ref", () => {
  const value = proposalFixture();
  delete value.changes[0].ref;
  assert.equal(MODEL_CHANGE_PROPOSAL.validate(value).ok, false);
});

console.log("\ntracking result v1");
function trackingContext() {
  return {
    trackingId: "track_1",
    targetId: "mat_1",
    targetPath: "exports/report.md",
    templateId: "generic",
    baseVersion: 1,
    resultVersion: 2,
    nowLabel: "2026-10-20 09:00",
    duration: "1m",
    fallbackConclusion: "updated",
    fallbackSummary: "summary",
    status: "updated",
    backupPath: null,
  };
}

await run("normalizer stamps schema and version", () => {
  const result = normalizeTrackingResult(
    {
      status: "updated",
      headline: "Headline",
      conclusion: "Conclusion",
      summary: "Summary",
      deltas: [{ label: "Revenue", from: 1, to: 2, tone: "up" }],
      modelChanges: [{ sheet: "Model", cell: "B2", value: 120, note: "update" }],
    },
    trackingContext(),
  );
  assert.deepEqual(result.schema, { name: "pe.tracking-result", version: 1 });
  assert.equal(TRACKING_RESULT.validate(result).ok, true, JSON.stringify(TRACKING_RESULT.validate(result).errors));
});

await run("legacy tracking result remains readable", () => {
  const legacy = {
    status: "updated",
    headline: "Legacy",
    conclusion: "Legacy",
    summary: "Legacy",
    confidence: "中",
    deltas: [],
    theses: [],
    invalidations: [],
    monitorChecks: [],
    modelChanges: [],
    modelOutputs: [],
    reasons: [],
    sources: [],
    notUsed: [],
    target: { path: "exports/report.md" },
    writeback: { mode: "read-only", version: "v1", stats: "0", note: "" },
  };
  const read = TRACKING_RESULT.validate(legacy, { allowLegacy: true });
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  assert.equal(TRACKING_RESULT.validate(legacy).ok, false);
});

await run("tracking schema rejects an invalid thesis status", () => {
  const result = normalizeTrackingResult(
    { theses: [{ id: "T1", statement: "x", status: "maybe" }] },
    trackingContext(),
  );
  // The normalizer coerces bad legacy input to a known status; corrupt stored
  // payloads are rejected by the consumer.
  result.theses[0].status = "maybe";
  assert.equal(TRACKING_RESULT.validate(result).ok, false);
});

console.log("\npresentation envelope");
await run("extracts a validated presentation from a tool result", () => {
  const payload = presentationFixture();
  const extracted = extractPresentation({
    content: [{ type: "text", text: "short text" }],
    details: {
      presentation: {
        schema: { name: "pe.workbook-query.result", version: 1 },
        payload,
      },
    },
  });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.schemaName, "pe.workbook-query.result");
  assert.equal(extracted.schemaVersion, 1);
  assert.equal(extracted.payload.cells.length, payload.cells.length);
});

await run("refuses a corrupt presentation payload", () => {
  const payload = presentationFixture();
  payload.cells[0].value = "not-an-object";
  const extracted = extractPresentation({
    content: [{ type: "text", text: "short" }],
    details: {
      presentation: {
        schema: { name: "pe.workbook-query.result", version: 1 },
        payload,
      },
    },
  });
  assert.equal(extracted.ok, false);
  assert.match(extracted.error, /schema/i);
});

await run("refuses an unknown schema or version", () => {
  const payload = presentationFixture();
  const unknownName = extractPresentation({
    details: { presentation: { schema: { name: "pe.unknown", version: 1 }, payload } },
  });
  assert.equal(unknownName.ok, false);
  const unknownVersion = extractPresentation({
    details: { presentation: { schema: { name: "pe.workbook-query.result", version: 9 }, payload } },
  });
  assert.equal(unknownVersion.ok, false);
});

await run("JSON schemas are serializable", () => {
  for (const contract of TOOL_PRESENTATION_SCHEMAS) {
    const json = JSON.stringify(contract.schema);
    assert.ok(json.length > 50);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, "object");
  }
});

await run("presentationSchema resolves known pairs", () => {
  assert.equal(presentationSchema("pe.workbook-query.result", 1), WORKBOOK_QUERY_RESULT.schema);
  assert.equal(presentationSchema("pe.unknown", 1), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
