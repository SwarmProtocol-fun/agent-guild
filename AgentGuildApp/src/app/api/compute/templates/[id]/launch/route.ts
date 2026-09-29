/**
 * POST /api/compute/templates/[id]/launch — Launch a computer from a template
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getWorkspace } from "@/lib/compute/firestore";
import { launchFromTemplate } from "@/lib/compute/templates";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, name, sizeKey, region, controllerType, modelKey, autoStart } = body;

  if (!workspaceId || !name) {
    return Response.json({ error: "workspaceId and name are required" }, { status: 400 });
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  try {
    const result = await launchFromTemplate({
      templateId: id,
      workspaceId,
      orgId: ws.orgId,
      name,
      sizeKey,
      region,
      controllerType,
      modelKey,
      createdByUserId: wallet,
      autoStart: autoStart ?? true,
    });
    return Response.json({ ok: true, computerId: result.computerId }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to launch";
    return Response.json({ error: msg }, { status: 500 });
  }
}
