import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handlePlans({ req, res, url, app, ctx }) {
  const { json } = app.http;
  const { broadcastPlan, runPlan } = app;
  const pathname = url.pathname;
  if (pathname === "/api/plans" && req.method === "GET") {
    return json(res, 200, ctx.store.listPlans());
  }


  const planMatch = pathname.match(/^\/api\/plans\/([^/]+)\/(toggle|run)$/);
  if (planMatch) {
    const planId = decodeURIComponent(planMatch[1]);
    if (planMatch[2] === "toggle" && req.method === "POST") {
      const plan = ctx.store.togglePlan(planId);
      if (!plan) return json(res, 404, { error: "plan not found" });
      broadcastPlan(plan, ctx.id);
      return json(res, 200, plan);
    }
    if (planMatch[2] === "run" && req.method === "POST") {
      try {
        const result = await runPlan(ctx, planId);
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
  }

  return json(res, 404, { error: "not found" });
}
