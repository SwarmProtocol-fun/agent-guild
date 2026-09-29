/**
 * GET /api/v1/credit-ops/policy/active — Get the active scoring policy (public)
 */

import { getActivePolicy } from "@/lib/credit-ops/policy";

export async function GET() {
  try {
    const policy = await getActivePolicy();
    return Response.json({ ok: true, policy });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
