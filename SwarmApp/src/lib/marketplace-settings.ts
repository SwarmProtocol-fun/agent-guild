/**
 * Marketplace Settings Reader
 *
 * Reads `platformConfig/marketplace` from Firestore and merges with
 * defaults. Caches for 60 seconds to avoid repeated reads.
 */

import { adminDb } from "./firebase-admin";

export interface MarketplaceSettings {
  autoApproveForTier: number;
  maxQueueAgeDays: number;
  deadProductDays: number;
  lowQualityRating: number;
  minRatingsForQualityCheck: number;
  autoSuspendReportCount: number;
  maxFeaturedItems: number;
  featuredRotationDays: number;
  requireDemoUrl: boolean;
  requireScreenshots: boolean;
  allowedCategories: string[];
  blockedKeywords: string[];
  platformFeePercent: number;
  minPayoutAmount: number;
  payoutSchedule: "weekly" | "biweekly" | "monthly";
}

const DEFAULTS: MarketplaceSettings = {
  autoApproveForTier: 3,
  maxQueueAgeDays: 7,
  deadProductDays: 90,
  lowQualityRating: 2.0,
  minRatingsForQualityCheck: 50,
  autoSuspendReportCount: 3,
  maxFeaturedItems: 10,
  featuredRotationDays: 30,
  requireDemoUrl: false,
  requireScreenshots: false,
  allowedCategories: [],
  blockedKeywords: [],
  platformFeePercent: 15,
  minPayoutAmount: 25,
  payoutSchedule: "monthly",
};

let cached: { settings: MarketplaceSettings; expiresAt: number } | null = null;

/** Read marketplace settings with 60-second cache. */
export async function getMarketplaceSettings(): Promise<MarketplaceSettings> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.settings;
  }

  try {
    const snap = await adminDb().collection("platformConfig").doc("marketplace").get();
    const data = snap.exists ? snap.data() : {};
    const settings = { ...DEFAULTS, ...data } as MarketplaceSettings;
    cached = { settings, expiresAt: Date.now() + 60_000 };
    return settings;
  } catch {
    // If Firestore read fails, return defaults
    return DEFAULTS;
  }
}
