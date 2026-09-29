/**
 * GET /api/admin/analytics/overview — Platform-wide analytics overview
 *
 * Returns DAU, WAU, MAU, session counts, avg duration, active users,
 * and a 30-day daily sessions trend for charting.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getAnalyticsOverview } from "@/lib/platform-analytics";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  try {
    const overview = await getAnalyticsOverview();
    return Response.json({ ok: true, overview });
  } catch (err) {
    console.error("[admin/analytics/overview]", err);
    return Response.json(
      { ok: false, error: "Failed to fetch analytics overview" },
      { status: 500 },
    );
  }
}
