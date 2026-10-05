/**
 * POST /api/v1/identity/verify  { token, audience }
 *
 * For services that would rather not verify JWTs themselves: checks an agent
 * identity token's signature, issuer, audience and expiry and returns its
 * claims. Public; verifying locally against /.well-known/jwks.json is
 * equivalent and saves the round trip.
 */
import { NextRequest } from "next/server";
import { verifyIdentityToken } from "@/lib/agent-identity";
import { rateLimit } from "../../rate-limit";
import { getClientIp } from "@/lib/client-ip";

export async function POST(req: NextRequest) {
  const limited = await rateLimit(`identity-verify:${getClientIp(req)}`);
  if (limited) return limited;
  let body: { token?: string; audience?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.token || !body.audience) return Response.json({ error: "token and audience are required" }, { status: 400 });
  try {
    const claims = await verifyIdentityToken(body.token, body.audience);
    return Response.json({ valid: true, agentId: claims.sub, claims });
  } catch (err) {
    return Response.json({ valid: false, error: err instanceof Error ? err.message : "Invalid token" }, { status: 401 });
  }
}
