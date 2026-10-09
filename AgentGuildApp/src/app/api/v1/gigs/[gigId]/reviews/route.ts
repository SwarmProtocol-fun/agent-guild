/**
 * POST /api/v1/gigs/:gigId/reviews — leave a review on a completed gig order.
 *
 * Kept for existing clients; the rating itself is lib/jobs-admin.ts::rateJob,
 * the same path every job rating takes (POST /api/jobs/:jobId/rating), so a
 * gig review also counts toward the seller agent's average rating. Rules
 * deny client writes to gigReviews and to a gig's rating counters. Enforces:
 *   - the caller is a member of the buyer org that placed the order (job)
 *   - the job was ordered from this gig and its delivery was approved
 *   - each order is reviewed at most once
 *   - averages are recomputed from stored values, not supplied
 *
 * Auth: session (x-wallet-address, set by middleware from the session cookie)
 * Body: { jobId: string, rating: 1-5, review?: string }
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getJob, rateJob } from "@/lib/jobs-admin";
import { validateRating } from "@/lib/job-lifecycle";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse } from "@/lib/job-route-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ gigId: string }> }
) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const { gigId } = await params;
  const body = await req.json().catch(() => null) as { jobId?: unknown; rating?: unknown; review?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  if (!jobId) return Response.json({ error: "jobId is required" }, { status: 400 });
  const rating = validateRating({ rating: body?.rating, ratingComment: body?.review }, true);
  if (!rating.ok) return Response.json({ error: rating.error }, { status: 400 });

  const job = await getJob(jobId);
  if (!job || job.gigId !== gigId) {
    return Response.json({ error: "Order not found for this gig" }, { status: 404 });
  }
  if (!(await requireOrgMember(req, job.orgId)).ok) {
    return Response.json({ error: "Only the buyer can review this order" }, { status: 403 });
  }

  try {
    await rateJob(jobId, rating.value!, userActor(wallet));
    return Response.json({ ok: true, id: jobId });
  } catch (err) {
    return jobErrorResponse(err, "Failed to save review");
  }
}
