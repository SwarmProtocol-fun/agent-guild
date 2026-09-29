/**
 * GET /api/compute/files?workspaceId=xxx&computerId=yyy — List files in workspace
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getFiles, getWorkspace } from "@/lib/compute/firestore";

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return Response.json({ error: "workspaceId required" }, { status: 400 });

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const computerId = req.nextUrl.searchParams.get("computerId") || undefined;
  const files = await getFiles(workspaceId, computerId);
  return Response.json({ ok: true, files });
}
