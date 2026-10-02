/**
 * Authenticate an agent request either way:
 *   - `Authorization: Bearer agt_…` — a short-lived token (agent-tokens.ts),
 *     which must carry `scope`; or
 *   - the usual Ed25519 signature / API key (auth-guard requireAgentAuth).
 *
 * A signature carries full agent authority; a token carries only its scopes
 * and, if it lists bindings, only those bindings.
 */
import type { NextRequest } from "next/server";
import { requireAgentAuth } from "./auth-guard";
import { bearerToken, verifyAgentToken, type TokenScope } from "./agent-tokens";

export interface AuthedAgent {
  agentId: string;
  agentName: string;
  orgId: string;
  /** Set when authenticated by a token that is restricted to specific bindings. */
  allowedBindings?: string[];
  via: "signature" | "token";
}

export async function requireAgentOrToken(
  req: NextRequest,
  signedPrefix: string,
  scope: TokenScope,
): Promise<{ ok: true; agent: AuthedAgent } | { ok: false; status: number; error: string }> {
  const token = bearerToken(req.headers);
  if (token) {
    const claims = await verifyAgentToken(token);
    if (!claims) return { ok: false, status: 401, error: "Invalid, expired or revoked token" };
    if (!claims.scopes.includes(scope)) return { ok: false, status: 403, error: `Token lacks the ${scope} scope` };
    return {
      ok: true,
      agent: { agentId: claims.agentId, agentName: claims.agentName, orgId: claims.orgId, allowedBindings: claims.bindings, via: "token" },
    };
  }
  const auth = await requireAgentAuth(req, signedPrefix);
  if (!auth.ok || !auth.agent) return { ok: false, status: 401, error: auth.error || "Unauthorized" };
  return {
    ok: true,
    agent: { agentId: auth.agent.agentId, agentName: auth.agent.agentName || auth.agent.agentId, orgId: auth.agent.orgId, via: "signature" },
  };
}
