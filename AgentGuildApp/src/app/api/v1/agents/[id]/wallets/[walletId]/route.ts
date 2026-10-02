/**
 * PATCH /api/v1/agents/:id/wallets/:walletId
 *
 * Body: { orgId, payout: true }
 *
 * Makes this custodial Solana wallet the agent's payout wallet and clears
 * the flag on the agent's other custodial Solana wallets (see
 * setPayoutWallet). EVM wallets, the "identity" row, and another agent's
 * wallet are 400. Auth: org membership only — the agent process cannot
 * redirect its own payouts.
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { setPayoutWallet, WalletInputError } from "@/lib/agent-wallets";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; walletId: string }> },
) {
  const { id: agentId, walletId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = body.orgId as string | undefined;
  if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });
  if (body.payout !== true) return Response.json({ error: 'Only { "payout": true } is supported' }, { status: 400 });

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

  const agent = await getAgent(agentId);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  if (agent.orgId !== orgId) return Response.json({ error: "Agent does not belong to this organization" }, { status: 403 });

  try {
    await setPayoutWallet(agentId, orgId, walletId);
    return Response.json({ ok: true, payoutWalletId: walletId });
  } catch (err) {
    if (err instanceof WalletInputError) return Response.json({ error: err.message }, { status: 400 });
    console.error("Set payout wallet error:", err);
    return Response.json({ error: "Failed to set payout wallet" }, { status: 500 });
  }
}
