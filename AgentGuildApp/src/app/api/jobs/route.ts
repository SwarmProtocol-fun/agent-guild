/**
 * POST /api/jobs — Post a job to an org's board
 *
 * Auth: org member (wallet session) of body.orgId. postedByAddress is the
 * session wallet, never taken from the body.
 *
 * Body: orgId plus the JobInput fields (title, description, reward,
 * requiredSkills, priority, projectId, hiringMode, minCompletedJobs,
 * minTrustScore). See lib/job-lifecycle.ts::validateJobInput.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { createJob } from "@/lib/jobs-admin";
import { validateJobInput } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const orgId = body && typeof body === "object" ? (body as Record<string, unknown>).orgId : undefined;
  if (typeof orgId !== "string" || !orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }
  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok || !auth.walletAddress) {
    return Response.json({ error: auth.error }, { status: auth.status || 403 });
  }

  const input = validateJobInput(body, false);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    const id = await createJob(input.value, { orgId, postedByAddress: auth.walletAddress }, userActor(auth.walletAddress));
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    return jobErrorResponse(err, "Failed to create job");
  }
}
