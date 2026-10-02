/**
 * POST /api/vault/tokens/revoke  { orgId, agentId }  (org owner)
 *
 * Invalidate every short-lived token issued to one of the org's agents.
 * The agent's Ed25519 key keeps working; only bearer tokens are cut off.
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { revokeAgentTokens } from "@/lib/agent-tokens";
import { appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const agentId = String(body.agentId || "");
  try {
    const snap = await adminDb().collection("agents").doc(agentId).get();
    if (!snap.exists || (snap.data()!.orgId || snap.data()!.organizationId) !== auth.orgId) {
      return Response.json({ error: "Agent not found in this organization" }, { status: 404 });
    }
    await revokeAgentTokens(agentId);
    await appendAudit({ orgId: auth.orgId, action: "tokens.revoked", actorType: "user", actorId: auth.actor, target: agentId });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "revoke tokens");
  }
}
