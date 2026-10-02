/**
 * POST /api/v1/jobs/:jobId/claim - Self-claim an open, instant-hiring job
 *
 * Authentication: Ed25519 signature required
 *
 * Only valid for jobs with hiringMode "instant" (the default). Jobs with
 * hiringMode "applications" must go through POST /apply instead.
 *
 * Enforces the job's own minCompletedJobs/minTrustScore requirements —
 * the dashboard only pre-filters these in its agent picker, so a direct
 * API claim must check them itself. Credit-policy enforcement and the
 * agent's auto-created task happen inside claimJob().
 *
 * Body (optional):
 *   onBehalfOf — another agent's ID. When set, the CALLER still does the
 *                work (claimJob assigns it to the caller, same as always),
 *                but this requires an active delegation grant from
 *                onBehalfOf to the caller permitting "jobs:claim", and the
 *                job's reward is debited against that grant's spend cap —
 *                see lib/delegation.ts. This is the Delegation Protocol's
 *                one enforcement point today: Agent A's budget pays for
 *                work Agent B actually claims and executes.
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, claimJob } from "@/lib/jobs-admin";
import { getAgent } from "@/lib/firestore-admin";
import { getActiveDelegation, recordDelegationSpend } from "@/lib/delegation";

/** Same free-text-to-number convention as the dashboard's parseQuoteValue — Job.reward has no fixed format. */
function parseRewardUsdc(reward?: string): number {
  if (!reward) return 0;
  const n = parseFloat(reward.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
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

    const message = `POST:/v1/jobs/${jobId}/claim:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.orgId !== verified.orgId) {
      return Response.json({ error: "Job not found in your organization" }, { status: 403 });
    }
    if (job.status !== "open") {
      return Response.json({ error: `Job is not open (status: ${job.status})` }, { status: 409 });
    }
    if (job.hiringMode === "applications") {
      return Response.json(
        { error: "This job requires an application — use POST /v1/jobs/:jobId/apply" },
        { status: 409 }
      );
    }

    if (job.minCompletedJobs != null || job.minTrustScore != null) {
      const agent = await getAgent(verified.agentId);
      const tasksCompleted = agent?.tasksCompleted ?? 0;
      const trustScore = agent?.trustScore ?? 0;
      if (job.minCompletedJobs != null && tasksCompleted < job.minCompletedJobs) {
        return Response.json(
          { error: `Job requires ${job.minCompletedJobs}+ completed jobs (you have ${tasksCompleted})` },
          { status: 403 }
        );
      }
      if (job.minTrustScore != null && trustScore < job.minTrustScore) {
        return Response.json(
          { error: `Job requires ${job.minTrustScore}+ trust score (you have ${trustScore})` },
          { status: 403 }
        );
      }
    }

    const body = await request.json().catch(() => ({}));
    const onBehalfOf = typeof body.onBehalfOf === "string" ? body.onBehalfOf : null;
    const rewardUsdc = parseRewardUsdc(job.reward);

    let delegationGrantId: string | null = null;
    if (onBehalfOf && onBehalfOf !== verified.agentId) {
      const grant = await getActiveDelegation(
        verified.orgId,
        onBehalfOf,
        verified.agentId,
        "jobs:claim",
        rewardUsdc > 0 ? rewardUsdc : undefined,
      );
      if (!grant) {
        return Response.json(
          { error: `No active delegation from ${onBehalfOf} grants you jobs:claim (with sufficient spend headroom, if this job has a reward)` },
          { status: 403 }
        );
      }
      delegationGrantId = grant.id;
    }

    const taskId = await claimJob(jobId, verified.agentId, verified.orgId, job.projectId || "", verified.agentName);

    if (delegationGrantId && rewardUsdc > 0) {
      try {
        await recordDelegationSpend(delegationGrantId, rewardUsdc);
      } catch (spendErr) {
        // The claim already succeeded — a failed debit here is bookkeeping
        // drift on the grant, not a reason to undo an assignment the job
        // board and the agent's own auto-created task already reflect.
        console.error("Failed to record delegation spend after claim:", spendErr);
      }
    }

    return Response.json({
      jobId,
      status: "in_progress",
      taskId,
      claimedAt: Date.now(),
      ...(delegationGrantId ? { delegation: { grantId: delegationGrantId, onBehalfOf } } : {}),
    });
  } catch (err: any) {
    console.error("Claim job error:", err);
    // claimJob() throws plain Errors for credit-policy rejections — surface those as 403, not 500.
    const message: string = err.message || "Internal error";
    const isPolicyRejection = message.startsWith("Policy violation") || message.includes("requires manual approval");
    return Response.json({ error: message }, { status: isPolicyRejection ? 403 : 500 });
  }
}
