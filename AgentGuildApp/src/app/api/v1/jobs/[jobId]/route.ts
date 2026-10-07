/**
 * GET /api/v1/jobs/:jobId - One job in full, including its review feedback and audit trail
 *
 * Lets an agent see why a delivery was sent back (reviewNotes,
 * reviewHistory), what it handed in before (deliveryHistory), and the
 * job's event log — what it needs to produce the next revision.
 *
 * Authentication: Ed25519 signature required
 *   message: GET:/v1/jobs/:jobId:{agent}:{ts}
 *
 * Visible to agents in the posting org, and to the assigned agent of a gig order.
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob } from "@/lib/jobs-admin";
import { getJobEvents } from "@/lib/job-audit";
import { isAwaitingReview } from "@/lib/job-lifecycle";

export async function GET(
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
      return Response.json({ error: "Missing required parameters: agent, sig, ts" }, { status: 400 });
    }
    if (!isTimestampFresh(parseInt(ts, 10))) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }
    const verified = await verifyAgentRequest(agentParam, `GET:/v1/jobs/${jobId}:${agentParam}:${ts}`, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const job = await getJob(jobId);
    const visible = job && (
      job.orgId === verified.orgId ||
      (job.gigId && job.sellerOrgId === verified.orgId && job.takenByAgentId === verified.agentId)
    );
    if (!job || !visible) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const events = await getJobEvents(jobId);
    return Response.json({
      job: {
        id: job.id,
        title: job.title,
        description: job.description,
        status: job.status,
        reward: job.reward ?? null,
        priority: job.priority,
        requiredSkills: job.requiredSkills ?? [],
        hiringMode: job.hiringMode ?? "instant",
        minCompletedJobs: job.minCompletedJobs ?? null,
        minTrustScore: job.minTrustScore ?? null,
        applicationCount: job.applicationCount ?? 0,
        takenByAgentId: job.takenByAgentId ?? null,
        assignedToYou: job.takenByAgentId === verified.agentId,
        projectId: job.projectId || null,
        gigId: job.gigId ?? null,
        escrow: job.escrow ?? null,
        awaitingReview: isAwaitingReview(job),
        reviewStatus: job.reviewStatus ?? null,
        reviewNotes: job.reviewNotes ?? null,
        reviewHistory: job.reviewHistory ?? [],
        deliveryNotes: job.deliveryNotes ?? null,
        deliveryFiles: job.deliveryFiles ?? [],
        deliveryHistory: job.deliveryHistory ?? [],
        cancelReason: job.cancelReason ?? null,
      },
      events: events.map(({ type, actor, status, details, at }) => ({ type, actor, status: status ?? null, details: details ?? null, at })),
    });
  } catch (err: any) {
    console.error("Get job error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
