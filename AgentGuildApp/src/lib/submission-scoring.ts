/**
 * Submission Scoring — pure ranking-score math, no Firestore/server deps.
 *
 * Split out of submission-protocol.ts so client code (useMarketplace.ts)
 * can import it without pulling in that file's server-only dependencies
 * (Firebase Admin SDK via rate-limit-firestore.ts) into the browser bundle.
 * submission-protocol.ts re-exports these for existing server callers.
 */

/** Compute a 0-100ish ranking score for a marketplace item. */
export function computeRankingScore(item: {
    installCount: number;
    avgRating: number;
    ratingCount: number;
    publishedAt: Date | null;
    publisherTier: number;
}): number {
    // Installs (0-30 points, log scale, cap at 1000)
    const installScore = Math.min(Math.log10(Math.max(item.installCount, 1)) / 3, 1) * 30;

    // Rating (0-25 points)
    const ratingScore = (item.avgRating / 5) * 25;

    // Freshness (0-20 points, decays over 180 days)
    const ageMs = item.publishedAt ? Date.now() - item.publishedAt.getTime() : 180 * 24 * 60 * 60 * 1000;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const freshnessScore = Math.max(0, 1 - ageDays / 180) * 20;

    // Tier boost (0-15 points)
    const tierScore = (item.publisherTier / 3) * 15;

    // Rating volume (0-10 points, log scale, cap at 100)
    const volumeScore = Math.min(Math.log10(Math.max(item.ratingCount, 1)) / 2, 1) * 10;

    return Math.round(installScore + ratingScore + freshnessScore + tierScore + volumeScore);
}

/** Compute ranking score with individual factor breakdown. */
export function computeRankingScoreBreakdown(item: {
    installCount: number;
    avgRating: number;
    ratingCount: number;
    publishedAt: Date | null;
    publisherTier: number;
}): {
    total: number;
    installScore: number;
    ratingScore: number;
    freshnessScore: number;
    tierScore: number;
    volumeScore: number;
} {
    const installScore = Math.min(Math.log10(Math.max(item.installCount, 1)) / 3, 1) * 30;
    const ratingScore = (item.avgRating / 5) * 25;
    const ageMs = item.publishedAt ? Date.now() - item.publishedAt.getTime() : 180 * 24 * 60 * 60 * 1000;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const freshnessScore = Math.max(0, 1 - ageDays / 180) * 20;
    const tierScore = (item.publisherTier / 3) * 15;
    const volumeScore = Math.min(Math.log10(Math.max(item.ratingCount, 1)) / 2, 1) * 10;

    return {
        total: Math.round(installScore + ratingScore + freshnessScore + tierScore + volumeScore),
        installScore: Math.round(installScore * 10) / 10,
        ratingScore: Math.round(ratingScore * 10) / 10,
        freshnessScore: Math.round(freshnessScore * 10) / 10,
        tierScore: Math.round(tierScore * 10) / 10,
        volumeScore: Math.round(volumeScore * 10) / 10,
    };
}
