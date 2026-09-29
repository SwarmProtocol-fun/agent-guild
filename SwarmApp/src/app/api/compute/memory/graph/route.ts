/**
 * GET /api/compute/memory/graph?orgId=&type=&id=&relation=
 * Edges touching one entity (either endpoint), newest first. One-hop
 * lookup, not multi-hop graph traversal — Context Vault PRD §28/§76.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { getRelatedEntities, InvalidGraphEntityError } from "@/lib/compute/graph";
import type { GraphEntityType } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId");
  const type = sp.get("type");
  const id = sp.get("id");
  const relation = sp.get("relation") || undefined;
  const limit = sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined;

  if (!orgId || !type || !id) {
    return Response.json({ error: "orgId, type, and id are required" }, { status: 400 });
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  try {
    const edges = await getRelatedEntities(orgId, { type: type as GraphEntityType, id }, { relation, limit });
    return Response.json({ ok: true, edges });
  } catch (err) {
    if (err instanceof InvalidGraphEntityError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
