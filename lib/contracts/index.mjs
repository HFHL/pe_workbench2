/**
 * Versioned JSON-schema contracts shared by tool producers and UI consumers.
 *
 * TypeBox is the single source of truth: the TypeBox schema is also a valid
 * JSON Schema, so it can be emitted to the browser and used for consumer-side
 * validation without maintaining a second hand-written schema.
 */


import { makeContract } from "./core.mjs";
import { WORKBOOK_QUERY_RESULT } from "./workbook-query-result.mjs";
import { MODEL_CHANGE_PROPOSAL } from "./model-change-proposal.mjs";
import { TRACKING_RESULT } from "./tracking-result.mjs";

export const TOOL_PRESENTATION_SCHEMAS = Object.freeze([
  WORKBOOK_QUERY_RESULT,
  MODEL_CHANGE_PROPOSAL,
  TRACKING_RESULT,
]);

const byKey = new Map(
  TOOL_PRESENTATION_SCHEMAS.map((contract) => [`${contract.name}@${contract.version}`, contract]),
);

export function contractFor(name, version) {
  return byKey.get(`${name}@${version}`) || null;
}

export function presentationSchema(name, version) {
  return contractFor(name, version)?.schema || null;
}

export function validateContract(name, version, value, options = {}) {
  const contract = contractFor(name, version);
  if (!contract) {
    return {
      ok: false,
      error: `unknown schema: ${name}@${version}`,
      errors: [{ path: "", message: `unknown schema ${name}@${version}` }],
    };
  }
  return contract.validate(value, options);
}

/**
 * Build a contract object. `schema` is exposed verbatim (JSON Schema) and is
 * annotated with an `$id` so persisted payloads can point at a stable version.
 */
function unwrapEnvelope(result) {
  if (!result || typeof result !== "object") return null;
  const candidates = [
    result.details?.presentation,
    result.details?.structuredContent,
    result.structuredContent,
    result.presentation,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate;
  }
  return null;
}

/**
 * Extract and validate the UI-only payload from a Pi tool result.
 *
 * Pi only forwards `content` text to the model; `details` (or
 * `structuredContent`) is the side channel the host persists. A malformed
 * payload is rejected here so a broken tool call can never take down a whole
 * message or the page.
 */
export function extractPresentation(result) {
  const envelope = unwrapEnvelope(result);
  if (!envelope) return { ok: false, error: "tool result has no structured presentation" };
  const name = envelope.schema?.name || envelope.schemaName;
  const version = Number(envelope.schema?.version ?? envelope.schemaVersion);
  if (!name || !Number.isFinite(version)) {
    return { ok: false, error: "presentation is missing schema name/version" };
  }
  const contract = contractFor(name, version);
  if (!contract) {
    return { ok: false, error: `unknown presentation schema ${name}@${version}`, schemaName: name, schemaVersion: version };
  }
  const payload = envelope.payload;
  const validation = contract.validate(payload);
  if (!validation.ok) {
    return {
      ok: false,
      error: `${validation.error}: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`,
      schemaName: name,
      schemaVersion: version,
      errors: validation.errors,
    };
  }
  return {
    ok: true,
    schemaName: name,
    schemaVersion: version,
    payload: validation.value,
  };
}

/**
 * Wrap a validated payload in the tool-result envelope. Producers call this
 * after validating; it never serializes the payload into model-visible text.
 */
export function presentationResult({ schema, payload, text, isError = false }) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    details: {
      presentation: {
        schema: { name: schema.name, version: schema.version },
        payload,
      },
    },
    ...(isError ? { isError: true } : {}),
  };
}

export { makeContract };

export {
  MODEL_CHANGE_PROPOSAL,
  TRACKING_RESULT,
  WORKBOOK_QUERY_RESULT,
};
