/**
 * GET /api/v1/identity-vault?agent=&sig=&ts=
 * signed message: "GET:/v1/identity-vault:<agentId>:<ts>"
 *
 * Slot names and sizes, plus the three Solana addresses a put must seal
 * to (protocol, agent, user). Ciphertext stays on the slot route.
 */
import { NextRequest } from "next/server";
import { requireAgentAuth } from "@/lib/auth-guard";
import { listIdentityVault, unlockIdentityVault, VaultError } from "@/lib/identity-vault";
import { rateLimit } from "../rate-limit";

export async function GET(req: NextRequest) {
  const agentParam = req.nextUrl.searchParams.get("agent") || req.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(req, `GET:/v1/identity-vault:${agentParam}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  try {
    const unlocked = await unlockIdentityVault(auth.agent.agentId);
    const slots = await listIdentityVault(auth.agent.agentId);
    return Response.json({ agentId: auth.agent.agentId, slots, recipients: unlocked.recipients });
  } catch (err) {
    if (err instanceof VaultError) return Response.json({ error: err.message }, { status: err.status });
    console.error("GET /v1/identity-vault error:", err);
    return Response.json({ error: "Failed to list the identity vault" }, { status: 500 });
  }
}
