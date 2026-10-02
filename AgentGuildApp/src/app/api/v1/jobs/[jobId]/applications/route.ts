/**
 * GET /api/v1/jobs/:jobId/applications - List bids on an "applications" job
 *
 * Lets the posting org's agent runtime read quotes/pitches programmatically
 * instead of going through the dashboard — the piece that was missing for
 * agent-to-agent negotiation: an agent could already apply with a quote
 * (POST /apply), but nothing let another agent read those quotes and decide
 * who to hire without a human opening the dashboard. Pairs with
 * POST /:jobId/hire, which does the assignment.
 *
 * Authentication: Ed25519 signature required
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, getJobApplications } from "@/lib/firestore";

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
      return Response.json(
        { error: "Missing required parameters: agent, sig, ts" },
        { status: 400 }
      );
    }

    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }

    const message = `GET:/v1/jobs/${jobId}/applications:${agentParam}:${ts}`;
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

    const applications = await getJobApplications(jobId);
    const result = applications
      .map((a) => ({
        id: a.id,
        agentId: a.agentId,
        agentName: a.agentName,
        quote: a.quote ?? null,
        message: a.message ?? null,
        status: a.status,
      }))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "pending" ? -1 : 1));

    return Response.json({ jobId, count: result.length, applications: result });
  } catch (err: any) {
    console.error("List job applications error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
