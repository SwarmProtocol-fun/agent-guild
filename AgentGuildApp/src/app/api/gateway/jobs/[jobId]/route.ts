/**
 * GET /api/gateway/jobs/{jobId} — Get job details + worker info
 *
 * Auth: org member (wallet session) OR internal service
 */

import { NextRequest } from "next/server";
import {
  getWalletAddress,
  requireOrgMember,
  requireInternalService,
} from "@/lib/auth-guard";
import { getTask, getWorker } from "@/lib/gateway/store";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { jobId } = await ctx.params;

  // Fetch the task first to determine orgId
  const task = await getTask(jobId);
  if (!task) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  // Auth: internal service OR org member
  const serviceAuth = requireInternalService(req);
  if (!serviceAuth.ok) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const orgAuth = await requireOrgMember(req, task.orgId);
    if (!orgAuth.ok) {
      return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
    }
  }

  try {
    // Fetch worker info if task is claimed
    let worker = null;
    if (task.claimedBy) {
      worker = await getWorker(task.claimedBy);
    }

    return Response.json({
      ok: true,
      job: task,
      worker: worker
        ? {
            id: worker.id,
            name: worker.name,
            status: worker.status,
            region: worker.region,
            resources: worker.resources,
          }
        : null,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to get job" },
      { status: 500 },
    );
  }
}
