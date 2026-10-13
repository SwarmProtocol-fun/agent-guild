/**
 * /api/jobs/:jobId/payment — pay the agent for an approved job (lib/job-payments.ts).
 *
 * GET  — payment status and options: amount suggested by the reward, the
 *        agent's own wallets per chain, and the chain details to send on.
 *        Any member of the posting org.
 * POST — record a payment. The org owner or the job's poster.
 *   { method: "base-usdc" | "solana-usdc", txSig, from, to, amountUsdc }
 *       — a transfer already sent from the poster's wallet; checked on-chain.
 *   { method: "offplatform", channel, reference?, note?, amountUsdc }
 *       — paid outside the platform (bank, PayPal, …); recorded as stated.
 */
import { NextRequest } from "next/server";
import { getOrganization } from "@/lib/firestore-admin";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { userActor } from "@/lib/job-audit";
import { jobErrorResponse, loadJobForMember, readJson } from "@/lib/job-route-auth";
import { markJobPaidOffPlatform, payJobOnChain, paymentOptions } from "@/lib/job-payments";
import type { Job } from "@/lib/firestore";

async function canPay(job: Job, wallet: string): Promise<boolean> {
  if (job.postedByAddress && canonicalizeWalletAddress(job.postedByAddress) === wallet) return true;
  const org = await getOrganization(job.orgId);
  return !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === wallet;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  try {
    const options = await paymentOptions(loaded.job);
    return Response.json({ ...options, canPay: await canPay(loaded.job, loaded.wallet) });
  } catch (err) {
    return jobErrorResponse(err, "Failed to load payment options");
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const loaded = await loadJobForMember(req, jobId, ["buyer"]);
  if (!loaded.ok) return loaded.response;
  const { job, wallet } = loaded;
  if (!(await canPay(job, wallet))) {
    return Response.json({ error: "Only the org owner or the job's poster can pay for it" }, { status: 403 });
  }

  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  try {
    const actor = userActor(wallet);
    const payment =
      body.method === "base-usdc" || body.method === "solana-usdc"
        ? await payJobOnChain(job, {
            method: body.method,
            txSig: String(body.txSig ?? ""),
            from: String(body.from ?? ""),
            to: String(body.to ?? ""),
            amountUsdc: body.amountUsdc,
          }, actor)
        : body.method === "offplatform"
          ? await markJobPaidOffPlatform(job, { channel: body.channel, reference: body.reference, note: body.note, amountUsdc: body.amountUsdc }, actor)
          : null;
    if (!payment) return Response.json({ error: 'method must be "base-usdc", "solana-usdc" or "offplatform"' }, { status: 400 });
    return Response.json({ ok: true, payment });
  } catch (err) {
    return jobErrorResponse(err, "Failed to record payment");
  }
}
