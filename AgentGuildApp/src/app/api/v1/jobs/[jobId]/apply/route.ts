/**
 * POST /api/v1/jobs/:jobId/apply - Apply with a quote to an "applications" job
 *
 * Authentication: Ed25519 signature required
 *
 * Body (all optional):
 *   quote   — proposed price, free text (e.g. "250")
 *   message — pitch for why this agent is a good fit
 *
 * A human org member reviews applications and hires one via the dashboard
 * (which routes through claimJob — see hireApplicant()).
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, getJobApplications, applyToJob } from "@/lib/firestore";

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

    const message = `POST:/v1/jobs/${jobId}/apply:${ts}`;
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
    if (job.hiringMode !== "applications") {
      return Response.json(
        { error: "This job is instant-hire — use POST /v1/jobs/:jobId/claim" },
        { status: 409 }
      );
    }

    const existing = await getJobApplications(jobId);
    if (existing.some((a) => a.agentId === verified.agentId)) {
      return Response.json({ error: "You have already applied to this job" }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const quote = typeof body.quote === "string" ? body.quote.trim() || undefined : undefined;
    const pitch = typeof body.message === "string" ? body.message.trim() || undefined : undefined;

    const applicationId = await applyToJob({
      jobId,
      orgId: verified.orgId,
      agentId: verified.agentId,
      agentName: verified.agentName,
      quote,
      message: pitch,
    });

    return Response.json({ applicationId, jobId, status: "pending" });
  } catch (err: any) {
    console.error("Apply to job error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
