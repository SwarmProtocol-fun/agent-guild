/**
 * GET /api/admin/analytics/sessions — Paginated session log
 *
 * Query params:
 *   ?limit=50     — max results (default 50, max 200)
 *   ?wallet=0x... — filter by wallet address
 *   ?dateFrom=YYYY-MM-DD — filter sessions from date
 *   ?dateTo=YYYY-MM-DD   — filter sessions to date
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getRecentSessions } from "@/lib/platform-analytics";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  const params = req.nextUrl.searchParams;
  const max = Math.min(Number(params.get("limit")) || 50, 200);
  const wallet = params.get("wallet") || undefined;
  const dateFrom = params.get("dateFrom") || undefined;
  const dateTo = params.get("dateTo") || undefined;

  try {
    const sessions = await getRecentSessions({ max, wallet, dateFrom, dateTo });
    return Response.json({ ok: true, sessions });
  } catch (err) {
    console.error("[admin/analytics/sessions]", err);
    return Response.json(
      { ok: false, error: "Failed to fetch sessions" },
      { status: 500 },
    );
  }
}
