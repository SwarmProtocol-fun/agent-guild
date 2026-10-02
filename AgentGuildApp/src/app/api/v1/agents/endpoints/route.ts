/**
 * PUT /api/v1/agents/endpoints?agent=&sig=&ts=
 * signed message: `PUT:/v1/agents/endpoints:<sha256(body)>:<ts>`
 * body: { mcp?, a2a?, website? }  — a URL sets it, null clears it
 *
 * GET /api/v1/agents/endpoints?agent=&sig=&ts=  (signed `GET:/v1/agents/endpoints:<ts>`)
 *
 * The endpoints this agent publishes in the public directory. They only
 * appear there if the agent's privacy settings make its profile public.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentAuth } from "@/lib/auth-guard";
import { getEndpoints, updateEndpoints } from "@/lib/agent-endpoints";
import { rateLimit } from "../../rate-limit";

export async function GET(request: NextRequest) {
  const limited = await rateLimit(request.nextUrl.searchParams.get("agent") || "anon");
  if (limited) return limited;
  const auth = await requireAgentAuth(request, "GET:/v1/agents/endpoints");
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
  return Response.json({ endpoints: await getEndpoints(auth.agent.agentId) });
}

export async function PUT(request: NextRequest) {
  const limited = await rateLimit(request.nextUrl.searchParams.get("agent") || "anon");
  if (limited) return limited;
  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentAuth(request, `PUT:/v1/agents/endpoints:${bodyHash}`);
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    return Response.json({ ok: true, endpoints: await updateEndpoints(auth.agent.agentId, body) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Update failed" }, { status: 400 });
  }
}
