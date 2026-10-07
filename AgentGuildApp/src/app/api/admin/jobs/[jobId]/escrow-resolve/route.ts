/**
 * POST /api/admin/jobs/:jobId/escrow-resolve — Record a platform admin's on-chain dispute resolution
 *
 * Auth: platform admin. Body: { resolveTxSig }.
 *
 * The admin signs resolveDispute() in the console (only the program
 * authority's signature succeeds on-chain). This verifies that signature is
 * a successful resolve_dispute on this order's Task PDA and records it. The
 * agent's share is read from the on-chain instruction, not the request, so
 * the record can't disagree with where the funds actually went.
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requirePlatformAdmin } from "@/lib/auth-guard";
import { getJob, recordEscrowResolved } from "@/lib/jobs-admin";
import { decodeAgentBps, verifyEscrowTx } from "@/lib/solana/escrow-tx-verify";
import { jobErrorResponse, readJson } from "@/lib/job-route-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!requirePlatformAdmin(req).ok) return Response.json({ error: "Platform admin only" }, { status: 403 });
  const { jobId } = await params;

  const body = (await readJson(req)) as { resolveTxSig?: unknown } | null;
  const resolveTxSig = typeof body?.resolveTxSig === "string" ? body.resolveTxSig.trim() : "";
  if (!resolveTxSig) return Response.json({ error: "resolveTxSig is required" }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  if (!job.escrow) return Response.json({ error: "This job has no on-chain escrow" }, { status: 409 });
  if (job.escrow.status === "resolved") return Response.json({ error: "Escrow is already resolved" }, { status: 409 });

  try {
    const check = await verifyEscrowTx(resolveTxSig, "resolve_dispute", job.escrow.taskPda);
    if (!check.verified) return Response.json({ error: check.reason }, { status: check.retryable ? 503 : 422 });
    const agentBps = decodeAgentBps(check.args);
    if (agentBps === null || agentBps > 10_000) return Response.json({ error: "Could not read the split from the transaction" }, { status: 422 });

    const admin = getWalletAddress(req);
    await recordEscrowResolved(jobId, resolveTxSig, agentBps, { type: "user", id: admin || "platform-admin", name: "Platform admin" });
    return Response.json({ ok: true, agentBps });
  } catch (err) {
    return jobErrorResponse(err, "Failed to record escrow resolution");
  }
}
