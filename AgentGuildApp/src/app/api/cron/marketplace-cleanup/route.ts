/**
 * POST /api/cron/marketplace-cleanup
 *
 * Periodic cleanup job for the marketplace:
 * 1. Dead products: 0 installs after 90 days → unlisted
 * 2. Quality check: <2★ avg with 50+ ratings → suspended for re-review
 * 3. Tier recalculation: auto-upgrade publisher tiers
 *
 * Auth: Platform admin or internal service secret
 * Trigger: Netlify cron (daily) or manual
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { updatePublisherStats } from "@/lib/submission-protocol";
import { getMarketplaceSettings } from "@/lib/marketplace-settings";

export async function POST(req: NextRequest) {
    // Auth: platform admin or internal service
    const admin = requirePlatformAdmin(req);
    const service = requireInternalService(req);
    if (!admin.ok && !service.ok) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results = {
        deadProductsUnlisted: 0,
        lowQualitySuspended: 0,
        tiersRecalculated: 0,
        featuredExpired: 0,
    };

    try {
        const settings = await getMarketplaceSettings();

        // 1. Dead product cleanup — approved items with 0 installs older than N days
        const cutoff = Timestamp.fromMillis(Date.now() - settings.deadProductDays * 24 * 60 * 60 * 1000);
        const approvedSnap = await adminDb().collection("communityMarketItems").where("status", "==", "approved").get();

        for (const d of approvedSnap.docs) {
            const data = d.data();
            const lastActive = data.lastActiveAt as Timestamp | undefined;
            const installs = data.installCount || 0;
            const pubStatus = data.publicationStatus;

            if (
                installs === 0 &&
                pubStatus !== "unlisted" &&
                pubStatus !== "suspended" &&
                lastActive &&
                lastActive.toMillis() < cutoff.toMillis()
            ) {
                await adminDb().collection("communityMarketItems").doc(d.id).update({
                    publicationStatus: "unlisted",
                });
                results.deadProductsUnlisted++;
            }
        }

        // 2. Quality check — approved agents with low ratings
        const agentSnap = await adminDb().collection("marketplaceAgents").where("status", "==", "approved").get();

        for (const d of agentSnap.docs) {
            const data = d.data();
            const avgRating = data.avgRating || 0;
            const ratingCount = data.ratingCount || 0;

            if (
                ratingCount >= settings.minRatingsForQualityCheck &&
                avgRating < settings.lowQualityRating &&
                data.publicationStatus !== "suspended"
            ) {
                await adminDb().collection("marketplaceAgents").doc(d.id).update({
                    publicationStatus: "suspended",
                    stage: "product_review",
                });
                results.lowQualitySuspended++;
            }
        }

        // 3. Tier recalculation — unique publishers with recent submissions
        const publishers = new Set<string>();
        approvedSnap.forEach((d) => {
            const wallet = d.data().submittedBy;
            if (wallet) publishers.add(wallet);
        });
        agentSnap.forEach((d) => {
            const wallet = d.data().authorWallet;
            if (wallet) publishers.add(wallet);
        });

        for (const wallet of publishers) {
            try {
                await updatePublisherStats(wallet);
                results.tiersRecalculated++;
            } catch {
                // Skip individual failures
            }
        }

        // 4. Featured rotation — un-feature items older than featuredRotationDays
        const featuredCutoff = Timestamp.fromMillis(
            Date.now() - settings.featuredRotationDays * 24 * 60 * 60 * 1000,
        );
        for (const [colName, snap] of [
            ["communityMarketItems", approvedSnap] as const,
            ["marketplaceAgents", agentSnap] as const,
        ]) {
            for (const d of snap.docs) {
                const data = d.data();
                if (!data.featured) continue;
                const featuredAt = data.featuredAt as Timestamp | undefined;
                if (featuredAt && featuredAt.toMillis() < featuredCutoff.toMillis()) {
                    await adminDb().collection(colName).doc(d.id).update({
                        featured: false,
                        featuredAt: null,
                    });
                    results.featuredExpired++;
                }
            }
        }

        return Response.json({
            success: true,
            ...results,
            publishersProcessed: publishers.size,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Cleanup failed" },
            { status: 500 },
        );
    }
}
