/**
 * DELETE /api/compute/files/[id] — Delete a file record
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { deleteFileRecord, getFiles, getWorkspace } from "@/lib/compute/firestore";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  // Look up the file to verify workspace access
  // Since we don't have a getFile(id) helper, we need to verify via workspace
  // For now, we check the file exists by trying to find it in any accessible workspace
  // A proper getFile(id) should be added
  const { adminDb } = await import("@/lib/firebase-admin");
  const snap = await adminDb().collection("computeFiles").doc(id).get();
  if (!snap.exists) return Response.json({ error: "File not found" }, { status: 404 });

  const fileData = snap.data()!;
  const workspace = await getWorkspace(fileData.workspaceId);
  if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, workspace.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  await deleteFileRecord(id);
  return Response.json({ ok: true });
}
