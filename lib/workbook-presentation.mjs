/**
 * Adapt the existing workbook graph query result into the versioned
 * pe.workbook-query.result payload consumed by the UI.
 *
 * `lib/workbook-query.mjs` stays the retrieval implementation; this module only
 * narrows its rows into the stable contract shape and never includes the whole
 * workbook.
 */

import { WORKBOOK_QUERY_RESULT } from "./contracts/workbook-query-result.mjs";
import { displayValue } from "./workbook-query.mjs";

export function workbookPresentationFromQuery(result, {
  material,
  warnings = [],
} = {}) {
  const payload = {
    schema: { name: "pe.workbook-query.result", version: 1 },
    material: {
      id: String(material?.id || ""),
      path: String(material?.path || ""),
      version: Number(material?.version || 0),
      sha256: String(material?.sha256 || result?.sha256 || ""),
    },
    query: String(result?.query || ""),
    summary: {
      matchedCells: Number(result?.matchedCells || 0),
      returnedCells: Number(result?.cells?.length || 0),
      truncated: Boolean(result?.truncated),
    },
    cells: (result?.cells || []).map((cell) => ({
      ref: String(cell.ref || cell.id || ""),
      sheet: String(cell.sheet || ""),
      coord: String(cell.coord || ""),
      rowLabel: String(cell.rowLabel || ""),
      columnLabel: String(cell.columnLabel || ""),
      displayLabel: String(cell.displayLabel || cell.label || ""),
      value: {
        raw: cell.value === undefined ? null : cell.value,
        display: String(cell.display ?? displayValue(cell.value)),
      },
      formula: cell.formula === undefined ? null : cell.formula,
      relation: cell.relation === "upstream" || cell.relation === "downstream"
        ? cell.relation
        : "seed",
      score: Number(cell.score || 0),
      upstreamRefs: (cell.upstreamRefs || []).map(String),
      downstreamRefs: (cell.downstreamRefs || []).map(String),
    })),
    warnings: (warnings || []).map(String),
  };

  const validation = WORKBOOK_QUERY_RESULT.validate(payload);
  if (!validation.ok) {
    const detail = validation.errors.map((item) => `${item.path} ${item.message}`).join("; ");
    throw Object.assign(new Error(`workbook presentation invalid: ${detail}`), {
      status: 500,
      code: "invalid_workbook_presentation",
    });
  }
  return payload;
}

export default workbookPresentationFromQuery;
