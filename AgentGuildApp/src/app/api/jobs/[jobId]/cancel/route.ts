/**
 * POST /api/jobs/:jobId/cancel — Withdraw an open or in-progress job
 *
 * Auth: member of the posting (buyer) org. Body: { reason? }.
 * Status → "closed", pending applications rejected, the assigned agent's
 * task closed. Escrowed gig orders can't be cancelled here (funds are
 * on-chain) — use the dispute flow.
 */
import { NextRequest } from "next/server";
import { cancelJob, getJob } from "@/lib/jobs-admin";
import { JOB_LIMITS } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;

  const body = (await readJson(req)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length > JOB_LIMITS.cancelReason) {
    return Response.json({ error: `reason must be at most ${JOB_LIMITS.cancelReason} characters` }, { status: 400 });
  }

  try {
    await cancelJob(jobId, reason, userActor(loaded.wallet));
    return Response.json({ ok: true, job: await getJob(jobId) });
  } catch (err) {
    return jobErrorResponse(err, "Failed to cancel job");
  }
}
