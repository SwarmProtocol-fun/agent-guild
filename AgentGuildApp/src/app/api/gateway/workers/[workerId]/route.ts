/**
 * GET    /api/gateway/workers/:workerId               — Get worker details
 * PATCH  /api/gateway/workers/:workerId               — Update worker (status, resources)
 * DELETE /api/gateway/workers/:workerId               — Deregister worker
 * POST   /api/gateway/workers/:workerId               — Heartbeat (POST with body)
 *
 * Auth: internal service (workers call via service secret)
 */

import { NextRequest } from "next/server";
import { requireInternalService } from "@/lib/auth-guard";
import {
  getWorker,
  updateWorker,
  deregisterWorker,
  heartbeatWorker,
} from "@/lib/gateway/store";

interface RouteContext {
  params: Promise<{ workerId: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  const { workerId } = await ctx.params;
  const worker = await getWorker(workerId);
  if (!worker) {
    return Response.json({ error: "Worker not found" }, { status: 404 });
  }

  return Response.json({ ok: true, worker });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  const { workerId } = await ctx.params;
  const worker = await getWorker(workerId);
  if (!worker) {
    return Response.json({ error: "Worker not found" }, { status: 404 });
  }

  let body: {
    resources?: Partial<{
      cpuUsagePercent: number;
      memoryUsageMb: number;
      activeTasks: number;
    }>;
  };

  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    await heartbeatWorker(workerId, body.resources);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Heartbeat failed" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  const { workerId } = await ctx.params;
  const worker = await getWorker(workerId);
  if (!worker) {
    return Response.json({ error: "Worker not found" }, { status: 404 });
  }

  let body: {
    status?: "idle" | "busy" | "draining" | "offline";
    resources?: Partial<typeof worker.resources>;
    capabilities?: Partial<typeof worker.capabilities>;
    region?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await updateWorker(workerId, {
      ...(body.status && { status: body.status }),
      ...(body.resources && { resources: { ...worker.resources, ...body.resources } }),
      ...(body.capabilities && { capabilities: { ...worker.capabilities, ...body.capabilities } }),
      ...(body.region !== undefined && { region: body.region }),
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  const { workerId } = await ctx.params;

  try {
    await deregisterWorker(workerId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Deregister failed" },
      { status: 500 },
    );
  }
}
