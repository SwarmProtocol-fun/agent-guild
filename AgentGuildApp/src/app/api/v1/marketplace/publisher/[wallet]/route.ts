/**
 * GET /api/v1/marketplace/publisher/[wallet]
 *
 * Public endpoint — returns a publisher's profile, trust tier, and stats.
 * No auth required (public marketplace data).
 */
import { NextRequest } from "next/server";
import {
    getOrCreatePublisher,
    TIER_NAMES,
    TIER_QUOTAS,
} from "@/lib/submission-protocol";

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ wallet: string }> },
) {
    const { wallet } = await params;
    if (!wallet || wallet.length < 10) {
        return Response.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    try {
        const profile = await getOrCreatePublisher(wallet.toLowerCase());
        const quota = TIER_QUOTAS[profile.tier] || TIER_QUOTAS[0];

        return Response.json({
            wallet: profile.walletAddress,
            displayName: profile.displayName,
            tier: profile.tier,
            tierName: TIER_NAMES[profile.tier] || "Unknown",
            stats: {
                totalSubmissions: profile.totalSubmissions,
                approvedCount: profile.approvedCount,
                rejectedCount: profile.rejectedCount,
                avgRating: profile.avgRating,
                totalInstalls: profile.totalInstalls,
            },
            quota: {
                maxPerWeek: quota.maxPerWeek,
                cooldownMs: quota.cooldownMs,
            },
            banned: profile.banned,
            memberSince: profile.createdAt,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to fetch publisher" },
            { status: 500 },
        );
    }
}
