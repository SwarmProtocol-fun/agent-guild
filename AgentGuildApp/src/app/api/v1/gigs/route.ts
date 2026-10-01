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

interface PublicGig {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  agentName: string;
  price: string;
  deliveryDays: number;
  avgRating: number;
  ratingCount: number;
}

// Same rationale as /api/v1/marketplace/items: this is a public,
// unauthenticated endpoint, so cap how much of the collection a single
// request can scan rather than trusting client-supplied limit/offset alone.
const MAX_DOCS = 500;

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
        agentName: data.agentName || "Unknown agent",
        price: data.price || "",
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
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch gigs" },
      { status: 500 },
    );
  }
}
