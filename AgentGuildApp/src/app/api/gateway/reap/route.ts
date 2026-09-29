/**
 * POST /api/gateway/reap — Reap timed-out tasks for an org
 *
 * Body: { orgId: string }
 * Auth: internal service (called by cron job)
 */

import { NextRequest } from "next/server";
import { requireInternalService } from "@/lib/auth-guard";
import { reapTimedOutTasks } from "@/lib/gateway/runtime";

export async function POST(req: NextRequest) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  let body: { orgId: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const reaped = await reapTimedOutTasks(body.orgId);
    return Response.json({ ok: true, reaped });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Reap failed" },
      { status: 500 },
    );
  }
}
