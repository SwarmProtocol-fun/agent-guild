/**
 * GET /api/admin/risk/config
 * PUT /api/admin/risk/config
 *
 * Get and update fraud detection configuration thresholds.
 * Stored in Firestore `platformSettings/fraudDetection`.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin, getWalletAddress } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { DEFAULT_CONFIG, type FraudDetectionConfig } from "@/lib/fraud-detection";

const CONFIG_DOC = "platformSettings";
const CONFIG_ID = "fraudDetection";

/** GET — Fetch current fraud detection config */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const ref = adminDb().collection(CONFIG_DOC).doc(CONFIG_ID);
    const snap = await ref.get();

    const config: FraudDetectionConfig = snap.exists
      ? { ...DEFAULT_CONFIG, ...snap.data()!.config }
      : DEFAULT_CONFIG;

    return Response.json({
      ok: true,
      config,
      defaults: DEFAULT_CONFIG,
      lastUpdated: snap.exists ? snap.data()!.updatedAt : null,
      updatedBy: snap.exists ? snap.data()!.updatedBy : null,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch config",
    }, { status: 500 });
  }
}

/** PUT — Update fraud detection config */
export async function PUT(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const adminWallet = getWalletAddress(req) || "platform-admin";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates = body.config as Partial<FraudDetectionConfig>;
  if (!updates || typeof updates !== "object") {
    return Response.json({ error: "config object required" }, { status: 400 });
  }

  // Validate numeric fields
  const numericFields: (keyof FraudDetectionConfig)[] = [
    "windowDays", "selfDealThreshold", "selfDealMinCompletions",
    "trustRingMaxSize", "trustRingInsularity", "spamVelocityThreshold",
    "spamSimpleRatio", "washSettlementMinutes", "graphConcentrationHHI",
    "graphConcentrationMinInteractions", "velocityZScoreThreshold",
    "lowValueSimilarityThreshold", "crossValidationConcentration",
    "autoPenaltyMaxCredit",
  ];

  for (const field of numericFields) {
    if (field in updates && typeof updates[field] !== "number") {
      return Response.json({ error: `${field} must be a number` }, { status: 400 });
    }
  }

  try {
    const ref = adminDb().collection(CONFIG_DOC).doc(CONFIG_ID);
    const existing = await ref.get();
    const currentConfig = existing.exists
      ? { ...DEFAULT_CONFIG, ...existing.data()!.config }
      : DEFAULT_CONFIG;

    const newConfig = { ...currentConfig, ...updates };

    await ref.set({
      config: newConfig,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: adminWallet,
    }, { merge: true });

    await recordAuditEntry({
      action: "fraud.config.updated",
      performedBy: adminWallet,
      targetType: "settings",
      targetId: CONFIG_ID,
      metadata: { updates },
    }).catch(() => {});

    return Response.json({
      ok: true,
      config: newConfig,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to update config",
    }, { status: 500 });
  }
}
