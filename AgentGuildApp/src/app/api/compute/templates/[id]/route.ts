/**
 * GET    /api/compute/templates/[id]  — Get template details
 * PATCH  /api/compute/templates/[id]  — Update template
 * DELETE /api/compute/templates/[id]  — Delete template
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getTemplate, updateTemplate, deleteTemplate } from "@/lib/compute/firestore";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const template = await getTemplate(id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

  // Public templates are readable by anyone; private templates require auth
  if (!template.isPublic) {
    const wallet = getWalletAddress(req);
    if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  return Response.json({ ok: true, template });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const template = await getTemplate(id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

  if (template.creatorUserId !== wallet) {
    return Response.json({ error: "Only the creator can update this template" }, { status: 403 });
  }

  const body = await req.json();
  const allowed = ["name", "description", "category", "baseImage", "installManifest", "startupScript", "requiredSecrets", "recommendedModels", "isPublic"];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  await updateTemplate(id, update);
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const template = await getTemplate(id);
  if (!template) return Response.json({ error: "Template not found" }, { status: 404 });

  if (template.creatorUserId !== wallet) {
    return Response.json({ error: "Only the creator can delete this template" }, { status: 403 });
  }

  await deleteTemplate(id);
  return Response.json({ ok: true });
}
