/**
 * GET /api/v1/gigs
 *
 * Public, read-only browse endpoint for the Gigs marketplace — lets a
 * visitor see what's for sale before connecting a wallet (the dashboard
 * /gigs page itself requires a session, same as every other dashboard
 * route). Uses the Admin SDK so it works with no `request.auth`, same
 * pattern as /api/v1/marketplace/items.
 *
 * Query params:
 * - category: string
 * - q: search query (matches title/description/tags)
 * - limit: number (default: 24, max: 100)
 * - offset: number (default: 0)
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isHostedGigImage } from "@/lib/gig-packages";

interface PublicGig {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  agentName: string;
  sellerType: "agent" | "person";
  /** Starting price — the cheapest package's when the gig has packages. */
  price: string;
  hasPackages: boolean;
  coverImageUrl: string | null;
  deliveryDays: number;
  avgRating: number;
  ratingCount: number;
}

// Same rationale as /api/v1/marketplace/items: this is a public,
// unauthenticated endpoint, so cap how much of the collection a single
// request can scan rather than trusting client-supplied limit/offset alone.
const MAX_DOCS = 500;

// Public and identical for every visitor — let the CDN serve it for a minute
// so a page view doesn't cost up to MAX_DOCS Firestore reads. Browsers
// revalidate; only the edge holds it.
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const categoryFilter = url.searchParams.get("category");
  const searchQuery = url.searchParams.get("q")?.toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "24", 10) || 24, 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  try {
    const snap = await adminDb()
      .collection("gigs")
      .where("status", "==", "active")
      .limit(MAX_DOCS)
      .get();

    let gigs: PublicGig[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title || "Untitled",
        description: data.description || "",
        category: data.category || "General",
        tags: data.tags || [],
        agentName: data.agentName || "Unknown seller",
        sellerType: data.sellerType === "person" ? "person" : "agent",
        price: data.price || "",
        hasPackages: Array.isArray(data.packages) && data.packages.length > 0,
        coverImageUrl: isHostedGigImage(data.coverImageUrl) ? data.coverImageUrl : null,
        deliveryDays: data.deliveryDays || 0,
        avgRating: data.avgRating || 0,
        ratingCount: data.ratingCount || 0,
      };
    });

    if (categoryFilter) {
      gigs = gigs.filter((g) => g.category === categoryFilter);
    }
    if (searchQuery) {
      gigs = gigs.filter(
        (g) =>
          g.title.toLowerCase().includes(searchQuery) ||
          g.description.toLowerCase().includes(searchQuery) ||
          g.tags.some((t) => t.toLowerCase().includes(searchQuery)),
      );
    }

    const total = gigs.length;
    const paged = gigs.slice(offset, offset + limit);

    return Response.json({
      gigs: paged,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    }, { headers: PUBLIC_CACHE_HEADERS });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch gigs" },
      { status: 500 },
    );
  }
}
