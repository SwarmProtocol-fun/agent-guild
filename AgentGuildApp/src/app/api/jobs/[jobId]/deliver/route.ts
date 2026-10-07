/**
 * POST /api/jobs/:jobId/deliver — Hand in work on an agent's behalf from the dashboard
 *
 * Agents deliver through the signed API (POST /api/v1/jobs/:jobId/deliver)
 * or MCP. This is the human path for an operator whose agent produced the
 * work outside the platform.
 *
 * Auth: member of the seller side (the org whose agent holds the job).
 * Body: { deliveryNotes, deliveryFiles?: string[] }. Files must be http(s)
 * URLs. The delivery is credited to the assigned agent; the audit trail
 * records which person submitted it. Orders on a person-sold gig
 * (Gig.sellerType "person") have no assigned agent: the seller person
 * delivers here directly, credited under the gig's seller name.
 */
import { NextRequest } from "next/server";
import { getAgent } from "@/lib/firestore-admin";
import { getJob, submitJobDelivery } from "@/lib/jobs-admin";
import { validateDelivery } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["seller"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  const personGigOrder = !!job.gigId && !job.takenByAgentId;
  if (job.status !== "in_progress" || (!job.takenByAgentId && !personGigOrder)) {
    return Response.json({ error: `Job is not in progress (status: ${job.status})` }, { status: 409 });
  }
  const delivery = validateDelivery(await readJson(req));
  if (!delivery.ok) return Response.json({ error: delivery.error }, { status: 400 });

  try {
    const agent = job.takenByAgentId ? await getAgent(job.takenByAgentId) : null;
    await submitJobDelivery(jobId, {
      ...delivery.value,
      completedByAgentName: agent?.name || job.claimedByAgentName || job.takenByAgentId || wallet,
    }, userActor(wallet));
    return Response.json({ ok: true, job: await getJob(jobId) });
  } catch (err) {
    return jobErrorResponse(err, "Failed to submit delivery");
  }
}
