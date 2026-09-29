/**
 * POST /api/compute/files/upload — Upload a file record (metadata only; actual upload goes to storage)
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { createFileRecord, getWorkspace } from "@/lib/compute/firestore";

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, computerId, filename, mimeType, sizeBytes, storageKey, visibility } = body;

  if (!workspaceId || !filename || !storageKey) {
    return Response.json({ error: "workspaceId, filename, and storageKey are required" }, { status: 400 });
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const id = await createFileRecord({
    workspaceId,
    computerId: computerId || null,
    uploaderUserId: wallet,
    storageKey,
    filename,
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: sizeBytes || 0,
    visibility: visibility || "private",
    provenanceType: "upload",
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
