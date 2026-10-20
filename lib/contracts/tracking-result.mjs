/**
 * pe.tracking-result v1
 *
 * Formalizes the shape produced by normalizeTrackingResult. Legacy rows without
 * a schema field stay readable, but every new write is stamped and validated.
 */

import { Type } from "typebox";
import { makeContract } from "./core.mjs";

const SchemaRef = Type.Object({
  name: Type.Literal("pe.tracking-result"),
  version: Type.Literal(1),
}, { additionalProperties: false });

const Delta = Type.Object({
  label: Type.String(),
  from: Type.String(),
  to: Type.String(),
  note: Type.String(),
  tone: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("flat")]),
}, { additionalProperties: false });

const Thesis = Type.Object({
  id: Type.String({ minLength: 1 }),
  statement: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("weakened"),
    Type.Literal("invalidated"),
    Type.Literal("confirmed"),
    Type.Literal("retired"),
  ]),
  change: Type.String(),
  note: Type.String(),
}, { additionalProperties: false });

const Invalidation = Type.Object({
  id: Type.String({ minLength: 1 }),
  thesis_id: Type.String(),
  condition: Type.String(),
  observed: Type.String(),
  triggered: Type.Boolean(),
  action: Type.String(),
}, { additionalProperties: false });

const MonitorCheck = Type.Object({
  id: Type.String({ minLength: 1 }),
  falsifier_id: Type.String(),
  observed: Type.String(),
  status: Type.Union([
    Type.Literal("armed"),
    Type.Literal("warning"),
    Type.Literal("triggered"),
    Type.Literal("unknown"),
  ]),
  note: Type.String(),
}, { additionalProperties: false });

const ModelChange = Type.Object({
  metric: Type.String(),
  sheet: Type.String({ minLength: 1 }),
  cell: Type.String({ minLength: 1 }),
  value: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
  note: Type.String(),
}, { additionalProperties: false });

const ModelOutput = Type.Object({
  label: Type.String(),
  sheet: Type.String({ minLength: 1 }),
  cell: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const Reason = Type.Object({
  tag: Type.String(),
  title: Type.String(),
  detail: Type.String(),
  source: Type.String(),
  impact: Type.String(),
}, { additionalProperties: false });

const Source = Type.Object({
  label: Type.String(),
  date: Type.String(),
}, { additionalProperties: false });

const WritebackChange = Type.Object({
  where: Type.String(),
  from: Type.String(),
  to: Type.String(),
  note: Type.String(),
}, { additionalProperties: false });

const Writeback = Type.Object({
  mode: Type.String(),
  version: Type.String(),
  stats: Type.String(),
  note: Type.String(),
  backup: Type.Optional(Type.String()),
  changes: Type.Optional(Type.Array(WritebackChange)),
  model: Type.Optional(Type.Object({
    file: Type.String(),
    version: Type.Union([Type.Integer(), Type.Null()]),
    backup: Type.Optional(Type.String()),
    changes: Type.Optional(Type.Array(Type.Object({
      metric: Type.String(),
      sheet: Type.String(),
      cell: Type.String(),
      value: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
      note: Type.String(),
    }))),
    outputs: Type.Optional(Type.Array(Type.Object({
      label: Type.String(),
      sheet: Type.String(),
      cell: Type.String(),
      before: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()])),
      after: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()])),
    }))),
  })),
  approval: Type.Optional(Type.Object({
    id: Type.String(),
    status: Type.String(),
    decidedAt: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  })),
}, { additionalProperties: false });

const Decision = Type.Object({
  class: Type.Union([
    Type.Literal("C0"),
    Type.Literal("C1"),
    Type.Literal("C2"),
    Type.Literal("C3"),
    Type.Literal("C4"),
  ]),
  confidence: Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  action: Type.Union([
    Type.Literal("observe"),
    Type.Literal("notify"),
    Type.Literal("propose"),
    Type.Literal("apply"),
  ]),
  reason: Type.String(),
}, { additionalProperties: false });

const Run = Type.Object({
  id: Type.String(),
  trigger: Type.String(),
  startedAt: Type.String(),
  endedAt: Type.String(),
}, { additionalProperties: false });

const Target = Type.Object({
  path: Type.String(),
  base_material_id: Type.Optional(Type.String()),
  base_version: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  result_material_id: Type.Optional(Type.String()),
  result_version: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  write_mode: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const TRACKING_RESULT_SCHEMA = Type.Object({
  schema: SchemaRef,
  status: Type.Union([
    Type.Literal("updated"),
    Type.Literal("no_change"),
    Type.Literal("needs_review"),
    Type.Literal("baseline"),
    Type.Literal("failed"),
  ]),
  run: Type.Optional(Run),
  target: Target,
  headline: Type.String(),
  conclusion: Type.String(),
  summary: Type.String(),
  confidence: Type.String(),
  asOf: Type.Optional(Type.String()),
  duration: Type.Optional(Type.String()),
  decision: Type.Optional(Decision),
  deltas: Type.Array(Delta),
  theses: Type.Array(Thesis),
  invalidations: Type.Array(Invalidation),
  monitorChecks: Type.Array(MonitorCheck),
  modelChanges: Type.Array(ModelChange),
  modelOutputs: Type.Array(ModelOutput),
  reasons: Type.Array(Reason),
  judgment: Type.Optional(Type.Union([
    Type.Object({ title: Type.String(), text: Type.String() }),
    Type.Null(),
  ])),
  sources: Type.Array(Source),
  notUsed: Type.Array(Type.String()),
  writeback: Writeback,
}, { additionalProperties: false });

/**
 * A legacy row predates the schema marker. It can be read, but a fresh write
 * always goes through normalizeTrackingResult, which stamps the version.
 */
function asLegacy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema) return value;
  return {
    ...value,
    schema: { name: "pe.tracking-result", version: 1 },
  };
}

export const TRACKING_RESULT = makeContract(
  "pe.tracking-result",
  1,
  TRACKING_RESULT_SCHEMA,
  { legacy: asLegacy },
);

export const TRACKING_STATUSES = Object.freeze([
  "updated",
  "no_change",
  "needs_review",
  "baseline",
  "failed",
]);
