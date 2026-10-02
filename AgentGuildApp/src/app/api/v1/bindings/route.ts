/**
 * GET /api/v1/bindings?agent=&sig=&ts=   (signed message `GET:/v1/bindings:<ts>`)
 *   or `Authorization: Bearer agt_…` with the bindings:list scope
 *
 * The bindings this agent may call — names, base URLs and limits only. No
 * secret ids or values: the agent doesn't need them and never gets them.
 */
import { NextRequest } from "next/server";
import { requireAgentOrToken } from "@/lib/agent-request-auth";
import { listBindings } from "@/lib/vault/store";
import { agentMayUse } from "@/lib/vault/policy";
import { vaultErrorResponse } from "@/lib/vault/http";
import { rateLimit } from "../rate-limit";

export async function GET(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || request.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentOrToken(request, "GET:/v1/bindings", "bindings:list");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const allowed = auth.agent.allowedBindings;

  try {
    const bindings = (await listBindings(auth.agent.orgId))
      .filter((b) => agentMayUse(b, auth.agent.agentId) && (!allowed || allowed.includes(b.name)))
      .map((b) => ({
        name: b.name,
        description: b.description,
        baseUrl: b.baseUrl,
        allowedMethods: b.allowedMethods,
        allowedPaths: b.allowedPaths,
        maxCallsPerHour: b.maxCallsPerHour,
      }));
    return Response.json({ bindings });
  } catch (err) {
    return vaultErrorResponse(err, "agent list bindings");
  }
}
