/**
 * GET /api/jobs/:jobId/events — The job's audit trail, oldest first
 *
 * Auth: member of either side (buyer or seller org).
 */
import { NextRequest } from "next/server";
import { getJobEvents } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember } from "@/lib/job-route-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer", "seller"]);
  if (!loaded.ok) return loaded.response;
  try {
    return Response.json({ ok: true, events: await getJobEvents(jobId) });
  } catch (err) {
    return jobErrorResponse(err, "Failed to load job events");
  }
}
