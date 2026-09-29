/**
 * GET /api/admin/analytics/revenue — Consolidated revenue/financial overview
 *
 * Returns marketplace revenue (bucketed by currency), Swarm Compute
 * profitability (USD cents), and subscription counts.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getRevenueOverview } from "@/lib/revenue-analytics";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  try {
    const overview = await getRevenueOverview(30);
    return Response.json({ ok: true, overview });
  } catch (err) {
    console.error("[admin/analytics/revenue]", err);
    return Response.json(
      { ok: false, error: "Failed to fetch revenue analytics" },
      { status: 500 },
    );
  }
}
