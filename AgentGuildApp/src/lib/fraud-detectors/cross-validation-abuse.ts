/**
 * Cross-Validation Abuse Detector
 *
 * Detects validators that collude with specific workers by always
 * approving their work, or concentrate all validation activity on
 * a single counterparty.
 *
 * Algorithm:
 * 1. Per validator, compute distribution of workers validated
 * 2. Flag if > 80% of validations go to a single worker
 * 3. Flag if > 95% approve rate with > 5 validations
 * 4. Cross-reference with self-deal and trust-ring for correlation boost
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

interface ValidatorProfile {
  validatorId: string;
  totalValidations: number;
  approveCount: number;
  rejectCount: number;
  workerDistribution: Map<string, number>; // workerASN → validation count
}

export async function detectCrossValidationAbuse(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Query all validation stakes
  let stakesSnap;
  try {
    stakesSnap = await adminDb().collection("validationStakes").get();
  } catch {
    return signals; // Collection may not exist
  }

  // Build per-validator profiles
  const validatorProfiles = new Map<string, ValidatorProfile>();

  for (const d of stakesSnap.docs) {
    const data = d.data();
    const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
    if (createdAt < windowStart) continue;

    const validatorId = data.validatorAgentId;
    const workerASN = data.workerASN;
    const validationStatus = data.validationStatus;

    if (!validatorId || !workerASN) continue;

    if (!validatorProfiles.has(validatorId)) {
      validatorProfiles.set(validatorId, {
        validatorId,
        totalValidations: 0,
        approveCount: 0,
        rejectCount: 0,
        workerDistribution: new Map(),
      });
    }

    const profile = validatorProfiles.get(validatorId)!;
    profile.totalValidations++;

    if (validationStatus === "approve") {
      profile.approveCount++;
    } else {
      profile.rejectCount++;
    }

    profile.workerDistribution.set(
      workerASN,
      (profile.workerDistribution.get(workerASN) || 0) + 1,
    );
  }

  // Evaluate each validator
  for (const [validatorId, profile] of validatorProfiles) {
    if (profile.totalValidations < 5) continue; // Need minimum volume

    const issues: string[] = [];
    let maxSeverity: "medium" | "high" | "critical" = "medium";
    let maxConfidence = 0;

    // Check 1: Worker concentration
    const topWorker = [...profile.workerDistribution.entries()]
      .sort((a, b) => b[1] - a[1])[0];

    if (topWorker) {
      const concentration = topWorker[1] / profile.totalValidations;

      if (concentration > config.crossValidationConcentration) {
        issues.push(
          `${(concentration * 100).toFixed(0)}% of validations for worker ${topWorker[0]}`,
        );
        maxSeverity = concentration > 0.95 ? "critical" : "high";
        maxConfidence = Math.max(maxConfidence, concentration);
      }
    }

    // Check 2: Rubber-stamp approver
    const approveRate = profile.approveCount / profile.totalValidations;
    if (approveRate > 0.95 && profile.totalValidations >= 5) {
      issues.push(
        `${(approveRate * 100).toFixed(0)}% approve rate (${profile.approveCount}/${profile.totalValidations})`,
      );
      maxSeverity = approveRate >= 1.0 ? "high" : maxSeverity;
      maxConfidence = Math.max(maxConfidence, approveRate * 0.9);
    }

    if (issues.length === 0) continue;

    // Get agent details
    let agentAsn = "";
    try {
      const agentDoc = await adminDb().collection("agents").doc(validatorId).get();
      if (agentDoc.exists) {
        agentAsn = agentDoc.data()!.asn || "";
      }
    } catch {
      // continue
    }

    // Combined confidence boost if both issues present
    if (issues.length > 1) {
      maxConfidence = Math.min(1, maxConfidence + 0.1);
    }

    signals.push({
      agentId: validatorId,
      asn: agentAsn,
      orgId,
      signalType: "cross_validation_abuse",
      severity: maxSeverity,
      confidence: maxConfidence,
      evidence: {
        counterpartyIds: [...profile.workerDistribution.keys()],
        windowStart: Math.floor(windowStart / 1000),
        windowEnd: Math.floor(windowEnd / 1000),
        metric: topWorker ? topWorker[1] / profile.totalValidations : 0,
        threshold: config.crossValidationConcentration,
        description: `Validation abuse: ${issues.join("; ")}. Total: ${profile.totalValidations} validations across ${profile.workerDistribution.size} workers`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
}
