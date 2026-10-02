/**
 * GET  /api/v1/agents/:id/wallets  — list an agent's wallets with live
 *      balances: the identity row first, then custodial ones (see
 *      listPublicAgentWallets). Returns { wallets, generated, max }.
 *      Two callers: an org member (?org=xxx, wallet session), or the agent
 *      itself (?agent=&sig=&ts=, message "GET:/v1/agents/<id>/wallets:<ts>").
 * POST /api/v1/agents/:id/wallets           — generate a new one.
 *      Body: { orgId, label?, chain?: "solana" | "evm", hyperliquid?: { masterSecret, network? } }
 *
 * These are platform-generated keypairs held on the agent's behalf (see
 * lib/agent-wallets.ts) — separate from the agent's own Ed25519 identity
 * wallet under /api/v1/solana/wallet/generate. An "evm" wallet can
 * optionally be registered with mods/hyperliquid-trading in the same call
 * by passing `hyperliquid.masterSecret` — that passphrase is used once,
 * transiently, and never persisted (see agent-wallets.ts module doc for
 * why that mod is zero-knowledge by design). POST auth: org membership
 * only, since it creates custody over funds — an agent cannot mint itself
 * wallets.
 */
import { NextRequest } from "next/server";
import { requireOrgMember, requireAgentAuth, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { getAgent } from "@/lib/firestore-admin";
import {
  generateAgentWallet,
  listPublicAgentWallets,
  getAgentWalletBalance,
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
  const url = req.nextUrl;
  let orgId: string;

  if (url.searchParams.get("agent")) {
    // The agent reading its own list — Ed25519 only, no API-key fallback.
    if (!url.searchParams.get("sig") || !url.searchParams.get("ts")) return unauthorized("sig and ts are required");
    const limited = await rateLimit(url.searchParams.get("agent")!);
    if (limited) return limited;
    const auth = await requireAgentAuth(req, `GET:/v1/agents/${agentId}/wallets`);
    if (!auth.ok || !auth.agent) return unauthorized(auth.error);
    if (auth.agent.agentId !== agentId) return forbidden("An agent may only read its own wallets");
    if (!auth.agent.orgId) return forbidden("Agent has no organization");
    orgId = auth.agent.orgId;
  } else {
    const orgParam = url.searchParams.get("org");
    if (!orgParam) return unauthorized("Sign in as an org member (?org=) or sign as the agent (?agent=&sig=&ts=)");
    const auth = await requireOrgMember(req, orgParam);
    if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
    orgId = orgParam;
  }

  const resolved = await resolveAgent(agentId, orgId);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });

  try {
    return Response.json(await listPublicAgentWallets(agentId, resolved.agent));
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
