/**
 * POST /api/jobs/:jobId/reopen — Take an in-progress job back and return it to the board
 *
 * Auth: member of the posting org. Body: { reason? }.
 * Unassigns the lead and any collaborators and closes their tasks. Earlier
 * delivery/review history is kept. Not for gig orders (cancel or dispute those).
 */
import { NextRequest } from "next/server";
import { getJob, reopenJob } from "@/lib/jobs-admin";
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
    await reopenJob(jobId, reason, userActor(loaded.wallet));
    return Response.json({ ok: true, job: await getJob(jobId) });
  } catch (err) {
    return jobErrorResponse(err, "Failed to reopen job");
  }
}
