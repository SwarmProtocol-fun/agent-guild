/**
 * GET /api/v1/bindings?agent=&sig=&ts=   (signed message `GET:/v1/bindings:<ts>`)
 *
 * The bindings this agent may call — names, base URLs and limits only. No
 * secret ids or values: the agent doesn't need them and never gets them.
 */
import { NextRequest } from "next/server";
import { requireAgentAuth } from "@/lib/auth-guard";
import { listBindings } from "@/lib/vault/store";
import { agentMayUse } from "@/lib/vault/policy";
import { vaultErrorResponse } from "@/lib/vault/http";
import { rateLimit } from "../rate-limit";

export async function GET(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || request.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const auth = await requireAgentAuth(request, "GET:/v1/bindings");
  if (!auth.ok || !auth.agent) return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });

  try {
    const bindings = (await listBindings(auth.agent.orgId))
      .filter((b) => agentMayUse(b, auth.agent!.agentId))
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
