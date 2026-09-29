/**
 * Agent Identity Guard — the "NFT/vault credential" gate, split out of
 * auth-guard.ts specifically to keep auth-guard.ts client-bundle-safe.
 *
 * auth-guard.ts is reachable from the browser bundle through a pre-existing
 * chain (src/lib/firestore.ts's `await import("@/lib/auth-guard")`, used by
 * the client-side OrgContext). mod-stubs.ts's getAgentIdentity() imports
 * firebase-admin (Node-only: grpc/tls/net), so calling it from anything
 * auth-guard.ts statically or dynamically reaches breaks the browser build.
 *
 * This file is imported only by route.ts files (never client-bundled), so
 * it's the safe place for requireAgentIdentity/requireWalletOrAgentIdentity
 * to live. requireAgentAuth itself is fine to import here — it and its own
 * dependencies (verify.ts, webhooks/auth.ts) are deliberately client-SDK
 * only, with no Admin SDK anywhere in that graph.
 */
import { NextRequest } from "next/server";
import { requireAgentAuth, getWalletAddress, type AgentAuthResult } from "./auth-guard";
import { getAgentIdentity } from "./mod-stubs";

export interface AgentIdentityAuthResult {
  ok: boolean;
  agent?: AgentAuthResult["agent"];
  identity?: import("./mod-stubs").AgentIdentityRecord;
  error?: string;
  status?: number;
}

/**
 * Authenticate an agent (Ed25519 or API key, via requireAgentAuth) AND
 * confirm it has an issued identity credential (agentIdentities/{agentId}
 * — see issueAgentIdentity in mod-stubs.ts). This is the actual "the NFT
 * grants vault access" gate: identity issuance happens synchronously at
 * registration, so a legitimately registered agent is never locked out by
 * an async mint race — an agent only fails this check if it has never
 * completed /api/v1/register at all.
 */
export async function requireAgentIdentity(
  req: NextRequest,
  signedMessagePrefix?: string,
): Promise<AgentIdentityAuthResult> {
  const authCheck = await requireAgentAuth(req, signedMessagePrefix);
  if (!authCheck.ok || !authCheck.agent) {
    return { ok: false, error: authCheck.error || "Unauthorized", status: 401 };
  }

  const identity = await getAgentIdentity(authCheck.agent.agentId);
  if (!identity) {
    return {
      ok: false,
      error: "No identity credential issued for this agent — complete /api/v1/register first",
      status: 403,
    };
  }

  return { ok: true, agent: authCheck.agent, identity };
}

export interface WalletOrAgentAuthResult {
  ok: boolean;
  walletAddress?: string;
  agent?: AgentAuthResult["agent"];
  error?: string;
  status?: number;
}

/**
 * Allow either a human wallet session (`x-wallet-address`, the existing
 * dashboard/workspace auth tier) OR an authenticated agent with an issued
 * identity credential — the raw-REST onramp for agents that aren't calling
 * through the MCP server. Used by the /api/compute/memory/* routes so an
 * agent can read/write its own vault entries by its own Ed25519 signature,
 * without needing a human's browser wallet session.
 */
export async function requireWalletOrAgentIdentity(
  req: NextRequest,
  signedMessagePrefix?: string,
): Promise<WalletOrAgentAuthResult> {
  const wallet = getWalletAddress(req);
  if (wallet) {
    return { ok: true, walletAddress: wallet };
  }

  const identityCheck = await requireAgentIdentity(req, signedMessagePrefix);
  if (identityCheck.ok && identityCheck.agent) {
    return { ok: true, agent: identityCheck.agent };
  }

  return { ok: false, error: identityCheck.error || "Authentication required", status: identityCheck.status || 401 };
}
