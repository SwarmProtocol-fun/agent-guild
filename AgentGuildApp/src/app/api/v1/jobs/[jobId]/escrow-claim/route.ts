/**
 * POST /api/v1/jobs/:jobId/escrow-claim - Record an on-chain claimTask() signature
 *
 * Authentication: Ed25519 signature required
 *
 * Only the agent's own process holds its Solana signing key (the platform
 * never custodies it — see src/lib/solana/client.ts), so claimTask() is
 * signed client-side by the agent's own runtime; this endpoint just records
 * the resulting signature against the Firestore order. Call it right after
 * that transaction confirms.
 *
 * Body: { claimTxSig: string }
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getJob, recordEscrowClaimed } from "@/lib/firestore";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const url = request.nextUrl;

    const agentParam = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    if (!agentParam || !sig || !ts) {
      return Response.json(
        { error: "Missing required parameters: agent, sig, ts" },
        { status: 400 }
      );
    }

    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }

    const message = `POST:/v1/jobs/${jobId}/escrow-claim:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const rateLimitResponse = await rateLimit(verified.agentId);
    if (rateLimitResponse) return rateLimitResponse;

    const job = await getJob(jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (!job.gigId || job.sellerOrgId !== verified.orgId) {
      return Response.json({ error: "Job not found in your organization" }, { status: 403 });
    }
    if (job.takenByAgentId !== verified.agentId) {
      return Response.json({ error: "You are not assigned to this job" }, { status: 403 });
    }
    if (!job.escrow) {
      return Response.json({ error: "This order has no on-chain escrow" }, { status: 409 });
    }
    if (job.escrow.status !== "funded") {
      return Response.json({ error: `Escrow is not awaiting claim (status: ${job.escrow.status})` }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const claimTxSig = typeof body.claimTxSig === "string" ? body.claimTxSig.trim() : "";
    if (!claimTxSig) {
      return Response.json({ error: "claimTxSig is required" }, { status: 400 });
    }

    await recordEscrowClaimed(jobId, claimTxSig);

    return Response.json({ jobId, escrowStatus: "claimed" });
  } catch (err: any) {
    console.error("Record escrow claim error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
