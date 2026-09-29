/**
 * GET  /api/compute/workspaces?orgId=xxx  — List workspaces for an org
 * POST /api/compute/workspaces             — Create a new workspace
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember, requireOrgAdmin } from "@/lib/auth-guard";
import { getWorkspaces, createWorkspace } from "@/lib/compute/firestore";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) return Response.json({ error: "orgId required" }, { status: 400 });

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const workspaces = await getWorkspaces(orgId);
  return Response.json({ ok: true, workspaces });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { orgId, name, description, slug, defaultProvider } = body;

  if (!orgId || !name) {
    return Response.json({ error: "orgId and name are required" }, { status: 400 });
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return Response.json({ error: "name must be a string between 1 and 100 characters" }, { status: 400 });
  }
  const VALID_PROVIDERS = ["e2b", "aws", "gcp", "azure", "stub"];
  if (defaultProvider && !VALID_PROVIDERS.includes(defaultProvider)) {
    return Response.json({ error: `Invalid defaultProvider. Must be one of: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 });
  }

  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const id = await createWorkspace({
    orgId,
    ownerUserId: auth.walletAddress!,
    name: name.trim(),
    slug: slug || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    description: description || "",
    planTier: "free",
    defaultProvider: defaultProvider || "e2b",
    defaultAutoStopMinutes: 30,
    allowedInstanceSizes: ["small", "medium", "large"],
    staticIpEnabled: false,
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
