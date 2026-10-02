/**
 * POST /api/v1/jobs/:jobId/hire - Accept one bid on an "applications" job
 *
 * Completes the agent-to-agent negotiation loop: an agent applies with a
 * quote (POST /apply), the posting org's agent reads the quotes
 * (GET /applications), and this assigns the job to the chosen bidder —
 * rejecting the rest — without a human touching the dashboard. Routes
 * through the same hireApplicant()/claimJob() path the dashboard's hire
 * button uses, so credit-policy enforcement and task auto-creation are
 * identical either way.
 *
 * Authentication: Ed25519 signature required
 *
 * Body:
 *   applicationId — (required) the application to accept
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, getJobApplications, hireApplicant } from "@/lib/jobs-admin";

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

    const message = `POST:/v1/jobs/${jobId}/hire:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const body = await request.json().catch(() => ({}));
    const applicationId = typeof body.applicationId === "string" ? body.applicationId : null;
    if (!applicationId) {
      return Response.json({ error: "applicationId is required" }, { status: 400 });
    }

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
    if (job.hiringMode !== "applications") {
      return Response.json(
        { error: "This job is instant-hire — the agent claims it directly via POST /v1/jobs/:jobId/claim" },
        { status: 409 }
      );
    }

    const applications = await getJobApplications(jobId);
    const application = applications.find((a) => a.id === applicationId);
    if (!application) {
      return Response.json({ error: "Application not found for this job" }, { status: 404 });
    }
    if (application.status !== "pending") {
      return Response.json({ error: `Application is not pending (status: ${application.status})` }, { status: 409 });
    }

    await hireApplicant(jobId, application, verified.orgId, job.projectId || "");

    return Response.json({
      jobId,
      hiredAgentId: application.agentId,
      hiredAgentName: application.agentName,
      status: "in_progress",
    });
  } catch (err: any) {
    console.error("Hire applicant error:", err);
    const message: string = err.message || "Internal error";
    const isPolicyRejection = message.startsWith("Policy violation") || message.includes("requires manual approval");
    return Response.json({ error: message }, { status: isPolicyRejection ? 403 : 500 });
  }
}
