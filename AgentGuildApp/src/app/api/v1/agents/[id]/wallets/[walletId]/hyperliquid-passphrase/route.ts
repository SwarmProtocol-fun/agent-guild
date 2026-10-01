/**
 * POST /api/v1/agents/:id/wallets/:walletId/hyperliquid-passphrase
 *
 * Resets the Hyperliquid trading passphrase for an EVM agent wallet that
 * was generated via POST /api/v1/agents/:id/wallets (not one pasted
 * directly into mods/hyperliquid-trading's own POST /wallet — that path
 * has no second copy of the key for us to recover, by design; see
 * lib/agent-wallets.ts's resetHyperliquidPassphrase doc).
 *
 * Body: { orgId, masterSecret, network? }
 * Auth: org membership — same trust level as generating the wallet itself.
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { resetHyperliquidPassphrase, type HyperliquidNetwork } from "@/lib/agent-wallets";

export async function POST(
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
  const masterSecret = body.masterSecret as string | undefined;
  const network = body.network as HyperliquidNetwork | undefined;
  if (!orgId || !masterSecret) {
    return Response.json({ error: "orgId and masterSecret are required" }, { status: 400 });
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

  const agent = await getAgent(agentId);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  if (agent.orgId !== orgId) return Response.json({ error: "Agent does not belong to this organization" }, { status: 403 });

  try {
    await resetHyperliquidPassphrase(walletId, orgId, agentId, masterSecret, network);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Reset Hyperliquid passphrase error:", err);
    const message = err instanceof Error ? err.message : "Failed to reset passphrase";
    return Response.json({ error: message }, { status: 500 });
  }
}
