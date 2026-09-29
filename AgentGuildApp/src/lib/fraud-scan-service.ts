/**
 * Fraud Scan Background Service
 *
 * Runs fraud detection scans on a configurable interval (default: 6 hours).
 * Mirrors the pattern from hedera-slashing.ts.
 */

import { runFraudScan, type FraudDetectionConfig } from "./fraud-detection";

// Import detectors — these will be created in Phase 2 & 3
import { detectSelfDealLoops } from "./fraud-detectors/self-deal-detector";
import { detectWashSettlement } from "./fraud-detectors/wash-settlement-detector";
import { detectSpamFarming } from "./fraud-detectors/spam-farming-detector";
import { detectGraphConcentration } from "./fraud-detectors/graph-concentration";
import { detectIdentityResets } from "./fraud-detectors/identity-reset-detector";
import { detectTrustRings } from "./fraud-detectors/trust-ring-detector";
import { detectLowValueGrinding } from "./fraud-detectors/low-value-grinder";
import { detectVelocityAnomalies } from "./fraud-detectors/velocity-anomaly";
import { detectCrossValidationAbuse } from "./fraud-detectors/cross-validation-abuse";

// ═══════════════════════════════════════════════════════════════
// Service State
// ═══════════════════════════════════════════════════════════════

let scanInterval: NodeJS.Timeout | null = null;

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ═══════════════════════════════════════════════════════════════
// Detector Registry
// ═══════════════════════════════════════════════════════════════

/** Org-scoped detectors — run once per organization */
const ORG_DETECTORS = [
  detectSelfDealLoops,
  detectWashSettlement,
  detectSpamFarming,
  detectGraphConcentration,
  detectTrustRings,
  detectLowValueGrinding,
  detectVelocityAnomalies,
  detectCrossValidationAbuse,
];

/** Platform-wide detectors — run once across all agents */
const PLATFORM_DETECTORS = [
  detectIdentityResets,
];

// ═══════════════════════════════════════════════════════════════
// Service Control
// ═══════════════════════════════════════════════════════════════

/**
 * Start the fraud scan background service.
 * Checks for fraud patterns every `intervalMs` milliseconds.
 */
export function startFraudScanService(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  config?: Partial<FraudDetectionConfig>,
): void {
  if (scanInterval) {
    console.warn("Fraud scan service already running");
    return;
  }

  console.log(`Starting fraud scan service (interval: ${(intervalMs / 3600000).toFixed(1)} hours)`);

  // Run immediately on start
  runFraudScan(ORG_DETECTORS, PLATFORM_DETECTORS, config).catch((error) => {
    console.error("Initial fraud scan failed:", error);
  });

  // Then run on interval
  scanInterval = setInterval(async () => {
    try {
      const result = await runFraudScan(ORG_DETECTORS, PLATFORM_DETECTORS, config);
      if (result.signalsGenerated > 0) {
        console.log(
          `Fraud scan: ${result.signalsGenerated} signals, ${result.autoPenaltiesApplied} penalties, ${result.casesEscalated} cases`,
        );
      }
    } catch (error) {
      console.error("Fraud scan service error:", error);
    }
  }, intervalMs);
}

/**
 * Stop the fraud scan background service.
 */
export function stopFraudScanService(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log("Stopped fraud scan service");
  }
}

/**
 * Check if the fraud scan service is running.
 */
export function isFraudScanServiceRunning(): boolean {
  return scanInterval !== null;
}

/**
 * Trigger a single on-demand fraud scan (does not affect the interval).
 */
export async function triggerFraudScan(config?: Partial<FraudDetectionConfig>) {
  return runFraudScan(ORG_DETECTORS, PLATFORM_DETECTORS, config);
}
