/**
 * POST /api/v1/gigs/:gigId/reviews — leave a review on a completed gig order.
 *
 * Reviews used to be written straight from the browser, with Firestore rules
 * as the only guard — which let any signed-in wallet post a review without
 * buying anything and set a gig's avgRating to any 0–5 value in one write.
 * This route is now the only write path (rules deny client writes to
 * gigReviews and to a gig's rating counters) and enforces that:
 *   - the caller is a member of the buyer org that placed the order (job)
 *   - the job was ordered from this gig and its delivery was approved
 *   - each order is reviewed at most once
 *   - the gig's average is recomputed from the stored values, not supplied
 *
 * Auth: session (x-wallet-address, set by middleware from the session cookie)
 * Body: { jobId: string, rating: 1-5, review?: string }
 */
import { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { getWalletAddress } from "@/lib/auth-guard";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

const MAX_REVIEW_LENGTH = 2000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ gigId: string }> }
) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const { gigId } = await params;
  const body = await req.json().catch(() => null) as { jobId?: unknown; rating?: unknown; review?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const rating = body?.rating;
  const review = typeof body?.review === "string" ? body.review.trim().slice(0, MAX_REVIEW_LENGTH) : "";

  if (!jobId) return Response.json({ error: "jobId is required" }, { status: 400 });
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ error: "rating must be a whole number from 1 to 5" }, { status: 400 });
  }

  const db = adminDb();
  const jobSnap = await db.collection("jobs").doc(jobId).get();
  const job = jobSnap.data();
  if (!job || job.gigId !== gigId) {
    return Response.json({ error: "Order not found for this gig" }, { status: 404 });
  }
  if (job.reviewStatus !== "approved") {
    return Response.json({ error: "You can review an order once you've approved its delivery" }, { status: 409 });
  }

  const orgSnap = await db.collection("organizations").doc(job.orgId).get();
  const org = orgSnap.data();
  const isBuyer = !!org && (
    (org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === wallet) ||
    ((org.members as string[] | undefined) ?? []).some((m) => canonicalizeWalletAddress(m) === wallet)
  );
  if (!isBuyer) {
    return Response.json({ error: "Only the buyer can review this order" }, { status: 403 });
  }

  // Reviews written before this route existed have random IDs, so check by
  // jobId too; new reviews use the jobId as the doc ID, which makes the
  // transaction's create() the once-per-order guarantee.
  const legacy = await db.collection("gigReviews").where("jobId", "==", jobId).limit(1).get();
  if (!legacy.empty) {
    return Response.json({ error: "This order has already been reviewed" }, { status: 409 });
  }

  const gigRef = db.collection("gigs").doc(gigId);
  const reviewRef = db.collection("gigReviews").doc(jobId);

  try {
    await db.runTransaction(async (tx) => {
      const gigSnap = await tx.get(gigRef);
      if (!gigSnap.exists) throw new Error("GIG_NOT_FOUND");
      const gig = gigSnap.data()!;
      const prevCount = (gig.ratingCount as number) ?? 0;
      const prevAvg = (gig.avgRating as number) ?? 0;
      const nextCount = prevCount + 1;

      tx.create(reviewRef, {
        gigId,
        jobId,
        orgId: job.orgId,
        authorAddress: wallet,
        rating,
        ...(review ? { review } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(gigRef, {
        avgRating: (prevAvg * prevCount + rating) / nextCount,
        ratingCount: nextCount,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "GIG_NOT_FOUND") {
      return Response.json({ error: "Gig not found" }, { status: 404 });
    }
    // create() fails with ALREADY_EXISTS (gRPC code 6) on a duplicate review.
    if ((err as { code?: number }).code === 6) {
      return Response.json({ error: "This order has already been reviewed" }, { status: 409 });
    }
    console.error("[gigs/reviews] Failed to save review:", err);
    return Response.json({ error: "Failed to save review" }, { status: 500 });
  }

  return Response.json({ ok: true, id: jobId });
}
