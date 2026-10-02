/**
 * GET /.well-known/jwks.json — public keys for verifying agent identity
 * tokens (lib/agent-identity.ts). Empty key set when identity tokens aren't
 * configured on this deployment.
 */
import { identityJwks } from "@/lib/agent-identity";

export async function GET() {
  try {
    return Response.json(await identityJwks(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[jwks] failed:", err);
    return Response.json({ keys: [] }, { status: 500 });
  }
}
