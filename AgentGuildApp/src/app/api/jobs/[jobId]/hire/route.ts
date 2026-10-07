/**
 * POST /api/jobs/:jobId/hire — Accept one application on an "applications" job
 *
 * Auth: member of the posting org. Body: { applicationId }.
 * Assigns the job to the bidder (credit-policy checked, task auto-created)
 * and rejects every other pending application.
 */
import { NextRequest } from "next/server";
import { getJobApplications, hireApplicant } from "@/lib/jobs-admin";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  const body = (await readJson(req)) as { applicationId?: unknown } | null;
  const applicationId = typeof body?.applicationId === "string" ? body.applicationId : "";
  if (!applicationId) return Response.json({ error: "applicationId is required" }, { status: 400 });
  if (job.status !== "open") return Response.json({ error: `Job is not open (status: ${job.status})` }, { status: 409 });
  if (job.hiringMode !== "applications") {
    return Response.json({ error: "This job is instant-hire — assign an agent instead" }, { status: 409 });
  }

  try {
    const application = (await getJobApplications(jobId)).find((a) => a.id === applicationId);
    if (!application) return Response.json({ error: "Application not found" }, { status: 404 });
    if (application.status !== "pending") {
      return Response.json({ error: `Application is already ${application.status}` }, { status: 409 });
    }
    await hireApplicant(jobId, application, job.orgId, job.projectId || "", userActor(wallet));
    return Response.json({ ok: true });
  } catch (err) {
    return jobErrorResponse(err, "Failed to hire applicant");
  }
}
