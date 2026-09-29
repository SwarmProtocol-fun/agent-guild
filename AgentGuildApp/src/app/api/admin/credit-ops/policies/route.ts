/**
 * GET /api/admin/credit-ops/policies
 * POST /api/admin/credit-ops/policies
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listPolicies, createDraftPolicy } from "@/lib/credit-ops/policy";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const items = await listPolicies();
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const body = await req.json();
    const id = await createDraftPolicy(body, "platform-admin");
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
