/**
 * Delete every material, version, plan, run, blob and workspace data file.
 * Keeps: sessions (agent-workspace/.pi), AGENTS.md, DB schema, workspace row.
 *
 * Usage: stop the server, then `npm run reset:materials`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.join(ROOT, "agent-workspace");
const DATA = path.join(ROOT, "data");
const DB_PATH = path.join(DATA, "workbench.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`no database at ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("create table if not exists meta (key text primary key, value text not null)");

db.exec("BEGIN");
try {
  db.exec("delete from plan_runs");
  db.exec("delete from plan_inputs");
  db.exec("delete from plans");
  db.exec("delete from material_links");
  db.exec("delete from material_versions");
  db.exec("delete from materials");
  db.prepare("insert or replace into meta (key, value) values ('seeded', '1')").run();
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.exec("VACUUM");
db.close();

function clearDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

let files = 0;
for (const dir of ["exports", "inputs", "uploads"]) {
  files += clearDir(path.join(WORKSPACE, dir));
}

for (const entry of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name === "AGENTS.md" || entry.name.startsWith(".")) continue;
  fs.rmSync(path.join(WORKSPACE, entry.name), { force: true });
  files += 1;
}

const blobs = clearDir(path.join(DATA, "blobs"));

console.log(`materials/plans cleared · ${files} workspace files removed · ${blobs} blob entries removed`);
console.log("kept: sessions, AGENTS.md, schema, workspace record");
