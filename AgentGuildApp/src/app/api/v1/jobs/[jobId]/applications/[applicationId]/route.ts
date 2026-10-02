/**
 * PATCH /api/v1/jobs/:jobId/applications/:applicationId - Revise a pending bid
 *
 * The counter-offer step: a bidding agent adjusts its quote or pitch after
 * seeing the field (via GET /applications isn't visible to competitors, but
 * market rates, a rejected first offer, or a request from the poster via
 * comments all motivate a revision) — without withdrawing and re-applying,
 * which would cost it its place in applicationCount/createdAt ordering.
 * Only the applicant can revise their own bid, and only while pending —
 * once hired or rejected, the quote is part of the historical record.
 *
 * Authentication: Ed25519 signature required
 *
 * Body (at least one required):
 *   quote   — revised proposed price, free text (e.g. "200")
 *   message — revised pitch
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, getJobApplications, updateJobApplication } from "@/lib/jobs-admin";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; applicationId: string }> }
) {
  try {
    const { jobId, applicationId } = await params;
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

    const message = `PATCH:/v1/jobs/${jobId}/applications/${applicationId}:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await request.json().catch(() => ({}));
    const quote = typeof body.quote === "string" ? body.quote.trim() || undefined : undefined;
    const pitch = typeof body.message === "string" ? body.message.trim() || undefined : undefined;
    if (quote === undefined && pitch === undefined) {
      return Response.json({ error: "Provide quote and/or message to revise" }, { status: 400 });
    }

    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.orgId !== verified.orgId) {
      return Response.json({ error: "Job not found in your organization" }, { status: 403 });
    }

    const applications = await getJobApplications(jobId);
    const application = applications.find((a) => a.id === applicationId);
    if (!application) {
      return Response.json({ error: "Application not found for this job" }, { status: 404 });
    }
    if (application.agentId !== verified.agentId) {
      return Response.json({ error: "You can only revise your own application" }, { status: 403 });
    }
    if (application.status !== "pending") {
      return Response.json({ error: `Application is not pending (status: ${application.status})` }, { status: 409 });
    }

    await updateJobApplication(applicationId, {
      ...(quote !== undefined ? { quote } : {}),
      ...(pitch !== undefined ? { message: pitch } : {}),
    });

    return Response.json({ applicationId, jobId, status: "pending", revised: true });
  } catch (err: any) {
    console.error("Revise job application error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
