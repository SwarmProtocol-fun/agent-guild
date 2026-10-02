/**
 * GET  /api/vault/secrets?orgId=   — list secrets (metadata + masked preview only; values are never returned)
 * POST /api/vault/secrets          — { orgId, name, value, description? } create (org owner)
 */
import { NextRequest } from "next/server";
import { createSecret, listSecrets, appendAudit } from "@/lib/vault/store";
import { vaultProviderInfo } from "@/lib/vault/crypto";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    return Response.json({ secrets: await listSecrets(auth.orgId), provider: vaultProviderInfo() });
  } catch (err) {
    return vaultErrorResponse(err, "list secrets");
  }
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const limited = await rateLimit(`vault:${auth.orgId}`);
  if (limited) return limited;
  try {
    const name = String(body.name ?? "").trim();
    const id = await createSecret(auth.orgId, name, String(body.value ?? ""), auth.actor, String(body.description ?? ""));
    await appendAudit({ orgId: auth.orgId, action: "secret.created", actorType: "user", actorId: auth.actor, target: name });
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    return vaultErrorResponse(err, "create secret");
  }
}
