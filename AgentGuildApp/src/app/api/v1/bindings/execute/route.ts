/**
 * POST /api/v1/bindings/execute?agent=&sig=&ts=
 * signed message: `POST:/v1/bindings/execute:<sha256(body)>:<ts>`
 *   or: `Authorization: Bearer agt_…` with the bindings:execute scope
 * body: { binding, method, path, query?, headers?, body? }
 *
 * Calls an external API through an org-configured binding. The server
 * injects the credential; the agent only ever sees the (redacted) response.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentOrToken } from "@/lib/agent-request-auth";
import { executeBinding } from "@/lib/vault/execute";
import { vaultErrorResponse } from "@/lib/vault/http";
import { rateLimit } from "../../rate-limit";

export async function POST(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent") || request.nextUrl.searchParams.get("agentId") || "";
  const limited = await rateLimit(agentParam || "anon");
  if (limited) return limited;

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentOrToken(request, `POST:/v1/bindings/execute:${bodyHash}`, "bindings:execute");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.agent.orgId) return Response.json({ error: "Agent has no organization" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.binding) return Response.json({ error: "binding is required" }, { status: 400 });

  try {
    const result = await executeBinding(auth.agent, {
      binding: String(body.binding),
      method: String(body.method || "GET"),
      path: String(body.path || "/"),
      query: (body.query as Record<string, string>) || undefined,
      headers: (body.headers as Record<string, string>) || undefined,
      body: body.body,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return vaultErrorResponse(err, "execute binding");
  }
}
