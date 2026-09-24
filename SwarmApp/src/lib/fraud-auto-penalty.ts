/**
 * Fraud Auto-Penalty Engine
 *
 * Rule-based system that automatically applies penalties for clear-cut
 * fraud signals. Small penalties (≤50 credit) go directly through
 * emitPenalty(). Large penalties (>50) route through the governance
 * multi-party approval system.
 */

import { adminDb } from "@/lib/firebase-admin";
import { emitPenalty, createPenaltyProposal } from "./mod-stubs";
import { updateSignalStatus, type RiskSignal, type RiskSignalType, type FraudDetectionConfig } from "./fraud-detection";
import { computeRiskTier } from "./fraud-risk-scoring";
import { logActivity } from "./activity";
import { recordAuditEntry } from "./audit-log";
import type { Agent } from "./firestore";

// ═══════════════════════════════════════════════════════════════
// Auto-Penalty Rules
// ═══════════════════════════════════════════════════════════════

interface AutoPenaltyRule {
  signalType: RiskSignalType;
  minSeverity: "medium" | "high" | "critical";
  minConfidence: number;
  creditPenalty: number;
  trustPenalty: number;
  description: string;
}

const AUTO_PENALTY_RULES: AutoPenaltyRule[] = [
  {
    signalType: "wash_settlement",
    minSeverity: "critical",
    minConfidence: 0.9,
    creditPenalty: 50,
    trustPenalty: 10,
    description: "Wash settlement from same wallet",
  },
  {
    signalType: "identity_reset",
    minSeverity: "high",
    minConfidence: 0.85,
    creditPenalty: 100,
    trustPenalty: 20,
    description: "New agent created to escape bad reputation",
  },
  {
    signalType: "trust_ring",
    minSeverity: "critical",
    minConfidence: 0.85,
    creditPenalty: 40,
    trustPenalty: 8,
    description: "Collusion ring detected with critical severity",
  },
  {
    signalType: "self_deal_loop",
    minSeverity: "high",
    minConfidence: 0.8,
    creditPenalty: 30,
    trustPenalty: 5,
    description: "Self-dealing loop detected with high confidence",
  },
  {
    signalType: "spam_task_farming",
    minSeverity: "critical",
    minConfidence: 0.85,
    creditPenalty: 25,
    trustPenalty: 5,
    description: "Critical spam task farming detected",
  },
  {
    signalType: "cross_validation_abuse",
    minSeverity: "high",
    minConfidence: 0.8,
    creditPenalty: 30,
    trustPenalty: 5,
    description: "Validator-worker collusion detected",
  },
  {
    signalType: "graph_concentration",
    minSeverity: "critical",
    minConfidence: 0.9,
    creditPenalty: 20,
    trustPenalty: 4,
    description: "Extreme interaction graph concentration",
  },
];

// ═══════════════════════════════════════════════════════════════
// Severity ordering helper
// ═══════════════════════════════════════════════════════════════

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 } as const;

function meetsSeverity(
  signalSeverity: string,
  minSeverity: string,
): boolean {
  return (SEVERITY_ORDER[signalSeverity as keyof typeof SEVERITY_ORDER] ?? 0) >=
    (SEVERITY_ORDER[minSeverity as keyof typeof SEVERITY_ORDER] ?? 0);
}

// ═══════════════════════════════════════════════════════════════
// Apply Penalties
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate active signals against auto-penalty rules and apply penalties.
 *
 * Returns the number of penalties applied and any governance proposals created.
 */
export async function applyAutoPenalties(
  agentId: string,
  signals: RiskSignal[],
  config: FraudDetectionConfig,
): Promise<{ penaltiesApplied: number; governanceProposals: string[] }> {
  if (!config.autoPenaltyEnabled) {
    return { penaltiesApplied: 0, governanceProposals: [] };
  }

  // Fetch agent details
  const agentDoc = await adminDb().collection("agents").doc(agentId).get();
  if (!agentDoc.exists) {
    return { penaltiesApplied: 0, governanceProposals: [] };
  }

  const agent = agentDoc.data() as Agent;
  if (!agent.asn || !agent.walletAddress) {
    return { penaltiesApplied: 0, governanceProposals: [] };
  }

  let penaltiesApplied = 0;
  const governanceProposals: string[] = [];

  // Only process active, non-penalized signals
  const activeSignals = signals.filter((s) => s.status === "active");

  for (const signal of activeSignals) {
    // Find matching rule
    const rule = AUTO_PENALTY_RULES.find(
      (r) =>
        r.signalType === signal.signalType &&
        meetsSeverity(signal.severity, r.minSeverity) &&
        signal.confidence >= r.minConfidence,
    );

    if (!rule) continue;

    try {
      if (rule.creditPenalty > 50) {
        // Large penalty → governance approval required
        const proposalId = await createPenaltyProposal(
          agent.asn,
          agent.walletAddress,
          -rule.creditPenalty,
          `FRAUD AUTO-DETECT: ${rule.description} (signal: ${signal.signalType}, confidence: ${signal.confidence.toFixed(2)})`,
          "fraud-detection-system",
          [process.env.PLATFORM_ADMIN_WALLETS?.split(",")[0] || "platform-admin"].filter(Boolean),
        );
        governanceProposals.push(proposalId);
        await updateSignalStatus(signal.id!, "escalated");
      } else {
        // Small penalty → apply directly
        await emitPenalty(
          agent.asn,
          agent.walletAddress,
          -rule.creditPenalty,
          `FRAUD AUTO-PENALTY: ${rule.description} (signal: ${signal.signalType}, confidence: ${signal.confidence.toFixed(2)})`,
        );
        await updateSignalStatus(signal.id!, "penalized");
      }

      penaltiesApplied++;

      // Log activity
      try {
        await logActivity({
          orgId: agent.orgId || "platform",
          eventType: "fraud.auto_penalty" as any,
          actorType: "system",
          actorId: "fraud-detection",
          targetType: "agent",
          targetId: agentId,
          targetName: agent.name || agentId,
          description: `Auto-penalty: -${rule.creditPenalty} credit for ${rule.description}`,
          metadata: {
            signalType: signal.signalType,
            severity: signal.severity,
            confidence: signal.confidence,
            creditPenalty: -rule.creditPenalty,
            trustPenalty: -rule.trustPenalty,
            requiresGovernance: rule.creditPenalty > 50,
          },
        });
      } catch {
        // Non-blocking
      }

      // Audit log
      try {
        await recordAuditEntry({
          action: `fraud.auto_penalty.${signal.signalType}`,
          performedBy: "fraud-detection-system",
          targetType: "risk_signal" as any,
          targetId: signal.id || agentId,
          metadata: {
            agentId,
            creditPenalty: -rule.creditPenalty,
            trustPenalty: -rule.trustPenalty,
            confidence: signal.confidence,
          },
        });
      } catch {
        // Non-blocking
      }
    } catch (error) {
      console.error(`Failed to apply auto-penalty for ${agentId}:`, error);
    }
  }

  // Handle tier-based actions
  const riskScore = signals
    .filter((s) => s.status === "active" || s.status === "penalized")
    .length * 10; // Rough estimate; actual scoring done elsewhere

  const tier = computeRiskTier(riskScore);
  if (tier === "banned") {
    try {
      // Pause the agent
      await adminDb().collection("agents").doc(agentId).update({
        status: "paused",
        pauseReason: "FRAUD_FLAGGED",
      });

      await logActivity({
        orgId: agent.orgId || "platform",
        eventType: "fraud.agent_banned" as any,
        actorType: "system",
        actorId: "fraud-detection",
        targetType: "agent",
        targetId: agentId,
        targetName: agent.name || agentId,
        description: `Agent paused: risk score exceeded ban threshold`,
      });
    } catch (error) {
      console.error(`Failed to pause agent ${agentId}:`, error);
    }
  }

  return { penaltiesApplied, governanceProposals };
}
