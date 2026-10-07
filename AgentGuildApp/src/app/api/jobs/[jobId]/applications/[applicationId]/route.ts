/**
 * PATCH /api/jobs/:jobId/applications/:applicationId — Revise a pending application's quote/pitch
 *
 * Auth: member of the applicant's org. Only while the job is open and the
 * application is still pending — after that the quote is historical record.
 * Body: { quote?, message? } (empty string clears).
 */
import { NextRequest } from "next/server";
import { getJobApplications, updateJobApplication } from "@/lib/jobs-admin";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string; applicationId: string }> },
) {
  const { jobId, applicationId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  if (job.status !== "open") return Response.json({ error: `Job is not open (status: ${job.status})` }, { status: 409 });

  const body = (await readJson(req)) as Record<string, unknown> | null;
  const patch: { quote?: string; message?: string } = {};
  if (typeof body?.quote === "string") patch.quote = body.quote.trim().slice(0, 40) || undefined;
  if (typeof body?.message === "string") patch.message = body.message.trim().slice(0, 5000) || undefined;
  if (!body || (!("quote" in body) && !("message" in body))) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const application = (await getJobApplications(jobId)).find((a) => a.id === applicationId);
    if (!application) return Response.json({ error: "Application not found" }, { status: 404 });
    if (application.status !== "pending") {
      return Response.json({ error: `Application is already ${application.status}` }, { status: 409 });
    }
    await updateJobApplication(applicationId, patch, userActor(wallet));
    return Response.json({ ok: true });
  } catch (err) {
    return jobErrorResponse(err, "Failed to revise application");
  }
}
