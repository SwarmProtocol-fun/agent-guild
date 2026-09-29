/**
 * GET /api/admin/marketplace/settings
 * POST /api/admin/marketplace/settings
 *
 * Read and update marketplace-wide configuration stored in
 * the Firestore singleton doc `platformConfig/marketplace`.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

interface MarketplaceSettings {
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

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const ref = adminDb().collection("platformConfig").doc("marketplace");
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const settings = { ...DEFAULTS, ...data };

    return Response.json({ ok: true, settings });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch settings",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { settings } = body as { settings: Partial<MarketplaceSettings> };

  if (!settings || typeof settings !== "object") {
    return Response.json({ error: "settings object required" }, { status: 400 });
  }

  // Validate fields
  if (settings.autoApproveForTier != null && (settings.autoApproveForTier < 0 || settings.autoApproveForTier > 3)) {
    return Response.json({ error: "autoApproveForTier must be 0-3" }, { status: 400 });
  }
  if (settings.platformFeePercent != null && (settings.platformFeePercent < 0 || settings.platformFeePercent > 100)) {
    return Response.json({ error: "platformFeePercent must be 0-100" }, { status: 400 });
  }
  if (settings.payoutSchedule && !["weekly", "biweekly", "monthly"].includes(settings.payoutSchedule)) {
    return Response.json({ error: "Invalid payoutSchedule" }, { status: 400 });
  }

  try {
    const ref = adminDb().collection("platformConfig").doc("marketplace");
    await ref.set({
      ...settings,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "platform-admin",
    }, { merge: true });

    await recordAuditEntry({
      action: "settings.updated",
      performedBy: "platform-admin",
      targetType: "settings",
      targetId: "marketplace-settings",
      metadata: { updatedFields: Object.keys(settings) },
    });

    // Re-read merged result
    const snap = await ref.get();
    const merged = { ...DEFAULTS, ...(snap.exists ? snap.data() : {}) };

    return Response.json({ ok: true, settings: merged });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to save settings",
    }, { status: 500 });
  }
}
