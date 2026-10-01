/**
 * POST /api/admin/agent-wallets/rotate-key
 *
 * Re-encrypts every custodial agent wallet still on an older
 * AGENT_WALLET_ENCRYPTION_KEY(_V{n}) onto the latest configured version.
 * Run this after adding a new AGENT_WALLET_ENCRYPTION_KEY_V{n} env var and
 * redeploying; once the response's staleRemaining is 0, the previous key's
 * env var can be safely removed. Platform admin only — this touches every
 * agent's encrypted key material.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { rotateStaleAgentWallets } from "@/lib/agent-wallets";

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const result = await rotateStaleAgentWallets();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to rotate agent wallet keys" },
      { status: 500 },
    );
  }
}
