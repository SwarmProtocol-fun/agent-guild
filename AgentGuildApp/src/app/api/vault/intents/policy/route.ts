/**
 * PUT /api/vault/intents/policy  { orgId, walletId, enabled, networks, allowMainnet, limits, recipientAllowlist, contractAllowlist }
 * Set the signing policy for one of the org's custodial agent wallets (org owner).
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { saveIntentPolicy } from "@/lib/intents/execute";
import { validatePolicy } from "@/lib/intents/policy";
import { appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const walletId = String(body.walletId || "");
  const parsed = validatePolicy(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    const wallet = await adminDb().collection("agentWallets").doc(walletId).get();
    if (!wallet.exists || wallet.data()!.orgId !== auth.orgId) return Response.json({ error: "Wallet not found in this organization" }, { status: 404 });
    await saveIntentPolicy(walletId, auth.orgId, parsed.value, auth.actor);
    await appendAudit({
      orgId: auth.orgId, action: "intent.policy_updated", actorType: "user", actorId: auth.actor, target: walletId,
      detail: { enabled: parsed.value.enabled, networks: parsed.value.networks.join(","), allowMainnet: parsed.value.allowMainnet },
    });
    return Response.json({ ok: true, policy: parsed.value });
  } catch (err) {
    return vaultErrorResponse(err, "save intent policy");
  }
}
