/**
 * POST /api/jobs/:jobId/rating — Rate approved work, 1–5 stars, once per job
 *
 * Auth: member of the posting (buyer) org. Body: { rating, ratingComment? }.
 * Rolls into the agent's average rating and, for gig orders, the gig
 * listing's. Usually given together with the approval (POST /review with a
 * rating) — this is for rating afterwards, e.g. an auto-approved delivery.
 */
import { NextRequest } from "next/server";
import { rateJob } from "@/lib/jobs-admin";
import { validateRating } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;

  const rating = validateRating(await readJson(req), true);
  if (!rating.ok) return Response.json({ error: rating.error }, { status: 400 });

  try {
    const job = await rateJob(jobId, rating.value!, userActor(loaded.wallet));
    return Response.json({ ok: true, job });
  } catch (err) {
    return jobErrorResponse(err, "Failed to save rating");
  }
}
