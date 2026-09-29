/**
 * GET  /api/compute/templates?category=dev&isPublic=true  — List templates
 * POST /api/compute/templates                              — Create template
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getTemplates, createTemplate } from "@/lib/compute/firestore";
import { slugifyTemplate } from "@/lib/compute/templates";
import type { TemplateCategory } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get("category") as TemplateCategory | null;
  const isPublicParam = req.nextUrl.searchParams.get("isPublic");
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || undefined;

  const templates = await getTemplates({
    category: category || undefined,
    isPublic: isPublicParam ? isPublicParam === "true" : undefined,
    workspaceId,
  });

  return Response.json({ ok: true, templates });
}

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { name, description, category, baseImage, installManifest, startupScript, requiredSecrets, recommendedModels, isPublic, workspaceId } = body;

  if (!name || !category) {
    return Response.json({ error: "name and category are required" }, { status: 400 });
  }
  const VALID_CATEGORIES: TemplateCategory[] = [
    "dev", "browser", "research", "trading", "openclaw", "design", "web3", "sales",
  ];
  if (!VALID_CATEGORIES.includes(category)) {
    return Response.json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` }, { status: 400 });
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return Response.json({ error: "name must be a string between 1 and 100 characters" }, { status: 400 });
  }
  if (startupScript && typeof startupScript === "string" && startupScript.length > 10000) {
    return Response.json({ error: "startupScript must be at most 10000 characters" }, { status: 400 });
  }

  const id = await createTemplate({
    workspaceId: workspaceId || null,
    creatorUserId: wallet,
    name,
    slug: slugifyTemplate(name),
    description: description || "",
    category,
    baseImage: baseImage || "ubuntu:22.04",
    installManifest: installManifest || {},
    startupScript: startupScript || "",
    requiredSecrets: requiredSecrets || [],
    recommendedModels: recommendedModels || [],
    isPublic: isPublic ?? false,
    paidModReady: false,
    futurePriceCents: null,
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
