/**
 * pe.model-change.proposal v1
 *
 * A proposal is durable evidence that a model write still needs a human. It
 * records the exact baseline, the verified input cells, and the outputs that
 * must be recalculated before anything can be applied.
 */

import { Type } from "typebox";
import { makeContract } from "./core.mjs";

const STATUS = [
  "pending_approval",
  "approved",
  "applying",
  "applied",
  "rejected",
  "conflict",
  "failed",
];

const Baseline = Type.Object({
  materialId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  baseVersion: Type.Integer({ minimum: 1 }),
  baseSha256: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const Change = Type.Object({
  metric: Type.String(),
  ref: Type.String({ minLength: 1 }),
  from: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
  to: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
  bindingVerified: Type.Boolean(),
  formulaCell: Type.Boolean(),
  reason: Type.String(),
  source: Type.String(),
}, { additionalProperties: false });

const Output = Type.Object({
  label: Type.String(),
  ref: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const Validation = Type.Object({
  writeEnabled: Type.Boolean(),
  allBindingsVerified: Type.Boolean(),
  allTargetsAreLiteralInputs: Type.Boolean(),
  libreOfficeAvailable: Type.Boolean(),
}, { additionalProperties: false });

export const MODEL_CHANGE_PROPOSAL_SCHEMA = Type.Object({
  schema: Type.Object({
    name: Type.Literal("pe.model-change.proposal"),
    version: Type.Literal(1),
  }, { additionalProperties: false }),
  proposalId: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
  threadId: Type.String(),
  runId: Type.String(),
  trackingId: Type.String(),
  workingModel: Baseline,
  changes: Type.Array(Change, { minItems: 1 }),
  outputsToVerify: Type.Array(Output, { minItems: 1 }),
  validation: Validation,
  status: Type.Union(STATUS.map((value) => Type.Literal(value))),
  createdAt: Type.String(),
  updatedAt: Type.Optional(Type.String()),
  decidedAt: Type.Optional(Type.String()),
  appliedAt: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const MODEL_CHANGE_PROPOSAL = makeContract(
  "pe.model-change.proposal",
  1,
  MODEL_CHANGE_PROPOSAL_SCHEMA,
);

export const PROPOSAL_STATUSES = Object.freeze(STATUS);
