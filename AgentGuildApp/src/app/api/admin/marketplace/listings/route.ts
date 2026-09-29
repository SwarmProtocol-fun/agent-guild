/**
 * GET /api/admin/marketplace/listings
 * POST /api/admin/marketplace/listings
 *
 * Listing management: browse all items with status/type filters,
 * and perform admin actions (suspend, feature, recalculate rank).
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { computeRankingScore, type PublisherProfile } from "@/lib/submission-protocol";
import { getMarketplaceSettings } from "@/lib/marketplace-settings";

/** GET — List marketplace items */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const statusFilter = url.searchParams.get("status") || "all";
  const typeFilter = url.searchParams.get("type");
  const sortBy = url.searchParams.get("sort") || "newest";
  const searchQuery = url.searchParams.get("q")?.toLowerCase();

  try {
    const results: Record<string, unknown>[] = [];

    // Community items
    let communityQ: Query = adminDb().collection("communityMarketItems");
    if (statusFilter !== "all") {
      communityQ = communityQ.where("status", "==", statusFilter);
    }
    const communitySnap = await communityQ.get();
    for (const d of communitySnap.docs) {
      const data = d.data();
      if (typeFilter && data.type !== typeFilter && data.itemType !== typeFilter) continue;
      if (searchQuery && !(data.name || "").toLowerCase().includes(searchQuery)) continue;

      results.push({
        id: d.id,
        source: "community",
        name: data.name || "Untitled",
        type: data.type || data.itemType || "unknown",
        submittedBy: data.submittedBy || "unknown",
        status: data.status || "unknown",
        installs: data.installCount || 0,
        avgRating: data.avgRating || 0,
        ratingCount: data.ratingCount || 0,
        rankingScore: data.rankingScore || 0,
        featured: data.featured || false,
        submittedAt: data.submittedAt,
        publishedAt: data.publishedAt,
      });
    }

    // Agent packages
    let agentQ: Query = adminDb().collection("marketplaceAgents");
    if (statusFilter !== "all") {
      const mappedStatus = statusFilter === "pending" ? "review" : statusFilter;
      agentQ = agentQ.where("status", "==", mappedStatus);
    }
    const agentSnap = await agentQ.get();
    for (const d of agentSnap.docs) {
      const data = d.data();
      if (typeFilter && typeFilter !== "agent") continue;
      if (searchQuery && !(data.name || "").toLowerCase().includes(searchQuery)) continue;

      results.push({
        id: d.id,
        source: "agents",
        name: data.name || "Untitled",
        type: "agent",
        submittedBy: data.authorWallet || "unknown",
        status: data.status || "unknown",
        installs: data.installCount || 0,
        avgRating: data.avgRating || 0,
        ratingCount: data.ratingCount || 0,
        rankingScore: data.rankingScore || 0,
        featured: data.featured || false,
        submittedAt: data.submittedAt,
        publishedAt: data.publishedAt,
      });
    }

    // Sort
    results.sort((a, b) => {
      switch (sortBy) {
        case "ranking":
          return (b.rankingScore as number) - (a.rankingScore as number);
        case "installs":
          return (b.installs as number) - (a.installs as number);
        case "newest":
        default: {
          const aTime = (a.submittedAt as { seconds: number })?.seconds || 0;
          const bTime = (b.submittedAt as { seconds: number })?.seconds || 0;
          return bTime - aTime;
        }
      }
    });

    return Response.json({ ok: true, count: results.length, items: results });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch listings",
    }, { status: 500 });
  }
}

/** POST — Listing admin actions */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemId, collection: colParam, reason } = body as {
    action: "suspend" | "unsuspend" | "feature" | "unfeature" | "recalculate_rank";
    itemId: string;
    collection?: string;
    reason?: string;
  };

  if (!action || !itemId) {
    return Response.json({ error: "action and itemId required" }, { status: 400 });
  }

  const colName = colParam === "agents" ? "marketplaceAgents" : "communityMarketItems";

  try {
    const ref = adminDb().collection(colName).doc(itemId);
    const snap = await ref.get();
    if (!snap.exists) {
      return Response.json({ error: "Item not found" }, { status: 404 });
    }

    const data = snap.data()!;

    switch (action) {
      case "suspend":
        await ref.update({ status: "suspended", suspendedAt: FieldValue.serverTimestamp(), suspendReason: reason || "" });
        break;
      case "unsuspend":
        await ref.update({ status: "approved", suspendedAt: null, suspendReason: null });
        break;
      case "feature": {
        // Enforce max featured items from settings
        const settings = await getMarketplaceSettings();
        let featuredCount = 0;
        const communityFeatured = await adminDb().collection("communityMarketItems").where("featured", "==", true).get();
        featuredCount += communityFeatured.size;
        const agentFeatured = await adminDb().collection("marketplaceAgents").where("featured", "==", true).get();
        featuredCount += agentFeatured.size;

        if (featuredCount >= settings.maxFeaturedItems) {
          return Response.json(
            { error: `Maximum featured items reached (${settings.maxFeaturedItems})` },
            { status: 400 },
          );
        }

        await ref.update({ featured: true, featuredAt: FieldValue.serverTimestamp() });
        break;
      }
      case "unfeature":
        await ref.update({ featured: false, featuredAt: null });
        break;
      case "recalculate_rank": {
        // Get publisher tier for ranking
        const publisherWallet = data.submittedBy || data.authorWallet;
        let publisherTier = 0;
        if (publisherWallet) {
          const pubSnap = await adminDb().collection("publisherProfiles").doc(publisherWallet).get();
          if (pubSnap.exists) publisherTier = (pubSnap.data() as PublisherProfile).tier;
        }

        const score = computeRankingScore({
          installCount: data.installCount || 0,
          avgRating: data.avgRating || 0,
          ratingCount: data.ratingCount || 0,
          publishedAt: data.publishedAt?.toDate?.() || null,
          publisherTier,
        });
        await ref.update({ rankingScore: score });
        break;
      }
      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    await recordAuditEntry({
      action: `listing.${action}`,
      performedBy: "platform-admin",
      targetType: "listing",
      targetId: itemId,
      metadata: { collection: colParam || "community", reason },
    });

    return Response.json({ ok: true, action, itemId });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
