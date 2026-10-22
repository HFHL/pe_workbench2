/**
 * npm start entry point.
 *
 * All wiring lives in server/create-app.mjs. Importing this file starts the
 * process by design; importing a module under server/ never listens.
 */

import { loadConfig } from "./server/config.mjs";
import { createWorkbench } from "./server/create-app.mjs";

const config = await loadConfig();

if (!config.fakeAgent && !process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set (put it in .env.local or the environment)");
  process.exit(1);
}
if (!config.fakeAgent && !config.model) {
  console.error(`Unknown model: ${config.modelId}`);
  process.exit(1);
}
if (config.calcInfo.available) {
  console.log(`calc: ${config.calcInfo.version} · ${config.calcInfo.bin}`);
} else {
  console.warn("calc: LibreOffice not found; model write-back stays propose-only");
}

const workbench = await createWorkbench({ config });
await workbench.listen();

async function shutdown() {
  try {
    await workbench.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
