/**
 * GET /api/vault/intents?orgId=  — the org's custodial agent wallets with their
 * signing policies, and the latest 100 intents (org member).
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getIntentPolicy } from "@/lib/intents/execute";
import { isTestnet, mainnetAllowedOnServer } from "@/lib/intents/policy";
import { ENABLED_CHAINS } from "@/lib/chains";
import { vaultAuth, vaultErrorResponse } from "@/lib/vault/http";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    const [walletSnap, intentSnap] = await Promise.all([
      adminDb().collection("agentWallets").where("orgId", "==", auth.orgId).get(),
      adminDb().collection("intents").where("orgId", "==", auth.orgId).orderBy("createdAt", "desc").limit(100).get(),
    ]);
    const wallets = await Promise.all(walletSnap.docs.map(async (d) => {
      const w = d.data();
      return { id: d.id, agentId: w.agentId, chain: w.chain ?? "solana", publicKey: w.publicKey, label: w.label ?? null, policy: await getIntentPolicy(d.id) };
    }));
    const intents = intentSnap.docs.map((d) => {
      const x = d.data();
      return { id: d.id, agentId: x.agentId, walletId: x.walletId, request: x.request, status: x.status, error: x.error ?? null, txHash: x.txHash ?? null, explorerUrl: x.explorerUrl ?? null, createdAt: x.createdAt?.toMillis?.() ?? null };
    });
    const networks = ENABLED_CHAINS.map((c) => ({ key: c.key, name: c.name, evm: c.key !== "solana", testnet: isTestnet(c.key) }));
    return Response.json({ wallets, intents, networks, mainnetAllowed: mainnetAllowedOnServer() });
  } catch (err) {
    return vaultErrorResponse(err, "list intents");
  }
}
