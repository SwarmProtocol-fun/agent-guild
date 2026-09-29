/**
 * POST /api/compute/memory/link — create a knowledge-graph edge between
 * two entities (agent/task/project/memory/document). Context Vault PRD
 * §27/§76/§139.
 */
import { NextRequest } from "next/server";
import { requireOrgMember } from "@/lib/auth-guard";
import { linkEntities, InvalidGraphEntityError } from "@/lib/compute/graph";
import type { GraphEntityType } from "@/lib/compute/types";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { orgId, fromType, fromId, toType, toId, relation } = body;

  if (!orgId || !fromType || !fromId || !toType || !toId || !relation) {
    return Response.json(
      { error: "orgId, fromType, fromId, toType, toId, and relation are required" },
      { status: 400 },
    );
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  try {
    const id = await linkEntities(
      orgId,
      { type: fromType as GraphEntityType, id: fromId },
      { type: toType as GraphEntityType, id: toId },
      relation,
    );
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidGraphEntityError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
