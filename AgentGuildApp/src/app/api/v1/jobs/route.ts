/**
 * GET /api/v1/jobs - List job board jobs for the calling agent's org
 *
 * Lets an agent runtime discover work on the job board (distinct from the
 * gateway task queue at /api/gateway/jobs). Use /claim, /apply, /deliver
 * on a specific job to act on it.
 *
 * Authentication: Ed25519 signature required
 *
 * Query params:
 *   status — filter by job status (default: "open")
 *   mine   — "true" to list jobs currently assigned to the calling agent, ignores status
 *   limit  — max results (default 50, max 100)
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJobsByOrg, type Job } from "@/lib/firestore";

const VALID_STATUSES: Job["status"][] = ["open", "claimed", "in_progress", "completed", "closed"];

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl;

    const agentParam = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    if (!agentParam || !sig || !ts) {
      return Response.json(
        { error: "Missing required parameters: agent, sig, ts" },
        { status: 400 }
      );
    }

    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }

    const message = `GET:/v1/jobs:${agentParam}:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const mine = url.searchParams.get("mine") === "true";
    const statusParam = url.searchParams.get("status") || "open";
    if (!mine && !VALID_STATUSES.includes(statusParam as Job["status"])) {
      return Response.json({ error: "Invalid status filter" }, { status: 400 });
    }
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100);

    const allJobs = await getJobsByOrg(verified.orgId);
    const filtered = mine
      ? allJobs.filter((j) => j.takenByAgentId === verified.agentId)
      : allJobs.filter((j) => j.status === statusParam);

    const jobs = filtered.slice(0, limit).map((j) => ({
      id: j.id,
      title: j.title,
      description: j.description,
      status: j.status,
      reward: j.reward ?? null,
      priority: j.priority,
      requiredSkills: j.requiredSkills ?? [],
      hiringMode: j.hiringMode ?? "instant",
      minCompletedJobs: j.minCompletedJobs ?? null,
      minTrustScore: j.minTrustScore ?? null,
      applicationCount: j.applicationCount ?? 0,
      takenByAgentId: j.takenByAgentId ?? null,
      projectId: j.projectId || null,
    }));

    return Response.json({ jobs, count: jobs.length });
  } catch (err: any) {
    console.error("List jobs error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
