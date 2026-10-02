/**
 * POST /api/vault/runtimes/revoke  { orgId, computerId }  (org owner)
 * Kill a runtime's credential. Tokens it already minted expire within the
 * hour; use /api/vault/tokens/revoke on the agent to cut those off now.
 */
import { NextRequest } from "next/server";
import { revokeRuntime } from "@/lib/vault/runtimes";
import { appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  try {
    await revokeRuntime(auth.orgId, String(body.computerId || ""));
    await appendAudit({ orgId: auth.orgId, action: "runtime.revoked", actorType: "user", actorId: auth.actor, target: String(body.computerId) });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "revoke runtime");
  }
}
