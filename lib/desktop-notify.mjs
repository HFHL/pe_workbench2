/**
 * Best-effort desktop notification on macOS. In-app notifications are the
 * source of truth; this is only a nudge when the user is away from the page.
 *
 * Disable with NOTIFY_DESKTOP=0.
 */

import { execFile } from "node:child_process";

function clean(value, limit = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/["\\]/g, " ")
    .trim()
    .slice(0, limit);
}

export function notifyDesktop({ title, body = "", subtitle = "" } = {}) {
  if (process.env.NOTIFY_DESKTOP === "0") return false;
  if (process.platform !== "darwin") return false;
  const safeTitle = clean(title, 120);
  if (!safeTitle) return false;
  const safeBody = clean(body, 240);
  const safeSubtitle = clean(subtitle, 80);
  const parts = [`display notification "${safeBody}" with title "${safeTitle}"`];
  if (safeSubtitle) parts.push(`subtitle "${safeSubtitle}"`);
  try {
    execFile("osascript", ["-e", parts.join(" ")], { timeout: 5_000 }, () => {});
    return true;
  } catch {
    return false;
  }
}
