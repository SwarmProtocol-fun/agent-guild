/**
 * GET  /api/v1/agents/:id/wallets?org=xxx  — list an agent's custodial
 *      wallets with live balances.
 * POST /api/v1/agents/:id/wallets           — generate a new one.
 *      Body: { orgId, label?, chain?: "solana" | "evm", hyperliquid?: { masterSecret, network? } }
 *
 * These are platform-generated keypairs held on the agent's behalf (see
 * lib/agent-wallets.ts) — separate from the agent's own Ed25519 identity
 * wallet under /api/v1/solana/wallet/generate. An "evm" wallet can
 * optionally be registered with mods/hyperliquid-trading in the same call
 * by passing `hyperliquid.masterSecret` — that passphrase is used once,
 * transiently, and never persisted (see agent-wallets.ts module doc for
 * why that mod is zero-knowledge by design). Auth: org membership, since
 * this creates/reads custody over funds.
 */
import { NextRequest } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import {
  generateAgentWallet,
  listAgentWallets,
  getAgentWalletBalance,
  MAX_WALLETS_PER_AGENT,
  type AgentWalletChain,
  type HyperliquidNetwork,
} from "@/lib/agent-wallets";

async function resolveAgent(agentId: string, orgId: string) {
  const agent = await getAgent(agentId);
  if (!agent) return { error: "Agent not found", status: 404 as const };
  if (agent.orgId !== orgId) return { error: "Agent does not belong to this organization", status: 403 as const };
  return { agent };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await params;
  const orgId = req.nextUrl.searchParams.get("org");
  if (!orgId) {
    return Response.json({ error: "org parameter is required" }, { status: 400 });
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

  const resolved = await resolveAgent(agentId, orgId);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });

  try {
    const wallets = await listAgentWallets(agentId);
    const withBalances = await Promise.all(
      wallets.map(async (w) => ({
        ...w,
        balance: await getAgentWalletBalance(w).catch(() => ({ sol: null, usdc: null, hyperliquidEquity: null })),
      })),
    );
    return Response.json({ wallets: withBalances, max: MAX_WALLETS_PER_AGENT });
  } catch (err) {
    console.error("List agent wallets error:", err);
    return Response.json({ error: "Failed to list wallets" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = body.orgId as string | undefined;
  const label = body.label as string | undefined;
  const chain = body.chain as AgentWalletChain | undefined;
  const hyperliquid = body.hyperliquid as { masterSecret?: string; network?: HyperliquidNetwork } | undefined;
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }
  if (chain && chain !== "solana" && chain !== "evm") {
    return Response.json({ error: 'chain must be "solana" or "evm"' }, { status: 400 });
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

  const resolved = await resolveAgent(agentId, orgId);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });

  try {
    const wallet = await generateAgentWallet(agentId, orgId, auth.walletAddress || "unknown", {
      label,
      chain,
      hyperliquid: hyperliquid?.masterSecret ? { masterSecret: hyperliquid.masterSecret, network: hyperliquid.network } : undefined,
    });
    const balance = await getAgentWalletBalance(wallet).catch(() => ({ sol: null, usdc: null, hyperliquidEquity: null }));
    return Response.json({ wallet: { ...wallet, balance } });
  } catch (err) {
    console.error("Generate agent wallet error:", err);
    const message = err instanceof Error ? err.message : "Failed to generate wallet";
    return Response.json({ error: message }, { status: 500 });
  }
}
