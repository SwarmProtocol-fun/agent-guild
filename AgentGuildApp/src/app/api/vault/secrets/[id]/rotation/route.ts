/**
 * PUT    /api/vault/secrets/:id/rotation   { orgId, intervalDays, mode: "remind"|"webhook", webhookUrl? }  (org owner)
 *        Response includes `signingSecret` when a webhook signing secret was generated — shown this once only.
 * DELETE /api/vault/secrets/:id/rotation?orgId=   turn scheduled rotation off (org owner)
 */
import { NextRequest } from "next/server";
import { setRotationPolicy, clearRotationPolicy, validateRotationInput } from "@/lib/vault/rotation";
import { appendAudit } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  const input = validateRotationInput(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  try {
    const { signingSecret } = await setRotationPolicy(auth.orgId, id, input);
    await appendAudit({
      orgId: auth.orgId, action: "secret.rotation_configured", actorType: "user", actorId: auth.actor, target: id,
      detail: { intervalDays: input.intervalDays, mode: input.mode, ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}) },
    });
    return Response.json({ ok: true, signingSecret });
  } catch (err) {
    return vaultErrorResponse(err, "set rotation");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "admin");
  if (!auth.ok) return auth.response;
  try {
    await clearRotationPolicy(auth.orgId, id);
    await appendAudit({ orgId: auth.orgId, action: "secret.rotation_configured", actorType: "user", actorId: auth.actor, target: id, detail: { mode: "off" } });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "clear rotation");
  }
}
