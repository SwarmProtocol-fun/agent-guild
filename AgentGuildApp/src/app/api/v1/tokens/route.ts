/**
 * POST /api/v1/tokens?agent=&sig=&ts=
 * signed message: `POST:/v1/tokens:<sha256(body)>:<ts>`
 * body: { scopes?: string[] | "a,b", bindings?: string[], ttlSeconds?: number }
 *
 * Mint a short-lived bearer token for this agent (see lib/agent-tokens.ts).
 * Only an Ed25519 signature (or API key) can mint — a token can't mint
 * another token, so a leaked token can't extend its own life.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuth } from "@/lib/auth-guard";
import { bearerToken, issueAgentToken, parseScopes, MAX_TTL_SECONDS } from "@/lib/agent-tokens";
import { rateLimit } from "../rate-limit";

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request.nextUrl.searchParams.get("agent") || "anon");
  if (limited) return limited;
  if (bearerToken(request.headers)) {
    return Response.json({ error: "Tokens can't mint tokens — sign this request with the agent key" }, { status: 403 });
  }

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentAuth(request, `POST:/v1/tokens:${bodyHash}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  if (!auth.agent.orgId) return Response.json({ error: "Agent has no organization" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const scopes = parseScopes(body.scopes);
  if (typeof scopes === "string") return Response.json({ error: scopes }, { status: 400 });
  const bindings = Array.isArray(body.bindings) ? body.bindings.map(String).filter(Boolean).slice(0, 50) : undefined;
  const ttlSeconds = body.ttlSeconds == null ? undefined : Number(body.ttlSeconds);
  if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS)) {
    return Response.json({ error: `ttlSeconds must be between 60 and ${MAX_TTL_SECONDS}` }, { status: 400 });
  }

  try {
    const { token, claims } = await issueAgentToken(
      { agentId: auth.agent.agentId, orgId: auth.agent.orgId, agentName: auth.agent.agentName || auth.agent.agentId },
      { scopes, bindings, ttlSeconds },
    );
    return Response.json({ token, scopes: claims.scopes, bindings: claims.bindings ?? null, expiresAt: claims.expiresAt * 1000 });
  } catch (err) {
    console.error("[tokens] issue failed:", err);
    return Response.json({ error: "Failed to issue token" }, { status: 500 });
  }
}
