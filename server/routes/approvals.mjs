import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleApprovals({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const pathname = url.pathname;
  if (pathname === "/api/approvals" && req.method === "GET") {
    return json(res, 200, ctx.approvals.list({
      threadId: url.searchParams.get("threadId") || null,
      trackingId: url.searchParams.get("trackingId") || null,
      status: url.searchParams.get("status") || null,
      limit: Number(url.searchParams.get("limit") || 100),
    }));
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)(?:\/(approve|reject))?$/);
  if (approvalMatch) {
    let approvalId;
    try {
      approvalId = decodeURIComponent(approvalMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid approval id" });
    }
    const action = approvalMatch[2];
    if (!action && req.method === "GET") {
      const approval = ctx.approvals.get(approvalId);
      return approval ? json(res, 200, approval) : json(res, 404, { error: "approval not found" });
    }
    if (action === "approve" && req.method === "POST") {
      const result = await ctx.approvals.approve({ ctx, id: approvalId });
      return json(res, result.httpStatus || (result.ok ? 200 : 500), {
        ok: result.ok,
        ...(result.error ? { error: result.error, code: result.code } : {}),
        ...(result.already ? { already: true } : {}),
        ...(result.pending ? { pending: true } : {}),
        approval: result.approval,
        ...(result.tracking ? { tracking: result.tracking } : {}),
        ...(result.material ? { material: result.material } : {}),
      });
    }
    if (action === "reject" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const result = await ctx.approvals.reject({
        ctx,
        id: approvalId,
        reason: String(body?.reason || ""),
      });
      return json(res, result.httpStatus || (result.ok ? 200 : 500), {
        ok: result.ok,
        ...(result.error ? { error: result.error, code: result.code } : {}),
        ...(result.already ? { already: true } : {}),
        ...(result.pending ? { pending: true } : {}),
        approval: result.approval,
        ...(result.tracking ? { tracking: result.tracking } : {}),
      });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  return json(res, 404, { error: "not found" });
}
