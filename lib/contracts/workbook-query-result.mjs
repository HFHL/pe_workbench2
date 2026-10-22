/**
 * pe.workbook-query.result v1
 *
 * The UI receives this structured subgraph; the agent still receives only the
 * length-limited text in `content`. Never include a whole workbook here.
 */

import { Type } from "typebox";
import { makeContract } from "./core.mjs";

const SchemaRef = Type.Object({
  name: Type.Literal("pe.workbook-query.result"),
  version: Type.Literal(1),
}, { additionalProperties: false });

const Material = Type.Object({
  id: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const CellValue = Type.Object({
  raw: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
  display: Type.String(),
}, { additionalProperties: false });

const Cell = Type.Object({
  ref: Type.String({ minLength: 1 }),
  sheet: Type.String(),
  coord: Type.String(),
  rowLabel: Type.String(),
  columnLabel: Type.String(),
  displayLabel: Type.String(),
  value: CellValue,
  formula: Type.Union([Type.String(), Type.Null()]),
  relation: Type.Union([
    Type.Literal("seed"),
    Type.Literal("upstream"),
    Type.Literal("downstream"),
  ]),
  score: Type.Number(),
  upstreamRefs: Type.Array(Type.String()),
  downstreamRefs: Type.Array(Type.String()),
}, { additionalProperties: false });

export const WORKBOOK_QUERY_RESULT_SCHEMA = Type.Object({
  schema: SchemaRef,
  material: Material,
  query: Type.String(),
  summary: Type.Object({
    matchedCells: Type.Integer({ minimum: 0 }),
    returnedCells: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
  }, { additionalProperties: false }),
  cells: Type.Array(Cell, { maxItems: 200 }),
  warnings: Type.Array(Type.String()),
}, { additionalProperties: false });

export const WORKBOOK_QUERY_RESULT = makeContract(
  "pe.workbook-query.result",
  1,
  WORKBOOK_QUERY_RESULT_SCHEMA,
);
