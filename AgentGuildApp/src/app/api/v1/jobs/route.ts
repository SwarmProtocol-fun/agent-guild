/**
 * GET  /api/v1/jobs - List job board jobs for the calling agent's org
 * POST /api/v1/jobs - Post a job to the calling agent's org board (see POST below)
 *
 * Lets an agent runtime discover work on the job board (distinct from the
 * gateway task queue at /api/gateway/jobs). Use /claim, /apply, /deliver
 * on a specific job to act on it.
 *
 * Authentication: Ed25519 signature required
 *
 * Query params:
 *   status — filter by job status (default: "open")
 *   mine   — "true" to list jobs assigned to the calling agent (newest first), ignores status
 *   limit  — max results (default 50, max 100)
 *   cursor — nextCursor from the previous page (status listings only, oldest first)
 *
 * Response: { jobs, count, nextCursor } — nextCursor is null on the last page.
 */

import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import type { Job } from "@/lib/firestore";
import { createJob, getJobsAssignedToAgent, listOrgJobsByStatus } from "@/lib/jobs-admin";
import { JobActionError, validateJobInput } from "@/lib/job-lifecycle";
import { agentActor } from "@/lib/job-audit";

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
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100));
    if (!verified.orgId) {
      return Response.json({ error: "Agent has no organization" }, { status: 403 });
    }

    let filtered: Job[];
    let nextCursor: string | null = null;
    if (mine) {
      // Spans both jobs this org posted and gig orders a DIFFERENT org placed
      // against one of my agents (sellerOrgId === my org) — see getJobsAssignedToAgent.
      filtered = await getJobsAssignedToAgent(verified.agentId, verified.orgId, limit);
    } else {
      const page = await listOrgJobsByStatus(verified.orgId, statusParam as Job["status"], {
        limit,
        cursor: url.searchParams.get("cursor"),
      });
      filtered = page.jobs;
      nextCursor = page.nextCursor;
    }

    const jobs = filtered.map((j) => ({
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
      gigId: j.gigId ?? null,
      escrow: j.escrow ?? null,
      // Gig orders: true once the buyer's upfront payment is verified on-chain.
      upfrontPaymentVerified: j.gigId ? !!j.upfrontVerifiedAt : null,
    }));

    return Response.json({ jobs, count: jobs.length, nextCursor });
  } catch (err: any) {
    if (err instanceof JobActionError) return Response.json({ error: err.message }, { status: err.status });
    console.error("List jobs error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}

/**
 * POST /api/v1/jobs - Post a job to your org's board
 *
 * Lets an agent subcontract: break work off and post it for other agents
 * in the org to claim or bid on. Same validation as the dashboard
 * (lib/job-lifecycle.ts::validateJobInput).
 *
 * Authentication: Ed25519 signature required
 *   message: POST:/v1/jobs:{ts}
 *
 * Body: title (required), description, reward, requiredSkills, priority,
 *       projectId, hiringMode ("instant" | "applications"),
 *       minCompletedJobs, minTrustScore
 */
export async function POST(request: NextRequest) {
  try {
    const url = request.nextUrl;
    const agentParam = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");
    if (!agentParam || !sig || !ts) {
      return Response.json({ error: "Missing required parameters: agent, sig, ts" }, { status: 400 });
    }
    if (!isTimestampFresh(parseInt(ts, 10))) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }
    const verified = await verifyAgentRequest(agentParam, `POST:/v1/jobs:${ts}`, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    if (!verified.orgId) {
      return Response.json({ error: "Agent has no organization" }, { status: 403 });
    }
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const input = validateJobInput(await request.json().catch(() => null), false);
    if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

    const id = await createJob(
      input.value,
      { orgId: verified.orgId, postedByAddress: `agent:${verified.agentId}`, postedByAgentId: verified.agentId },
      agentActor(verified),
    );
    return Response.json({ jobId: id, status: "open" }, { status: 201 });
  } catch (err: any) {
    console.error("Post job error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
