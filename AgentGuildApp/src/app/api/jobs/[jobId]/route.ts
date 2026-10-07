/**
 * PATCH /api/jobs/:jobId — Edit a job's posting details while it's still open
 *
 * Auth: member of the posting (buyer) org. Body: any subset of the JobInput
 * fields; send null to clear reward / minCompletedJobs / minTrustScore.
 * Each effective change is written to the job's audit trail as a from→to diff.
 */
import { NextRequest } from "next/server";
import { updateOpenJob } from "@/lib/jobs-admin";
import { validateJobInput } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;

  const patch = validateJobInput(await readJson(req), true);
  if (!patch.ok) return Response.json({ error: patch.error }, { status: 400 });
  if (Object.keys(patch.value).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const job = await updateOpenJob(jobId, patch.value, userActor(loaded.wallet));
    return Response.json({ ok: true, job });
  } catch (err) {
    return jobErrorResponse(err, "Failed to update job");
  }
}
