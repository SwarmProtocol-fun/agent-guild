/**
 * POST /api/admin/risk/scan
 *
 * Trigger an on-demand fraud detection scan.
 * Returns the scan run ID for polling status.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { getWalletAddress } from "@/lib/auth-guard";
import { triggerFraudScan } from "@/lib/fraud-scan-service";
import type { FraudDetectionConfig } from "@/lib/fraud-detection";

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const adminWallet = getWalletAddress(req) || "platform-admin";

  try {
    let config: Partial<FraudDetectionConfig> = {};
    try {
      const body = await req.json();
      if (body.config) config = body.config;
    } catch {
      // No body is fine — use defaults
    }

    // Run scan asynchronously — return immediately with run ID
    const scanPromise = triggerFraudScan(config);

    // We need the run ID, so await just the creation
    const result = await scanPromise;

    await recordAuditEntry({
      action: "fraud.scan.triggered",
      performedBy: adminWallet,
      targetType: "risk_profile" as any,
      targetId: result.id || "manual-scan",
      metadata: { config },
    }).catch(() => {});

    return Response.json({
      ok: true,
      scanRunId: result.id,
      status: result.status,
      agentsScanned: result.agentsScanned,
      signalsGenerated: result.signalsGenerated,
      autoPenaltiesApplied: result.autoPenaltiesApplied,
      casesEscalated: result.casesEscalated,
      durationMs: result.durationMs,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to trigger scan",
    }, { status: 500 });
  }
}
