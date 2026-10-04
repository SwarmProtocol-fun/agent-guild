/**
 * GET /api/v1/featured?slot=landing
 *
 * Public: the admin-curated featured items for one page slot, resolved to
 * display-ready items (see lib/featured.ts for slots). `curated: false` means
 * no admin picks are set and the page should fall back to its default.
 */
import { NextRequest } from "next/server";
import { isFeaturedSlotId } from "@/lib/featured";
import { getResolvedFeaturedSlot } from "@/lib/featured-server";

// Same as /api/v1/gigs — identical for every visitor, so the edge can hold it
// briefly. Admin changes show up within about a minute.
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function GET(req: NextRequest) {
  const slot = req.nextUrl.searchParams.get("slot");
  if (!isFeaturedSlotId(slot)) {
    return Response.json({ error: "Unknown slot" }, { status: 400 });
  }
  try {
    return Response.json(await getResolvedFeaturedSlot(slot), { headers: PUBLIC_CACHE_HEADERS });
  } catch (err) {
    console.error("featured error:", err);
    return Response.json({ error: "Failed to load featured items" }, { status: 500 });
  }
}
