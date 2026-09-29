/**
 * POST /api/gateway/tasks/:taskId/status — Worker reports task status
 *
 * Body: { workerId: string, status: "running" | "completed" | "failed", result?: unknown, error?: string }
 * Auth: internal service (workers call via service secret)
 */

import { NextRequest } from "next/server";
import { requireInternalService } from "@/lib/auth-guard";
import {
  reportTaskRunning,
  reportTaskComplete,
  reportTaskFailed,
} from "@/lib/gateway/runtime";

interface RouteContext {
  params: Promise<{ taskId: string }>;
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  const { taskId } = await ctx.params;

  let body: {
    workerId: string;
    status: "running" | "completed" | "failed";
    result?: unknown;
    error?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.workerId || !body.status) {
    return Response.json(
      { error: "workerId and status are required" },
      { status: 400 },
    );
  }

  const validStatuses = ["running", "completed", "failed"];
  if (!validStatuses.includes(body.status)) {
    return Response.json(
      { error: `status must be one of: ${validStatuses.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    switch (body.status) {
      case "running":
        await reportTaskRunning(body.workerId, taskId);
        break;
      case "completed":
        await reportTaskComplete(body.workerId, taskId, body.result);
        break;
      case "failed":
        await reportTaskFailed(body.workerId, taskId, body.error || "Unknown error");
        break;
    }

    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Status report failed";
    const status = msg.includes("not found") || msg.includes("not claimed") ? 400 : 500;
    return Response.json({ error: msg }, { status });
  }
}
