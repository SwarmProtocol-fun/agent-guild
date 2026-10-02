/**
 * POST /api/vault/secrets/:id/rotate-now  { orgId }  (org owner)
 * Run the secret's rotation webhook immediately instead of waiting for the schedule.
 */
import { NextRequest } from "next/server";
import { rotateViaWebhook } from "@/lib/vault/rotation";
import { vaultAuth, vaultErrorResponse, readJson } from "@/lib/vault/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const auth = await vaultAuth(req, body.orgId as string, "admin");
  if (!auth.ok) return auth.response;
  try {
    await rotateViaWebhook(auth.orgId, id, { type: "user", id: auth.actor });
    return Response.json({ ok: true });
  } catch (err) {
    return vaultErrorResponse(err, "rotate now");
  }
}
