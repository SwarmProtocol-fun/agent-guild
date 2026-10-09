/**
 * POST /api/jobs/:jobId/review — Approve a delivery or send it back for revisions
 *
 * Auth: member of the posting (buyer) org — the seller can't approve its own work
 * on a gig order.
 *
 * Body:
 *   decision     — "approve" | "reject"
 *   notes        — feedback; required for "reject"
 *   releaseTxSig — escrowed gig orders, approve only: the approveDelivery()
 *                  signature the buyer already signed client-side. Required
 *                  unless the escrow is already released, so a job can't be
 *                  marked approved while the seller's funds are still locked.
 *                  Verified on-chain (lib/solana/escrow-tx-verify.ts): a
 *                  successful approve_delivery on this order's Task PDA,
 *                  signed by the order's poster wallet.
 *
 *   rating        — approve only, optional: 1–5 stars for the work (see
 *                   POST /rating); ratingComment — optional text with it.
 *
 * Approve → job completed/approved, agent's completed-job count +1, task closed.
 * Reject  → job back to in_progress; the agent delivers again (a new revision).
 */
import { NextRequest } from "next/server";
import { rateJob, recordEscrowReleased, reviewDelivery } from "@/lib/jobs-admin";
import { validateRating, validateReview } from "@/lib/job-lifecycle";
import { verifyEscrowTx } from "@/lib/solana/escrow-tx-verify";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;

  const body = await readJson(req);
  const review = validateReview(body);
  if (!review.ok) return Response.json({ error: review.error }, { status: 400 });
  const rating = validateRating(body, false);
  if (!rating.ok) return Response.json({ error: rating.error }, { status: 400 });
  if (rating.value && !review.value.approve) {
    return Response.json({ error: "A rating goes with an approval — rate the work once it's approved" }, { status: 400 });
  }

  const rawSig = (body as { releaseTxSig?: unknown }).releaseTxSig;
  const releaseTxSig = typeof rawSig === "string" && rawSig.trim() ? rawSig.trim() : null;
  const escrowLocked = !!job.escrow && job.escrow.status !== "released" && job.escrow.status !== "resolved";
  if (review.value.approve && escrowLocked && !releaseTxSig) {
    return Response.json(
      { error: "This order has on-chain escrow — sign the release (approveDelivery) first and pass releaseTxSig" },
      { status: 409 },
    );
  }

  if (review.value.approve && escrowLocked && releaseTxSig && job.escrow) {
    const check = await verifyEscrowTx(releaseTxSig, "approve_delivery", job.escrow.taskPda, job.escrow.posterSolanaAddress);
    if (!check.verified) return Response.json({ error: check.reason }, { status: check.retryable ? 503 : 422 });
  }

  try {
    if (review.value.approve && escrowLocked && releaseTxSig) {
      await recordEscrowReleased(jobId, releaseTxSig, userActor(wallet));
    }
    let updated = await reviewDelivery(jobId, review.value, userActor(wallet));
    if (rating.value) {
      try {
        updated = await rateJob(jobId, rating.value, userActor(wallet));
      } catch (err) {
        // The approval stands either way — report the rating failure separately.
        return Response.json({ ok: true, job: updated, ratingError: err instanceof Error ? err.message : "Failed to save rating" });
      }
    }
    return Response.json({ ok: true, job: updated });
  } catch (err) {
    return jobErrorResponse(err, "Failed to review delivery");
  }
}
