/**
 * PATCH  /api/compute/memory/[id]  — Update memory entry
 * DELETE /api/compute/memory/[id]  — Delete memory entry
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { updateMemoryEntry, deleteMemoryEntry, getWorkspace } from "@/lib/compute/firestore";

/** Look up memory entry and verify workspace access */
async function getMemoryAndVerifyAccess(req: NextRequest, memoryId: string) {
  const wallet = getWalletAddress(req);
  if (!wallet) return { error: "Authentication required", status: 401 };

  const { adminDb } = await import("@/lib/firebase-admin");
  const snap = await adminDb().collection("computeMemory").doc(memoryId).get();
  if (!snap.exists) return { error: "Memory entry not found", status: 404 };

  const data = snap.data()!;
  // Memory entries scoped to a workspace — verify org access
  if (data.workspaceId) {
    const workspace = await getWorkspace(data.workspaceId);
    if (workspace) {
      const auth = await requireOrgMember(req, workspace.orgId);
      if (!auth.ok) return { error: auth.error, status: auth.status || 401 };
    }
  }

  return { ok: true };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await getMemoryAndVerifyAccess(req, id);
  if (!("ok" in access)) return Response.json({ error: access.error }, { status: access.status });

  const body = await req.json();
  const allowed = ["content", "tags", "pinned"];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  // Validate content length
  if (update.content !== undefined && typeof update.content === "string" && update.content.length > 50_000) {
    return Response.json({ error: "Content exceeds maximum length (50000 chars)" }, { status: 400 });
  }

  // Validate tags array
  if (update.tags !== undefined) {
    if (!Array.isArray(update.tags) || update.tags.length > 20) {
      return Response.json({ error: "Tags must be an array of max 20 items" }, { status: 400 });
    }
  }

  await updateMemoryEntry(id, update);
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await getMemoryAndVerifyAccess(req, id);
  if (!("ok" in access)) return Response.json({ error: access.error }, { status: access.status });

  await deleteMemoryEntry(id);
  return Response.json({ ok: true });
}
