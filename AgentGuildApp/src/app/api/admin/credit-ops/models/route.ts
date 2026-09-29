/**
 * GET /api/admin/credit-ops/models
 * POST /api/admin/credit-ops/models
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listModels, createModel } from "@/lib/credit-ops/model";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const items = await listModels();
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { version, policyId, description, changelog } = body;

  if (!version || !policyId || !description) {
    return Response.json({ error: "version, policyId, and description required" }, { status: 400 });
  }

  try {
    const id = await createModel({ version, policyId, description, changelog: changelog || "", publishedBy: "platform-admin" });
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
