#!/usr/bin/env node
/**
 * Build only the CopilotKit pilot bundle.
 *
 * Native UI modules stay external and are loaded by the browser's existing ES
 * module graph, so the pilot shares one state/store/renderer instance with the
 * rest of the workbench. @copilotkit/core is bundled; nothing is loaded from a
 * CDN and no "latest" range is involved.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "ui/copilot-pilot/entry.js");
const OUTFILE = path.join(ROOT, "ui/copilot-pilot/pilot.bundle.js");

const SHARED_UI_MODULES = [
  "../state/store.js",
  "../runtime.js",
  "../chat/renderer.js",
  "../shared/toast.js",
  "../api/client.js",
];

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  write: false,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  logLevel: "info",
  external: SHARED_UI_MODULES,
  define: { "process.env.NODE_ENV": '"production"' },
});

const text = result.outputFiles?.[0]?.text || "";
const externalCount = SHARED_UI_MODULES.filter((mod) => text.includes(`from"${mod}"`)).length;
if (externalCount !== SHARED_UI_MODULES.length) {
  throw new Error(
    `pilot bundle inlined a shared UI module (${externalCount}/${SHARED_UI_MODULES.length}); ` +
    "that would create a second state/store instance. Check the external list.",
  );
}
fs.writeFileSync(OUTFILE, text);

const bytes = Buffer.byteLength(text);
const gzip = zlib.gzipSync(text).length;
console.log(`\nCopilotKit pilot bundle: ${OUTFILE}`);
console.log(`  bytes: ${bytes} (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`  gzip:  ${gzip} (${(gzip / 1024).toFixed(1)} KiB)`);
console.log(`  shared UI modules kept external: ${externalCount}/${SHARED_UI_MODULES.length}`);
console.log(`  bundled inputs: ${Object.keys(result.metafile.inputs).length}`);

for (const marker of ["https://api.deepseek.com", "https://telemetry.copilotkit.ai", "https://cdn.copilotkit.ai"]) {
  if (text.includes(marker)) console.log(`  note: bundle contains literal ${marker} (not necessarily a request)`);
}
