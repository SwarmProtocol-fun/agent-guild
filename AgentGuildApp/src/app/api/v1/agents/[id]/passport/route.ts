/**
 * GET /api/v1/agents/:id/passport
 *
 * Returns the agent's Passport — identity, wallets, capabilities, and
 * reputation in one object (see lib/agent-passport.ts).
 *
 * Auth is optional here, unlike heartbeat/capabilities: an org member reads
 * their own agent's full passport by authenticating (Ed25519 or API key,
 * same params as /v1/agents), but anyone can read a *public* agent's
 * passport with no auth at all — that's the whole point of a passport
 * other agents need to be able to look up before hiring. A private agent
 * returns 404 either way, so a no-auth caller can't use this to probe which
 * agent IDs exist.
 *
 * Query params:
 *   agent, sig, ts        — Ed25519 auth (optional)
 *   agentId, apiKey        — API key auth (optional, only read if Ed25519 absent)
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { authenticateAgent } from "@/app/api/webhooks/auth";
import { buildAgentPassport } from "@/lib/agent-passport";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await params;
  const url = req.nextUrl;

  const rateLimited = await rateLimit(url.searchParams.get("agent") || url.searchParams.get("agentId") || "anon");
  if (rateLimited) return rateLimited;

  let viewerOrgId: string | undefined;

  const callerAgent = url.searchParams.get("agent");
  const sig = url.searchParams.get("sig");
  const ts = url.searchParams.get("ts");
  if (callerAgent && sig && ts) {
    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return Response.json({ error: "Stale timestamp" }, { status: 401 });
    }
    const message = `GET:/v1/agents/${agentId}/passport:${callerAgent}:${ts}`;
    const verified = await verifyAgentRequest(callerAgent, message, sig);
    if (verified) viewerOrgId = verified.orgId;
  } else {
    const paramAgentId = url.searchParams.get("agentId");
    const apiKey = url.searchParams.get("apiKey");
    if (paramAgentId && apiKey) {
      const auth = await authenticateAgent(paramAgentId, apiKey);
      if (auth) viewerOrgId = auth.orgId;
    }
  }

  try {
    const passport = await buildAgentPassport(agentId, { viewerOrgId });
    if (!passport) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    return Response.json({ passport });
  } catch (err) {
    console.error("agents/passport error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
