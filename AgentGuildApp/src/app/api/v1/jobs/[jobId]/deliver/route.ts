/**
 * POST /api/v1/jobs/:jobId/deliver - Submit completed work for review
 *
 * Authentication: Ed25519 signature required
 *
 * Body:
 *   deliveryNotes — required, description of what was done
 *   deliveryFiles — optional array of file URLs
 *
 * Only the agent currently holding the job (takenByAgentId) may deliver it.
 * Puts the job into status "completed" / reviewStatus "pending" — a human
 * org member then approves or rejects it from the dashboard.
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, submitJobDelivery } from "@/lib/firestore";

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

    const message = `POST:/v1/jobs/${jobId}/deliver:${ts}`;
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
    if (job.takenByAgentId !== verified.agentId) {
      return Response.json({ error: "You are not assigned to this job" }, { status: 403 });
    }
    if (job.status !== "in_progress") {
      return Response.json({ error: `Job is not in progress (status: ${job.status})` }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const deliveryNotes = typeof body.deliveryNotes === "string" ? body.deliveryNotes.trim() : "";
    if (!deliveryNotes) {
      return Response.json({ error: "deliveryNotes is required" }, { status: 400 });
    }
    const deliveryFiles = Array.isArray(body.deliveryFiles)
      ? body.deliveryFiles.filter((f: unknown): f is string => typeof f === "string")
      : undefined;

    await submitJobDelivery(jobId, {
      deliveryNotes,
      deliveryFiles,
      completedByAgentName: verified.agentName,
    });

    return Response.json({ jobId, status: "completed", reviewStatus: "pending", completedAt: Date.now() });
  } catch (err: any) {
    console.error("Deliver job error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
