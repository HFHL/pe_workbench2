/**
 * Contract construction shared by every schema module.
 */

import { Value } from "typebox/value";

/**
 * Build a contract object. `schema` is exposed verbatim (JSON Schema) and is
 * annotated with an `$id` so persisted payloads can point at a stable version.
 */
export function makeContract(name, version, schema, { legacy = null } = {}) {
  const versioned = { ...schema, $id: `${name}@v${version}` };
  const contract = {
    name,
    version,
    schema: versioned,
    validate(value, options = {}) {
      let candidate = value;
      if (legacy && options.allowLegacy) {
        candidate = legacy(value);
        if (candidate === null) {
          return {
            ok: false,
            error: "value does not look like a legacy result",
            errors: [{ path: "", message: "not a legacy result" }],
          };
        }
      }
      const ok = Value.Check(versioned, candidate);
      if (ok) return { ok: true, value: candidate, errors: [] };
      const errors = [...Value.Errors(versioned, candidate)].slice(0, 20).map((error) => ({
        path: error.path,
        message: error.message,
      }));
      return {
        ok: false,
        error: `schema validation failed for ${name}@v${version}`,
        errors,
      };
    },
    jsonSchema() {
      return JSON.parse(JSON.stringify(versioned));
    },
  };
  return Object.freeze(contract);
}
