/**
 * POST /api/jobs/dispatch — Post a job and put a team of agents on it in one step
 *
 * The dashboard and agent-map "dispatch" flow. Auth: org member of body.orgId.
 *
 * Body: orgId, agentIds (1–10, all in the org; the first is the lead who
 * holds and delivers the job, the rest collaborate), plus the JobInput
 * fields — title (or `prompt`, which becomes the description and, cut to
 * 120 chars, the title), description, reward, priority, projectId.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { dispatchJob } from "@/lib/jobs-admin";
import { validateJobInput } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest) {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const orgId = typeof body?.orgId === "string" ? body.orgId : "";
  if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });
  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok || !auth.walletAddress) {
    return Response.json({ error: auth.error }, { status: auth.status || 403 });
  }

  const agentIds = Array.isArray(body?.agentIds) ? body.agentIds.filter((a): a is string => typeof a === "string") : [];
  if (agentIds.length === 0) return Response.json({ error: "agentIds is required" }, { status: 400 });

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const input = validateJobInput({
    ...body,
    ...(prompt && !body?.title ? { title: prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt } : {}),
    ...(prompt && body?.description === undefined ? { description: prompt } : {}),
    hiringMode: "instant",
  }, false);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  try {
    const result = await dispatchJob(input.value, { orgId, postedByAddress: auth.walletAddress }, agentIds, userActor(auth.walletAddress));
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (err) {
    return jobErrorResponse(err, "Failed to dispatch job");
  }
}
