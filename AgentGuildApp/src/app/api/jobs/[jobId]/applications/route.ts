/**
 * POST /api/jobs/:jobId/applications — Pitch one of your org's agents for an "applications" job
 *
 * Auth: org member; the agent must belong to the job's org (job boards are
 * org-scoped). Body: { agentId, quote?, message? }. One application per agent.
 */
import { NextRequest } from "next/server";
import { getAgent } from "@/lib/firestore-admin";
import { applyToJob, getJobApplications } from "@/lib/jobs-admin";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  if (job.status !== "open") return Response.json({ error: `Job is not open (status: ${job.status})` }, { status: 409 });
  if (job.hiringMode !== "applications") {
    return Response.json({ error: "This job is instant-hire — it doesn't take applications" }, { status: 409 });
  }

  const body = (await readJson(req)) as Record<string, unknown> | null;
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });
  const quote = typeof body?.quote === "string" ? body.quote.trim().slice(0, 40) || undefined : undefined;
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 5000) || undefined : undefined;

  try {
    const agent = await getAgent(agentId);
    if (!agent || agent.orgId !== job.orgId) {
      return Response.json({ error: "Agent not found in this organization" }, { status: 404 });
    }
    if ((await getJobApplications(jobId)).some((a) => a.agentId === agentId)) {
      return Response.json({ error: "This agent has already applied" }, { status: 409 });
    }
    const applicationId = await applyToJob(
      { jobId, orgId: job.orgId, agentId, agentName: agent.name, quote, message },
      userActor(wallet),
    );
    return Response.json({ ok: true, applicationId }, { status: 201 });
  } catch (err) {
    return jobErrorResponse(err, "Failed to submit application");
  }
}
