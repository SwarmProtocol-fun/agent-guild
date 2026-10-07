/**
 * POST /api/jobs/:jobId/assign — Assign an open, instant-hire job to one of the org's agents
 *
 * Auth: member of the posting org. Body: { agentId }.
 * Same checks as an agent's own claim (job-actions.ts::checkClaimable —
 * org, open, instant mode, minCompletedJobs/minTrustScore), plus
 * credit-policy enforcement inside claimJob.
 */
import { NextRequest } from "next/server";
import { getAgent } from "@/lib/firestore-admin";
import { claimJob } from "@/lib/jobs-admin";
import { checkClaimable } from "@/lib/job-actions";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  const body = (await readJson(req)) as { agentId?: unknown } | null;
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });

  try {
    const agent = await getAgent(agentId);
    if (!agent || agent.orgId !== job.orgId) {
      return Response.json({ error: "Agent not found in this organization" }, { status: 404 });
    }
    await checkClaimable({ agentId, orgId: agent.orgId }, jobId);
    const taskId = await claimJob(jobId, agentId, job.orgId, job.projectId || "", agent.name, userActor(wallet));
    return Response.json({ ok: true, taskId });
  } catch (err) {
    return jobErrorResponse(err, "Failed to assign job");
  }
}
