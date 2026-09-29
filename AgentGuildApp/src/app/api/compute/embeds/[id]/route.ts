/**
 * DELETE /api/compute/embeds/[id] — Revoke an embed token
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { deleteEmbedToken, validateEmbedToken, getWorkspace } from "@/lib/compute/firestore";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  // Look up the embed token to verify workspace access
  // Use a direct Firestore read since validateEmbedToken rejects expired tokens
  const { adminDb } = await import("@/lib/firebase-admin");
  const snap = await adminDb().collection("computeEmbedTokens").doc(id).get();
  if (!snap.exists) return Response.json({ error: "Embed token not found" }, { status: 404 });

  const tokenData = snap.data()!;
  const workspace = await getWorkspace(tokenData.workspaceId);
  if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, workspace.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  await deleteEmbedToken(id);
  return Response.json({ ok: true });
}
