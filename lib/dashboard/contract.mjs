/**
 * pe.investment-dashboard v1.
 *
 * This is a server-produced, read-only view contract. It is deliberately
 * stricter than the tool presentation contracts: unknown section types or
 * versions fail validation instead of falling back to arbitrary markup.
 */

import { Type } from "typebox";

import { makeContract } from "../contracts/core.mjs";

const LEAP_YEAR = "(?:(?:\\d{2}(?:0[48]|[2468][048]|[13579][26]))|(?:(?:[02468][048]|[13579][26])00))";
const DATE_PART = `(?:${LEAP_YEAR}-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8])))`;
const DATE_PATTERN = `^${DATE_PART}(?:T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?Z)?$`;
const DATE = Type.String({ pattern: DATE_PATTERN, maxLength: 40 });
const NULLABLE_DATE = Type.Union([DATE, Type.Null()]);
const NULLABLE_NUMBER = Type.Union([Type.Number(), Type.Null()]);
const NULLABLE_STRING = Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]);
const VERSION = Type.Integer({ minimum: 1 });
const NULLABLE_VERSION = Type.Union([VERSION, Type.Null()]);
const SAFE_URL = Type.String({
  maxLength: 2000,
  pattern: "^(?:/(?!/)|https?://)",
});

const SourceRef = Type.Object({
  kind: Type.Union([
    Type.Literal("material"),
    Type.Literal("workbook"),
    Type.Literal("state"),
    Type.Literal("run"),
    Type.Literal("external"),
    Type.Literal("text"),
  ]),
  label: Type.String({ maxLength: 1000 }),
  materialId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  version: NULLABLE_VERSION,
  path: NULLABLE_STRING,
  locator: NULLABLE_STRING,
  url: Type.Union([SAFE_URL, Type.Null()]),
  status: Type.Union([
    Type.Literal("ok"),
    Type.Literal("missing"),
    Type.Literal("broken"),
    Type.Literal("unverified"),
  ]),
  note: NULLABLE_STRING,
}, { additionalProperties: false });

const SourceRefs = Type.Array(SourceRef, { maxItems: 100 });

const Delta = Type.Object({
  label: Type.String({ maxLength: 500 }),
  from: Type.String({ maxLength: 500 }),
  to: Type.String({ maxLength: 500 }),
  note: Type.String({ maxLength: 1000 }),
  tone: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("flat")]),
}, { additionalProperties: false });

const Reason = Type.Object({
  tag: Type.String({ maxLength: 200 }),
  title: Type.String({ maxLength: 1000 }),
  detail: Type.String({ maxLength: 4000 }),
  source: Type.String({ maxLength: 1000 }),
  impact: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });

const TrackingSource = Type.Object({
  label: Type.String({ maxLength: 500 }),
  date: Type.String({ maxLength: 80 }),
}, { additionalProperties: false });

const WritebackChange = Type.Object({
  where: Type.String({ maxLength: 500 }),
  from: Type.String({ maxLength: 500 }),
  to: Type.String({ maxLength: 500 }),
  note: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });

const Writeback = Type.Object({
  mode: Type.String({ maxLength: 300 }),
  version: Type.String({ maxLength: 300 }),
  stats: Type.String({ maxLength: 300 }),
  note: Type.String({ maxLength: 2000 }),
  backup: Type.String({ maxLength: 1000 }),
  changes: Type.Array(WritebackChange, { maxItems: 200 }),
}, { additionalProperties: false });

const ModelOutput = Type.Object({
  label: Type.String({ maxLength: 300 }),
  sheet: Type.String({ maxLength: 200 }),
  cell: Type.String({ maxLength: 40 }),
  before: Type.Union([Type.Number(), Type.String({ maxLength: 300 }), Type.Boolean(), Type.Null()]),
  after: Type.Union([Type.Number(), Type.String({ maxLength: 300 }), Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });

const ValuationData = Type.Object({
  company: Type.String({ maxLength: 1000 }),
  asOf: NULLABLE_DATE,
  currency: Type.Union([Type.String({ pattern: "^[A-Z]{3}$" }), Type.Null()]),
  valueUnit: NULLABLE_STRING,
  priceUnit: NULLABLE_STRING,
  method: NULLABLE_STRING,
  currentPrice: NULLABLE_NUMBER,
  priceDate: NULLABLE_DATE,
  targetPrice: NULLABLE_NUMBER,
  upsidePercent: NULLABLE_NUMBER,
  rating: NULLABLE_STRING,
  confidence: Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
    Type.Null(),
  ]),
  baseCaseLabel: NULLABLE_STRING,
  baseCaseId: NULLABLE_STRING,
  conclusion: Type.String({ maxLength: 4000 }),
  unknowns: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 }),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const VersionChangeData = Type.Object({
  fromVersion: Type.String({ maxLength: 40 }),
  toVersion: Type.String({ maxLength: 40 }),
  fromDate: NULLABLE_DATE,
  toDate: NULLABLE_DATE,
  headline: Type.String({ maxLength: 4000 }),
  conclusion: Type.String({ maxLength: 4000 }),
  status: Type.Union([
    Type.Literal("updated"),
    Type.Literal("no_change"),
    Type.Literal("needs_review"),
    Type.Literal("baseline"),
    Type.Literal("failed"),
    Type.Literal("unavailable"),
  ]),
  statusLabel: Type.String({ maxLength: 100 }),
  changeKind: Type.Union([
    Type.Literal("business"),
    Type.Literal("audit-only"),
    Type.Literal("none"),
    Type.Literal("review"),
    Type.Literal("baseline"),
    Type.Literal("failed"),
    Type.Literal("unavailable"),
  ]),
  conclusionChanged: Type.Boolean(),
  auditNote: Type.String({ maxLength: 2000 }),
  deltas: Type.Array(Delta, { maxItems: 200 }),
  reasons: Type.Array(Reason, { maxItems: 200 }),
  writeback: Writeback,
  modelOutputs: Type.Array(ModelOutput, { maxItems: 100 }),
  sources: Type.Array(TrackingSource, { maxItems: 200 }),
  notUsed: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 200 }),
  unverified: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 200 }),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const Axis = Type.Object({
  label: Type.String({ maxLength: 200 }),
  values: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
}, { additionalProperties: false });

const SensitivityCell = Type.Object({
  row: Type.String({ maxLength: 500 }),
  column: Type.String({ maxLength: 500 }),
  value: NULLABLE_NUMBER,
  unit: Type.String({ maxLength: 100 }),
  valuationId: Type.String({ maxLength: 200 }),
  isBaseCase: Type.Boolean(),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const BaseCase = Type.Object({
  row: Type.String({ maxLength: 500 }),
  column: Type.String({ maxLength: 500 }),
  valuationId: Type.String({ maxLength: 200 }),
  label: Type.String({ maxLength: 500 }),
  value: Type.Number(),
  unit: Type.String({ maxLength: 100 }),
}, { additionalProperties: false });

const SensitivityTest = Type.Object({
  id: Type.String({ maxLength: 200 }),
  method: Type.String({ maxLength: 200 }),
  baseline: Type.String({ maxLength: 1000 }),
  perturbation: Type.String({ maxLength: 1000 }),
  result: Type.String({ maxLength: 2000 }),
  fixedConditions: Type.String({ maxLength: 2000 }),
  limitations: Type.String({ maxLength: 2000 }),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const SensitivityData = Type.Object({
  title: Type.String({ maxLength: 300 }),
  available: Type.Boolean(),
  emptyReason: NULLABLE_STRING,
  rowAxis: Axis,
  columnAxis: Axis,
  cells: Type.Array(SensitivityCell, { maxItems: 200 }),
  baseCase: Type.Union([BaseCase, Type.Null()]),
  valueUnit: Type.String({ maxLength: 100 }),
  units: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 }),
  summary: Type.String({ maxLength: 2000 }),
  tests: Type.Array(SensitivityTest, { maxItems: 100 }),
  unknowns: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 }),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const Thesis = Type.Object({
  id: Type.String({ maxLength: 200 }),
  statement: Type.String({ maxLength: 4000 }),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("weakened"),
    Type.Literal("invalidated"),
    Type.Literal("confirmed"),
    Type.Literal("retired"),
  ]),
}, { additionalProperties: false });

const Check = Type.Object({
  id: Type.String({ maxLength: 200 }),
  thesisId: Type.String({ maxLength: 200 }),
  falsifierId: Type.String({ maxLength: 200 }),
  metric: Type.String({ maxLength: 1000 }),
  operator: Type.String({ maxLength: 40 }),
  warning: Type.String({ maxLength: 1000 }),
  threshold: Type.String({ maxLength: 1000 }),
  observed: Type.String({ maxLength: 1000 }),
  status: Type.Union([
    Type.Literal("armed"),
    Type.Literal("warning"),
    Type.Literal("triggered"),
    Type.Literal("unknown"),
    Type.Literal("retired"),
  ]),
  statusLabel: Type.String({ maxLength: 100 }),
  statusMeaning: Type.String({ maxLength: 500 }),
  lastCheckedAt: NULLABLE_DATE,
  nextCheckAt: NULLABLE_DATE,
  action: Type.String({ maxLength: 2000 }),
  linkStatus: Type.Union([Type.Literal("linked"), Type.Literal("unbound")]),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const FalsificationCounts = Type.Object({
  triggered: Type.Integer({ minimum: 0 }),
  warning: Type.Integer({ minimum: 0 }),
  unknown: Type.Integer({ minimum: 0 }),
  armed: Type.Integer({ minimum: 0 }),
  retired: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const FalsificationData = Type.Object({
  theses: Type.Array(Thesis, { maxItems: 200 }),
  checks: Type.Array(Check, { maxItems: 300 }),
  counts: FalsificationCounts,
  unknowns: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 }),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });

const sectionBase = (type, data) => Type.Object({
  type: Type.Literal(type),
  version: Type.Literal(1),
  data,
}, { additionalProperties: false });

// A tuple, not an unordered array: v1 is exactly these four sections in this
// order. Duplicated or reordered sections are invalid.
const Sections = Type.Tuple([
  sectionBase("valuation-summary", ValuationData),
  sectionBase("version-change", VersionChangeData),
  sectionBase("sensitivity-matrix", SensitivityData),
  sectionBase("falsification-panel", FalsificationData),
]);

const RunOption = Type.Object({
  runId: Type.String({ maxLength: 200 }),
  at: NULLABLE_DATE,
  status: Type.String({ maxLength: 100 }),
  label: Type.String({ maxLength: 500 }),
  hasResult: Type.Boolean(),
  isLatest: Type.Boolean(),
}, { additionalProperties: false });

export const INVESTMENT_DASHBOARD_SCHEMA = Type.Object({
  schema: Type.Object({
    name: Type.Literal("pe.investment-dashboard"),
    version: Type.Literal(1),
  }, { additionalProperties: false }),
  projectId: Type.String({ minLength: 1, maxLength: 200 }),
  asOf: NULLABLE_DATE,
  timezone: Type.Literal("Asia/Shanghai"),
  dataState: Type.Union([
    Type.Literal("complete"),
    Type.Literal("partial"),
    Type.Literal("empty"),
  ]),
  source: Type.Object({
    trackingId: Type.String({ minLength: 1, maxLength: 200 }),
    runId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    materialId: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    materialVersion: NULLABLE_VERSION,
  }, { additionalProperties: false }),
  runs: Type.Array(RunOption, { maxItems: 50 }),
  warnings: Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 100 }),
  sections: Sections,
}, { additionalProperties: false });

export const INVESTMENT_DASHBOARD = makeContract(
  "pe.investment-dashboard",
  1,
  INVESTMENT_DASHBOARD_SCHEMA,
);
