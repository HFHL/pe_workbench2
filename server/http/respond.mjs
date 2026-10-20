/**
 * HTTP primitives shared by every route. No domain state lives here.
 */

import fs from "node:fs";
import path from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".csv": "text/csv; charset=utf-8",
};

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function sendText(res, status, text, {
  filename = "transcript.txt",
  type = "text/plain; charset=utf-8",
  download = false,
} = {}) {
  const payload = Buffer.from(String(text ?? ""), "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...(download
      ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }
      : {}),
  });
  res.end(payload);
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

export function initSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
}

export function sendSse(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/tracking.css", "tracking.css"],
  ["/suggestions.css", "suggestions.css"],
  ["/app.js", "app.js"],
  ["/tracking.js", "tracking.js"],
  ["/suggestions.js", "suggestions.js"],
  ["/preview.png", "preview.png"],
]);

function safeStaticPath(root, pathname) {
  if (STATIC_FILES.has(pathname)) return path.join(root, STATIC_FILES.get(pathname));
  if (pathname.startsWith("/vendor/")) {
    const rel = pathname.slice("/vendor/".length);
    if (!rel || rel.includes("..")) return null;
    return path.join(root, "node_modules", "marked", "lib", path.basename(rel));
  }
  if (pathname.startsWith("/ui/")) {
    const rel = pathname.slice(1);
    if (!rel || rel.includes("..") || !/\.(js|mjs|css)$/.test(rel)) return null;
    const absolute = path.join(root, rel);
    return absolute.startsWith(path.join(root, "ui") + path.sep) ? absolute : null;
  }
  return null;
}

export async function serveStatic({ root, req, res, pathname }) {
  const filePath = safeStaticPath(root, pathname);
  if (!filePath) return false;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}
