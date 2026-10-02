/**
 * PUT    /api/vault/secrets/:id   — { orgId, value } rotate (org owner). Bindings pick up the new value immediately.
 * DELETE /api/vault/secrets/:id?orgId=  — delete (org owner); refused while a binding still uses it.
 */
import { NextRequest } from "next/server";
import { rotateSecret, deleteSecret, appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  try {
    await rotateSecret(auth.orgId, id, String(body.value ?? ""));
    await appendAudit({ orgId: auth.orgId, action: "secret.rotated", actorType: "user", actorId: auth.actor, target: id });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "rotate secret");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "admin");
  if (!auth.ok) return auth.response;
  try {
    await deleteSecret(auth.orgId, id);
    await appendAudit({ orgId: auth.orgId, action: "secret.deleted", actorType: "user", actorId: auth.actor, target: id });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "delete secret");
  }
}
