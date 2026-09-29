/**
 * GET  /api/gateway/workers?orgId=...   — List workers for org
 * POST /api/gateway/workers             — Register a new worker
 *
 * Auth: org member (GET), internal service (POST — workers self-register via service secret)
 */

import { NextRequest } from "next/server";
import {
  getWalletAddress,
  requireOrgMember,
  requireInternalService,
} from "@/lib/auth-guard";
import { registerWorker, getOrgWorkers } from "@/lib/gateway/store";
import type { WorkerStatus } from "@/lib/gateway/types";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  const orgAuth = await requireOrgMember(req, orgId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  const status = req.nextUrl.searchParams.get("status") as WorkerStatus | null;

  try {
    const workers = await getOrgWorkers(orgId, status || undefined);
    return Response.json({ ok: true, workers });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list workers" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    return Response.json({ error: serviceAuth.error }, { status: 401 });
  }

  let body: {
    orgId: string;
    name: string;
    resources: {
      maxCpuCores: number;
      maxMemoryMb: number;
      maxConcurrent: number;
      activeTasks?: number;
    };
    capabilities: {
      taskTypes: string[];
      runtimes: string[];
      tags?: string[];
    };
    region?: string;
    ipAddress?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.name || !body.resources || !body.capabilities) {
    return Response.json(
      { error: "orgId, name, resources, and capabilities are required" },
      { status: 400 },
    );
  }

  if (!body.capabilities.taskTypes?.length) {
    return Response.json(
      { error: "capabilities.taskTypes must contain at least one entry" },
      { status: 400 },
    );
  }

  try {
    const id = await registerWorker({
      orgId: body.orgId,
      name: body.name,
      status: "idle",
      resources: {
        maxCpuCores: body.resources.maxCpuCores,
        maxMemoryMb: body.resources.maxMemoryMb,
        maxConcurrent: body.resources.maxConcurrent,
        activeTasks: body.resources.activeTasks ?? 0,
      },
      capabilities: {
        taskTypes: body.capabilities.taskTypes,
        runtimes: body.capabilities.runtimes || [],
        tags: body.capabilities.tags || [],
      },
      region: body.region,
      ipAddress: body.ipAddress,
    });

    return Response.json({ ok: true, workerId: id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to register worker" },
      { status: 500 },
    );
  }
}
