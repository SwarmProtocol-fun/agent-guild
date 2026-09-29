/**
 * POST /api/gateway/tasks/pull — Worker pulls the next available task
 *
 * Body: { workerId: string }
 * Auth: internal service (workers call via service secret)
 *
 * Returns the claimed task or { ok: true, task: null } if none available.
 */

import { NextRequest } from "next/server";
import { requireInternalService } from "@/lib/auth-guard";
import { pullTask } from "@/lib/gateway/runtime";

export async function POST(req: NextRequest) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  let body: { workerId: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.workerId) {
    return Response.json({ error: "workerId is required" }, { status: 400 });
  }

  try {
    const task = await pullTask(body.workerId);
    return Response.json({ ok: true, task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pull failed";
    const status = msg.includes("not found") ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}
