/**
 * GET /api/admin/analytics/users — User profiles with engagement stats
 *
 * Query params:
 *   ?limit=50                        — max results (default 50, max 200)
 *   ?sort=lastSeen|totalSessions|totalTimeMs  — sort field (default lastSeen)
 *   ?search=0x...                    — filter by wallet substring
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getUserProfiles } from "@/lib/platform-analytics";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  const params = req.nextUrl.searchParams;
  const max = Math.min(Number(params.get("limit")) || 50, 200);
  const sortBy = (params.get("sort") || "lastSeen") as "lastSeen" | "totalSessions" | "totalTimeMs";
  const search = params.get("search") || undefined;

  try {
    const users = await getUserProfiles({ max, sortBy, search });
    return Response.json({ ok: true, users });
  } catch (err) {
    console.error("[admin/analytics/users]", err);
    return Response.json(
      { ok: false, error: "Failed to fetch user profiles" },
      { status: 500 },
    );
  }
}
