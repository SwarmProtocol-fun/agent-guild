/**
 * POST /api/v1/identity/token?agent=&sig=&ts=   signed `POST:/v1/identity/token:<sha256(body)>:<ts>`
 *   or `Authorization: Bearer agt_…` with the identity:assert scope
 * body: { audience, nonce? }
 *
 * A 10-minute ES256 identity token for presenting to an outside service
 * (lib/agent-identity.ts). Verify with /.well-known/jwks.json.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";
import { requireAgentOrToken } from "@/lib/agent-request-auth";
import { identityConfigured, issueIdentityToken, validAudience } from "@/lib/agent-identity";
import { rateLimit } from "../../rate-limit";

export async function POST(request: NextRequest) {
  const limited = await rateLimit(`identity:${request.nextUrl.searchParams.get("agent") || "token"}`);
  if (limited) return limited;
  if (!identityConfigured()) return Response.json({ error: "Agent identity tokens aren't enabled on this deployment" }, { status: 503 });

  const rawBody = await request.text();
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const auth = await requireAgentOrToken(request, `POST:/v1/identity/token:${bodyHash}`, "identity:assert");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const audience = String(body.audience || "");
  if (!validAudience(audience)) {
    return Response.json({ error: "audience must be the service's https origin (or a service id like urn:acme:api)" }, { status: 400 });
  }
  try {
    const { token, expiresAt, claims } = await issueIdentityToken(auth.agent, audience, body.nonce ? String(body.nonce) : undefined);
    return Response.json({ token, expiresAt, claims, jwks: "https://agent-guild.com/.well-known/jwks.json" });
  } catch (err) {
    console.error("[identity] issue failed:", err);
    return Response.json({ error: "Failed to issue identity token" }, { status: 500 });
  }
}
