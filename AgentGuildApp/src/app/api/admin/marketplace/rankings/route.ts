/**
 * GET /api/admin/marketplace/rankings
 * POST /api/admin/marketplace/rankings
 *
 * Rankings management: view all items with score breakdowns,
 * batch recalculate, override scores, and reset overrides.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import {
  computeRankingScore, computeRankingScoreBreakdown,
  type PublisherProfile,
} from "@/lib/submission-protocol";

interface RankedItem {
  id: string;
  source: "community" | "agents";
  name: string;
  type: string;
  score: number;
  breakdown: {
    installScore: number;
    ratingScore: number;
    freshnessScore: number;
    tierScore: number;
    volumeScore: number;
  };
  installs: number;
  avgRating: number;
  ratingCount: number;
  featured: boolean;
  submittedBy: string;
  overrideScore?: number | null;
}

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const typeFilter = url.searchParams.get("type");
  const sourceFilter = url.searchParams.get("source");
  const searchQuery = url.searchParams.get("q")?.toLowerCase();

  try {
    // Collect raw items from both collections
    const rawItems: {
      id: string; source: "community" | "agents"; name: string; type: string;
      installs: number; avgRating: number; ratingCount: number;
      publishedAt: Date | null; publisherWallet: string;
      featured: boolean; overrideScore?: number | null;
    }[] = [];

    // Community items
    if (!sourceFilter || sourceFilter === "community") {
      const snap = await adminDb().collection("communityMarketItems").where("status", "==", "approved").get();
      for (const d of snap.docs) {
        const data = d.data();
        if (typeFilter && data.type !== typeFilter && data.itemType !== typeFilter) continue;
        if (searchQuery && !(data.name || "").toLowerCase().includes(searchQuery)) continue;
        rawItems.push({
          id: d.id, source: "community",
          name: data.name || "Untitled",
          type: data.type || data.itemType || "unknown",
          installs: data.installCount || 0,
          avgRating: data.avgRating || 0,
          ratingCount: data.ratingCount || 0,
          publishedAt: data.publishedAt?.toDate?.() || null,
          publisherWallet: data.submittedBy || "",
          featured: data.featured || false,
          overrideScore: data.overrideScore ?? null,
        });
      }
    }

    // Agent packages
    if (!sourceFilter || sourceFilter === "agents") {
      if (!typeFilter || typeFilter === "agent") {
        const snap = await adminDb().collection("marketplaceAgents").where("status", "==", "approved").get();
        for (const d of snap.docs) {
          const data = d.data();
          if (searchQuery && !(data.name || "").toLowerCase().includes(searchQuery)) continue;
          rawItems.push({
            id: d.id, source: "agents",
            name: data.name || "Untitled",
            type: "agent",
            installs: data.installCount || 0,
            avgRating: data.avgRating || 0,
            ratingCount: data.ratingCount || 0,
            publishedAt: data.publishedAt?.toDate?.() || null,
            publisherWallet: data.authorWallet || "",
            featured: data.featured || false,
            overrideScore: data.overrideScore ?? null,
          });
        }
      }
    }

    // Batch-fetch publisher tiers
    const uniqueWallets = [...new Set(rawItems.map((r) => r.publisherWallet).filter(Boolean))];
    const tierMap: Record<string, number> = {};
    await Promise.all(
      uniqueWallets.map(async (wallet) => {
        const snap = await adminDb().collection("publisherProfiles").doc(wallet).get();
        tierMap[wallet] = snap.exists ? (snap.data() as PublisherProfile).tier : 0;
      }),
    );

    // Build ranked items with breakdowns
    const items: RankedItem[] = rawItems.map((r) => {
      const publisherTier = tierMap[r.publisherWallet] || 0;
      const breakdown = computeRankingScoreBreakdown({
        installCount: r.installs,
        avgRating: r.avgRating,
        ratingCount: r.ratingCount,
        publishedAt: r.publishedAt,
        publisherTier,
      });

      return {
        id: r.id,
        source: r.source,
        name: r.name,
        type: r.type,
        score: r.overrideScore != null ? r.overrideScore : breakdown.total,
        breakdown,
        installs: r.installs,
        avgRating: r.avgRating,
        ratingCount: r.ratingCount,
        featured: r.featured,
        submittedBy: r.publisherWallet,
        overrideScore: r.overrideScore,
      };
    });

    // Sort by score descending
    items.sort((a, b) => b.score - a.score);

    // Aggregate stats
    const scores = items.map((i) => i.score);
    const stats = {
      highestScore: scores.length ? Math.max(...scores) : 0,
      averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      featuredCount: items.filter((i) => i.featured).length,
      zeroInstallCount: items.filter((i) => i.installs === 0).length,
    };

    // Distribution histogram
    const distribution: Record<string, number> = {
      "0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0,
    };
    for (const s of scores) {
      if (s < 20) distribution["0-20"]++;
      else if (s < 40) distribution["20-40"]++;
      else if (s < 60) distribution["40-60"]++;
      else if (s < 80) distribution["60-80"]++;
      else distribution["80-100"]++;
    }

    return Response.json({ ok: true, stats, distribution, items, count: items.length });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch rankings",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemId, collection: colParam, score } = body as {
    action: "batch_recalculate" | "override_score" | "reset_score";
    itemId?: string;
    collection?: string;
    score?: number;
  };

  if (!action) {
    return Response.json({ error: "action required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "batch_recalculate": {
        let recalculated = 0;

        // Helper to recalculate a single item
        async function recalcItem(colName: string, docId: string, data: Record<string, unknown>) {
          if (data.overrideScore != null) return; // skip overridden items

          const publisherWallet = (data.submittedBy || data.authorWallet || "") as string;
          let publisherTier = 0;
          if (publisherWallet) {
            const pubSnap = await adminDb().collection("publisherProfiles").doc(publisherWallet).get();
            if (pubSnap.exists) publisherTier = (pubSnap.data() as PublisherProfile).tier;
          }

          const newScore = computeRankingScore({
            installCount: (data.installCount as number) || 0,
            avgRating: (data.avgRating as number) || 0,
            ratingCount: (data.ratingCount as number) || 0,
            publishedAt: (data.publishedAt as { toDate(): Date })?.toDate?.() || null,
            publisherTier,
          });

          await adminDb().collection(colName).doc(docId).update({ rankingScore: newScore });
          recalculated++;
        }

        // Community items
        const communitySnap = await adminDb().collection("communityMarketItems").where("status", "==", "approved").get();
        for (const d of communitySnap.docs) {
          await recalcItem("communityMarketItems", d.id, d.data());
        }

        // Agent packages
        const agentSnap = await adminDb().collection("marketplaceAgents").where("status", "==", "approved").get();
        for (const d of agentSnap.docs) {
          await recalcItem("marketplaceAgents", d.id, d.data());
        }

        await recordAuditEntry({
          action: "ranking.batch_recalculate",
          performedBy: "platform-admin",
          targetType: "ranking",
          targetId: "all",
          metadata: { itemsRecalculated: recalculated },
        });

        return Response.json({ ok: true, recalculated });
      }

      case "override_score": {
        if (!itemId) return Response.json({ error: "itemId required" }, { status: 400 });
        if (score == null || score < 0 || score > 100) {
          return Response.json({ error: "score must be 0-100" }, { status: 400 });
        }

        const colName = colParam === "agents" ? "marketplaceAgents" : "communityMarketItems";
        await adminDb().collection(colName).doc(itemId).update({
          overrideScore: score,
          rankingScore: score,
        });

        await recordAuditEntry({
          action: "ranking.override_score",
          performedBy: "platform-admin",
          targetType: "ranking",
          targetId: itemId,
          metadata: { score, collection: colParam },
        });

        return Response.json({ ok: true });
      }

      case "reset_score": {
        if (!itemId) return Response.json({ error: "itemId required" }, { status: 400 });

        const colName = colParam === "agents" ? "marketplaceAgents" : "communityMarketItems";
        const ref = adminDb().collection(colName).doc(itemId);
        const snap = await ref.get();
        if (!snap.exists) return Response.json({ error: "Item not found" }, { status: 404 });

        const data = snap.data()!;
        const publisherWallet = (data.submittedBy || data.authorWallet || "") as string;
        let publisherTier = 0;
        if (publisherWallet) {
          const pubSnap = await adminDb().collection("publisherProfiles").doc(publisherWallet).get();
          if (pubSnap.exists) publisherTier = (pubSnap.data() as PublisherProfile).tier;
        }

        const organicScore = computeRankingScore({
          installCount: data.installCount || 0,
          avgRating: data.avgRating || 0,
          ratingCount: data.ratingCount || 0,
          publishedAt: data.publishedAt?.toDate?.() || null,
          publisherTier,
        });

        await ref.update({
          overrideScore: FieldValue.delete(),
          rankingScore: organicScore,
        });

        await recordAuditEntry({
          action: "ranking.reset_score",
          performedBy: "platform-admin",
          targetType: "ranking",
          targetId: itemId,
          metadata: { organicScore, collection: colParam },
        });

        return Response.json({ ok: true, organicScore });
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
