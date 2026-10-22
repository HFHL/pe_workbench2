#!/usr/bin/env node
/**
 * Backfill one already-finished agent session into the model trace.
 *
 * The live hook runs at agent settle. This CLI is for sessions that finished
 * before the hook existed (or after a restart): it reads the Pi JSONL, collects
 * write/edit paths and the final assistant text, then calls the same
 * `trace.recordRun` detection used by the hook.
 *
 * Usage:
 *   node scripts/backfill-trace.mjs --project p-c1db281e --session <session-id>
 *   node scripts/backfill-trace.mjs --project p-c1db281e --session <session-id> --apply
 */

import fs from "node:fs";
import path from "node:path";

import { openStore } from "../store.mjs";
import { createTraceService } from "../lib/trace/service.mjs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const projectId = arg("project");
const sessionId = arg("session");
const apply = process.argv.includes("--apply");
if (!projectId || !sessionId) {
  console.error("usage: node scripts/backfill-trace.mjs --project <id> --session <id> [--apply]");
  process.exit(2);
}

const projectRoot = path.resolve("projects", projectId);
if (!fs.existsSync(projectRoot)) {
  console.error(`project root not found: ${projectRoot}`);
  process.exit(2);
}

const sessionsDir = path.join(projectRoot, ".pi", "sessions");
const sessionFile = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).find((name) => name.includes(sessionId) && name.endsWith(".jsonl"))
  : null;
if (!sessionFile) {
  console.error(`session jsonl not found for ${sessionId}`);
  process.exit(2);
}

function normalize(file) {
  if (typeof file !== "string" || !file.trim()) return null;
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) return null;
  return relative;
}

const changedFiles = new Set();
let finalText = "";
let finalAt = null;
const lines = fs.readFileSync(path.join(sessionsDir, sessionFile), "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  const message = event.message;
  if (!message || message.role !== "assistant") continue;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n").trim();
  if (text) {
    finalText = text;
    finalAt = event.timestamp || finalAt;
  }
  for (const block of blocks) {
    if (block.type === "toolCall" && ["write", "edit"].includes(block.name)) {
      const file = normalize(block.arguments?.path);
      if (file && !file.startsWith(".tracking/") && !file.includes("/backups/")) changedFiles.add(file);
    }
  }
}

if (!changedFiles.size) {
  console.log("no write/edit files found in session");
  process.exit(0);
}

const store = await openStore({
  root: process.cwd(),
  workspace: projectRoot,
  projectId,
  projectName: projectId,
  seed: false,
});
const trace = createTraceService({ store, projectId, projectName: projectId, root: projectRoot });

console.log("session:", sessionId);
console.log("at:", finalAt || "(unknown)");
console.log("files:");
for (const file of changedFiles) console.log("  -", file);
console.log("final text:", finalText.slice(0, 180).replace(/\s+/g, " "), "…");

if (!apply) {
  console.log("\ndry run; add --apply to append the trace entry");
  process.exit(0);
}

const entry = trace.recordRun({
  sessionId,
  runId: `backfill:${sessionId}`,
  changedFiles: [...changedFiles],
  text: finalText,
  at: finalAt || new Date().toISOString(),
});
if (!entry) {
  console.log("\nno trace entry appended (not a valuation change or already recorded)");
  process.exit(0);
}
console.log("\nappended:", entry.seq, entry.kind, entry.title);
console.log("files:", entry.files.map((file) => `${file.name}${file.version ? ` v${file.version}` : ""}`).join(" · "));
console.log("changes:", entry.changes.join(" · "));
