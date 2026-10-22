import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleMaterials({ req, res, url, app, ctx }) {
  const { json, readJson, sendText, MIME } = app.http;
  const { withAsr, warmWorkbook, warmPdf, warmAsr, ingestUploadEvent, serveVersionFile, broadcastGlobal, nowIso, WORKBOOK_QUERY, PDF_READ, ASR_ENABLED } = app;
  const pathname = url.pathname;
  if (pathname === "/api/materials" && req.method === "GET") {
    return json(res, 200, ctx.store.listMaterials().map((material) => withAsr(ctx, material)));
  }

  /* ---------- ASR ---------- */

  const asrRoute = pathname.match(/^\/api\/materials\/([^/]+)\/asr$/);
  if (asrRoute) {
    if (!ctx.asr) return json(res, 404, { error: "语音转写未启用", code: "disabled" });
    let materialId;
    try {
      materialId = decodeURIComponent(asrRoute[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    try {
      if (req.method === "GET") {
        return json(res, 200, ctx.asr.get(materialId));
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const version = body.version != null ? Number(body.version) : null;
        const result = ctx.asr.start(materialId, {
          versionNumber: Number.isFinite(version) ? version : null,
          force: Boolean(body.force),
          notify: false,
        });
        const material = ctx.store.getMaterial(materialId);
        if (material) broadcastMaterial(material, ctx.id);
        return json(res, 202, { ok: true, asr: result });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }

  const versionAsrRoute = pathname.match(
    /^\/api\/materials\/([^/]+)\/versions\/(\d+)\/asr(?:\/(content))?$/,
  );
  if (versionAsrRoute) {
    if (!ctx.asr) return json(res, 404, { error: "语音转写未启用", code: "disabled" });
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    try {
      materialId = decodeURIComponent(versionAsrRoute[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionAsrRoute[2]);
    try {
      if (versionAsrRoute[3] === "content") {
        const format = url.searchParams.get("format") === "srt" ? "srt" : "txt";
        const payload = ctx.asr.contentText(materialId, version, format);
        const stem = payload.name.replace(/\.[^.]+$/, "");
        return sendText(res, 200, payload.text, {
          filename: `${stem}.${payload.ext}`,
          type: format === "srt" ? "application/x-subrip; charset=utf-8" : "text/plain; charset=utf-8",
        });
      }
      return json(res, 200, ctx.asr.get(materialId, version));
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }


  const workbookMatch = pathname.match(/^\/api\/materials\/([^/]+)\/(workbook|query)$/);
  if (workbookMatch) {
    if (!WORKBOOK_QUERY) {
      return json(res, 404, { error: "workbook query is disabled", code: "disabled" });
    }
    const materialId = decodeURIComponent(workbookMatch[1]);

    if (workbookMatch[2] === "workbook" && req.method === "GET") {
      try {
        return json(res, 200, await ctx.workbooks.summary(materialId));
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message,
          code: error.code,
        });
      }
    }

    if (workbookMatch[2] === "query" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const result = await ctx.workbooks.queryMaterial(materialId, body.query, {
          maxCells: body.maxCells,
        });
        return json(res, 200, result);
      } catch (error) {
        return json(res, error.status || 500, {
          error: error.message,
          code: error.code,
        });
      }
    }
  }

  const pdfMatch = pathname.match(/^\/api\/materials\/([^/]+)\/pdf(?:\/(search))?$/);
  if (pdfMatch) {
    if (!PDF_READ) {
      return json(res, 404, { error: "pdf reading is disabled", code: "disabled" });
    }
    let materialId;
    try {
      materialId = decodeURIComponent(pdfMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    try {
      if (pdfMatch[2] === "search" && req.method === "POST") {
        const body = await readJson(req);
        return json(res, 200, await ctx.pdfs.search(materialId, body.query, {
          maxSnippets: body.maxSnippets,
        }));
      }
      if (!pdfMatch[2] && req.method === "GET") {
        return json(res, 200, await ctx.pdfs.summary(materialId));
      }
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  const versionPdfMatch = pathname.match(/^\/api\/materials\/([^/]+)\/versions\/(\d+)\/pdf$/);
  if (versionPdfMatch) {
    if (!PDF_READ) {
      return json(res, 404, { error: "pdf reading is disabled", code: "disabled" });
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    try {
      materialId = decodeURIComponent(versionPdfMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionPdfMatch[2]);
    const page = url.searchParams.get("page") || "";
    const query = url.searchParams.get("query") || "";
    const maxChars = Math.min(40000, Math.max(1000, Number(url.searchParams.get("maxChars")) || 12000));
    try {
      if (query) {
        return json(res, 200, await ctx.pdfs.search(materialId, query, { versionNumber: version }));
      }
      if (page) {
        return json(res, 200, await ctx.pdfs.readPages(materialId, page, {
          versionNumber: version,
          maxChars,
        }));
      }
      return json(res, 200, await ctx.pdfs.summary(materialId, version));
    } catch (error) {
      return json(res, error.status || 500, { error: error.message, code: error.code });
    }
  }

  const versionPreviewMatch = pathname.match(
    /^\/api\/materials\/([^/]+)\/versions\/(\d+)\/workbook(?:\/sheets\/(.+))?$/,
  );
  if (versionPreviewMatch) {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    let materialId;
    let sheetName = null;
    try {
      materialId = decodeURIComponent(versionPreviewMatch[1]);
      sheetName = versionPreviewMatch[3] ? decodeURIComponent(versionPreviewMatch[3]) : null;
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    const version = Number(versionPreviewMatch[2]);
    try {
      const payload = sheetName
        ? await ctx.previews.sheet(materialId, version, sheetName)
        : await ctx.previews.manifest(materialId, version);
      return json(res, 200, payload);
    } catch (error) {
      return json(res, error.status || 500, {
        error: error.message,
        code: error.code,
      });
    }
  }

  const versionFileMatch = pathname.match(/^\/api\/materials\/([^/]+)\/versions\/(\d+)\/file$/);
  if (versionFileMatch) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "method not allowed" });
    }
    let materialId;
    try {
      materialId = decodeURIComponent(versionFileMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid path encoding" });
    }
    return serveVersionFile(ctx, req, res, url, materialId, Number(versionFileMatch[2]));
  }

  const materialMatch = pathname.match(/^\/api\/materials\/([^/]+)(?:\/versions\/(\d+)\/restore)?$/);
  if (materialMatch) {
    const materialId = decodeURIComponent(materialMatch[1]);
    const version = materialMatch[2] ? Number(materialMatch[2]) : null;

    if (version && req.method === "POST") {
      let material = ctx.store.restoreVersion(materialId, version);
      if (!material) return json(res, 404, { error: "version not found" });
      material = await warmAsr(ctx, material);
      broadcastMaterial(material, ctx.id);
      warmWorkbook(ctx, material);
      warmPdf(ctx, material);
      return json(res, 200, withAsr(ctx, material));
    }
    if (req.method === "GET") {
      const material = ctx.store.getMaterial(materialId);
      return material
        ? json(res, 200, withAsr(ctx, material))
        : json(res, 404, { error: "material not found" });
    }
    if (req.method === "DELETE") {
      const removed = ctx.store.deleteMaterial(materialId);
      if (!removed) return json(res, 404, { error: "material not found" });
      broadcastGlobal({ type: "material.deleted", id: materialId }, ctx.id);
      return json(res, 200, { ok: true });
    }
  }


  if (pathname === "/api/upload" && req.method === "POST") {
    const rawName = decodeURIComponent(req.headers["x-file-name"] || "upload.bin");
    const base = path.basename(rawName).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 120) || "upload.bin";
    // Two hours of WAV is large; audio gets a higher ceiling than documents.
    const ext = path.extname(base).slice(1).toLowerCase();
    const limit = AUDIO_EXTS.has(ext) ? 120 * 1024 * 1024 : 30 * 1024 * 1024;
    const body = await readBody(req, limit);
    if (!body.length) return json(res, 400, { error: "empty file" });
    const filename = `${Date.now()}-${base}`;
    const target = path.join(ctx.uploadsDir, filename);
    await fsp.writeFile(target, body);
    const rel = path.relative(ctx.root, target).split(path.sep).join("/");
    let material = ctx.store.indexFile(rel, {
      kind: "input",
      source: "upload",
      author: "林默",
      note: "上传",
      status: "synced",
      desc: "本机上传",
    });
    material = await warmAsr(ctx, material);
    broadcastMaterial(material, ctx.id);
    warmWorkbook(ctx, material);
    warmPdf(ctx, material);
    void ingestUploadEvent(ctx, material, base);
    return json(res, 201, {
      name: base,
      path: rel,
      size: body.length,
      material: withAsr(ctx, material),
    });
  }

  if (pathname === "/api/file" && req.method === "GET") {
    const requested = url.searchParams.get("path") || "";
    const absolute = path.resolve(ctx.root, requested);
    if (!absolute.startsWith(ctx.root + path.sep)) return json(res, 403, { error: "forbidden" });
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile()) return json(res, 404, { error: "not a file" });
      const ext = path.extname(absolute).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      const download = url.searchParams.get("download") === "1";
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
        ...(download
          ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}` }
          : {}),
      });
      fs.createReadStream(absolute).pipe(res);
    } catch {
      json(res, 404, { error: "not found" });
    }
    return;
  }


  return json(res, 404, { error: "not found" });
}
