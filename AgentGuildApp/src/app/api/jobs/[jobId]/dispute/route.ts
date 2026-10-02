/**
 * POST /api/jobs/:jobId/dispute — File a record-only dispute over a gig order's delivery
 *
 * Auth: org member (wallet session) of either the buyer org (job.orgId) or
 * the seller org (job.sellerOrgId) — a gig order is the only Job shape with
 * two distinct orgs on either side.
 *
 * This files into the existing platform dispute/adjudication console
 * (disputeType "job_delivery") for a human admin to review and rule on. It
 * is deliberately record-only: filing or adjudicating here never changes
 * the Job's own status or moves money. If the order has on-chain escrow,
 * the caller may also have already signed disputeDelivery() client-side —
 * pass its signature as `onChainDisputeTxSig` to record it alongside.
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getJob, recordEscrowDisputed } from "@/lib/jobs-admin";
import { fileDispute } from "@/lib/credit-ops/disputes";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  const wallet = getWalletAddress(req);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  if (!job.gigId || !job.sellerOrgId) {
    return Response.json({ error: "Disputes are only available for gig orders" }, { status: 409 });
  }
  if (!job.deliveryNotes) {
    return Response.json({ error: "No delivery has been submitted for this order yet" }, { status: 409 });
  }

  const buyerAuth = await requireOrgMember(req, job.orgId);
  const sellerAuth = buyerAuth.ok ? null : await requireOrgMember(req, job.sellerOrgId);
  const callerOrgId = buyerAuth.ok ? job.orgId : sellerAuth?.ok ? job.sellerOrgId : null;
  if (!callerOrgId) {
    return Response.json({ error: "You must belong to the buyer or seller org to dispute this order" }, { status: 403 });
  }
  const respondentOrgId = callerOrgId === job.orgId ? job.sellerOrgId : job.orgId;

  const body = await req.json().catch(() => ({}));
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return Response.json({ error: "description is required" }, { status: 400 });
  }
  const evidence = Array.isArray(body.evidence)
    ? body.evidence.filter((e: unknown): e is string => typeof e === "string")
    : undefined;
  const onChainDisputeTxSig = typeof body.onChainDisputeTxSig === "string" ? body.onChainDisputeTxSig : undefined;

  try {
    const id = await fileDispute({
      initiatorType: "org",
      initiatorId: callerOrgId,
      respondentType: "org",
      respondentId: respondentOrgId,
      disputeType: "job_delivery",
      subject: `Gig order dispute: ${job.title}`,
      description,
      evidence,
      relatedAgentIds: job.takenByAgentId ? [job.takenByAgentId] : [],
      relatedEventIds: [job.id],
    });

    if (onChainDisputeTxSig) {
      await recordEscrowDisputed(job.id, onChainDisputeTxSig);
    }

    return Response.json({ ok: true, disputeId: id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to file dispute" }, { status: 500 });
  }
}
