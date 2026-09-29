/**
 * Fraud Risk Scoring — Composite Risk Score Computation
 *
 * Takes raw RiskSignals and computes a weighted composite risk score (0-100)
 * per agent. Score determines the agent's risk tier which drives automatic
 * actions and review queue escalation.
 */

import type { RiskSignal, RiskSignalType, SignalSeverity, RiskTier } from "./fraud-detection";

// ═══════════════════════════════════════════════════════════════
// Signal Weights
// ═══════════════════════════════════════════════════════════════

const SIGNAL_WEIGHTS: Record<RiskSignalType, number> = {
  identity_reset: 40,
  wash_settlement: 35,
  trust_ring: 30,
  self_deal_loop: 25,
  spam_task_farming: 20,
  cross_validation_abuse: 20,
  graph_concentration: 15,
  velocity_anomaly: 12,
  repetitive_low_value: 10,
};

const SEVERITY_MULTIPLIER: Record<SignalSeverity, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
};

// ═══════════════════════════════════════════════════════════════
// Risk Tier Thresholds
// ═══════════════════════════════════════════════════════════════

export function computeRiskTier(riskScore: number): RiskTier {
  if (riskScore >= 80) return "banned";
  if (riskScore >= 60) return "flagged";
  if (riskScore >= 40) return "suspicious";
  if (riskScore >= 20) return "watch";
  return "clean";
}

// ═══════════════════════════════════════════════════════════════
// Risk Profile
// ═══════════════════════════════════════════════════════════════

export interface RiskProfile {
  agentId: string;
  asn: string;
  orgId: string;
  riskScore: number;
  riskTier: RiskTier;
  activeSignalCount: number;
  signalBreakdown: Partial<Record<RiskSignalType, number>>;
  highestSeverity: "none" | SignalSeverity;
  // Behavioral metrics (denormalized from scan)
  uniqueCounterparties: number;
  taskCompletionVelocity: number;
  avgTaskComplexity: number;
  graphClusterSize: number;
  walletClusterSize: number;
  // Penalty tracking
  autoPenaltiesApplied: number;
  manualPenaltiesApplied: number;
  totalCreditPenalized: number;
  totalTrustPenalized: number;
  // Metadata
  lastScanAt?: unknown;
  firstFlaggedAt?: unknown;
  updatedAt?: unknown;
}

// ═══════════════════════════════════════════════════════════════
// Score Computation
// ═══════════════════════════════════════════════════════════════

/**
 * Compute composite risk score from active signals.
 * Formula: riskScore = min(100, sum(weight * severity_multiplier * confidence))
 */
export function computeRiskScore(signals: RiskSignal[]): number {
  let rawScore = 0;

  for (const signal of signals) {
    if (signal.status !== "active") continue;

    const weight = SIGNAL_WEIGHTS[signal.signalType] || 10;
    const severityMul = SEVERITY_MULTIPLIER[signal.severity] || 0.5;
    const confidence = Math.max(0, Math.min(1, signal.confidence));

    rawScore += weight * severityMul * confidence;
  }

  return Math.min(100, Math.round(rawScore * 100) / 100);
}

/**
 * Compute a full risk profile from active signals.
 */
export function computeRiskProfile(agentId: string, signals: RiskSignal[]): RiskProfile {
  const activeSignals = signals.filter((s) => s.status === "active");
  const riskScore = computeRiskScore(activeSignals);
  const riskTier = computeRiskTier(riskScore);

  // Signal breakdown
  const signalBreakdown: Partial<Record<RiskSignalType, number>> = {};
  for (const signal of activeSignals) {
    signalBreakdown[signal.signalType] = (signalBreakdown[signal.signalType] || 0) + 1;
  }

  // Highest severity
  const severityOrder: SignalSeverity[] = ["low", "medium", "high", "critical"];
  let highestSeverity: "none" | SignalSeverity = "none";
  for (const signal of activeSignals) {
    if (highestSeverity === "none" || severityOrder.indexOf(signal.severity) > severityOrder.indexOf(highestSeverity as SignalSeverity)) {
      highestSeverity = signal.severity;
    }
  }

  // Extract behavioral metrics from evidence
  const counterpartySet = new Set<string>();
  let totalVelocity = 0;
  let velocityCount = 0;
  let totalComplexity = 0;
  let complexityCount = 0;
  let maxClusterSize = 0;
  let maxWalletCluster = 0;

  for (const signal of activeSignals) {
    if (signal.evidence.counterpartyIds) {
      signal.evidence.counterpartyIds.forEach((id) => counterpartySet.add(id));
    }
    if (signal.signalType === "spam_task_farming" && signal.evidence.metric != null) {
      totalVelocity += signal.evidence.metric;
      velocityCount++;
    }
    if (signal.signalType === "trust_ring" && signal.evidence.counterpartyIds) {
      maxClusterSize = Math.max(maxClusterSize, signal.evidence.counterpartyIds.length);
    }
    if (signal.signalType === "identity_reset" && signal.evidence.walletAddresses) {
      maxWalletCluster = Math.max(maxWalletCluster, signal.evidence.walletAddresses.length);
    }
  }

  // Get ASN and orgId from the first signal
  const firstSignal = activeSignals[0];

  return {
    agentId,
    asn: firstSignal?.asn || "",
    orgId: firstSignal?.orgId || "",
    riskScore,
    riskTier,
    activeSignalCount: activeSignals.length,
    signalBreakdown,
    highestSeverity,
    uniqueCounterparties: counterpartySet.size,
    taskCompletionVelocity: velocityCount > 0 ? totalVelocity / velocityCount : 0,
    avgTaskComplexity: complexityCount > 0 ? totalComplexity / complexityCount : 0,
    graphClusterSize: maxClusterSize,
    walletClusterSize: maxWalletCluster,
    autoPenaltiesApplied: 0,
    manualPenaltiesApplied: 0,
    totalCreditPenalized: 0,
    totalTrustPenalized: 0,
  };
}
