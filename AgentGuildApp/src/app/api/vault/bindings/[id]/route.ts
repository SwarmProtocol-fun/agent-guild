/**
 * PATCH  /api/vault/bindings/:id  — { orgId, revoked? , ...any binding field } (org owner).
 *        `{ revoked: true }` cuts every agent off instantly without touching the secret.
 * DELETE /api/vault/bindings/:id?orgId=  (org owner)
 */
import { NextRequest } from "next/server";
import { updateBinding, deleteBinding, listBindings, appendAudit } from "@/lib/vault/store";
import { validateBindingInput } from "@/lib/vault/policy";
import { insecureEgressAllowed } from "@/lib/vault/egress";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  try {
    const current = (await listBindings(auth.orgId)).find((b) => b.id === id);
    if (!current) return Response.json({ error: "Binding not found" }, { status: 404 });

    const { orgId: _o, revoked, ...fields } = body;
    void _o;
    const patch: Record<string, unknown> = {};
    if (Object.keys(fields).length) {
      // Validate the merged result, so a partial update can't produce an invalid binding.
      const parsed = validateBindingInput({ ...current, ...fields }, insecureEgressAllowed());
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      Object.assign(patch, parsed.value);
    }
    if (typeof revoked === "boolean") patch.revoked = revoked;
    if (!Object.keys(patch).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

    await updateBinding(auth.orgId, id, patch);
    await appendAudit({
      orgId: auth.orgId,
      action: revoked === true ? "binding.revoked" : "binding.updated",
      actorType: "user", actorId: auth.actor, target: current.name,
      detail: { fields: Object.keys(patch).join(",") },
    });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "update binding");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "admin");
  if (!auth.ok) return auth.response;
  try {
    await deleteBinding(auth.orgId, id);
    await appendAudit({ orgId: auth.orgId, action: "binding.deleted", actorType: "user", actorId: auth.actor, target: id });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "delete binding");
  }
}
