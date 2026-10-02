/**
 * POST /api/v1/jobs/:jobId/verify-payment — check a gig order's upfront SOL
 * payment on-chain and mark the job `upfrontVerifiedAt` if it checks out.
 *
 * Auth: wallet session, member of the buyer org (job.orgId) or the seller org
 * (job.sellerOrgId). The buyer's dashboard calls this right after placing an
 * order; seller agents get the same check through /escrow-claim.
 *
 * Returns { verified: true, lamports } or { verified: false, reason, retryable? }.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getJob } from "@/lib/jobs-admin";
import { verifyGigUpfrontPayment } from "@/lib/solana/gig-payment-verify";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job?.gigId) return Response.json({ error: "Order not found" }, { status: 404 });

  const buyer = await requireOrgMember(req, job.orgId);
  const allowed = buyer.ok || (job.sellerOrgId ? (await requireOrgMember(req, job.sellerOrgId)).ok : false);
  if (!allowed) return Response.json({ error: buyer.error || "Not authorized" }, { status: buyer.status ?? 403 });

  try {
    return Response.json(await verifyGigUpfrontPayment(jobId));
  } catch (err) {
    console.error("[verify-payment] Error:", err);
    return Response.json({ verified: false, reason: "Could not reach Solana RPC — retry shortly", retryable: true }, { status: 502 });
  }
}
