/**
 * GET /api/admin/credit-ops/disputes
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listDisputes } from "@/lib/credit-ops/disputes";
import type { DisputeStatus } from "@/lib/credit-ops/types";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const status = url.searchParams.get("status") as DisputeStatus | null;

  try {
    const items = await listDisputes({ status: status || undefined });
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
