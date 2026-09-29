/**
 * DELETE /api/secrets/[id] - Delete a secret
 *
 * Body: { orgId: string }
 */
import { NextRequest } from "next/server";
import { deleteSecret } from "@/lib/secrets";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`secrets:${ip}`);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = body.orgId as string | undefined;
  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Auth: caller must be a member of the org that owns the secret
  const auth = await requireOrgMember(request, orgId);
  if (!auth.ok) {
    return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
  }

  try {
    await deleteSecret(id, orgId, orgId);
    return Response.json({ ok: true, message: "Secret deleted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete secret";
    const status = message.includes("not found") ? 404 : message.includes("not belong") ? 403 : 500;
    return Response.json({ error: message }, { status });
  }
}
