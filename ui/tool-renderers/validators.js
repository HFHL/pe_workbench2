/** Consumer-side structural validators (mirror the server JSON schemas). */

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function validateWorkbookPayload(payload) {
  if (!isObject(payload)) return "payload is not an object";
  if (!isObject(payload.material) || !payload.material.id || !payload.material.path) return "missing material";
  if (!isObject(payload.summary)) return "missing summary";
  if (!Array.isArray(payload.cells)) return "missing cells";
  for (const cell of payload.cells) {
    if (!isObject(cell) || !cell.ref) return "cell is missing ref";
    if (!isObject(cell.value) || !isScalar(cell.value.raw) || typeof cell.value.display !== "string") {
      return "cell value is malformed";
    }
    if (!["seed", "upstream", "downstream"].includes(cell.relation)) return "cell relation is invalid";
    if (!Array.isArray(cell.upstreamRefs) || !Array.isArray(cell.downstreamRefs)) return "cell refs are invalid";
  }
  if (!Array.isArray(payload.warnings)) return "missing warnings";
  return "";
}

export function validateProposalPayload(payload) {
  if (!isObject(payload)) return "payload is not an object";
  if (!payload.proposalId) return "missing proposalId";
  if (!isObject(payload.workingModel)) return "missing workingModel";
  if (!Array.isArray(payload.changes) || !payload.changes.length) return "missing changes";
  for (const change of payload.changes) {
    if (!isObject(change) || !change.ref) return "change is missing ref";
    if (!("from" in change) || !("to" in change)) return "change is missing from/to";
  }
  if (!Array.isArray(payload.outputsToVerify)) return "missing outputsToVerify";
  if (!isObject(payload.validation)) return "missing validation";
  return "";
}

export function validateTrackingPayload(payload) {
  if (!isObject(payload)) return "payload is not an object";
  if (!payload.status || !payload.target) return "missing status/target";
  for (const key of ["deltas", "theses", "invalidations", "monitorChecks", "modelChanges", "sources"]) {
    if (!Array.isArray(payload[key])) return `missing ${key}`;
  }
  if (!isObject(payload.writeback)) return "missing writeback";
  return "";
}
