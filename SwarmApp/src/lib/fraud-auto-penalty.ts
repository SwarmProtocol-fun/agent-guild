/**
 * Fraud Auto-Penalty Engine
 *
 * Rule-based system that automatically applies penalties for clear-cut
 * fraud signals. Small penalties (≤50 credit) go directly through
 * emitPenalty(). Large penalties (>50) route through the governance
 * multi-party approval system.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { emitPenalty } from "./mod-stubs";
import { updateSignalStatus, type RiskSignal, type RiskSignalType, type FraudDetectionConfig } from "./fraud-detection";
import { computeRiskTier } from "./fraud-risk-scoring";
import { logActivity } from "./activity";
import { recordAuditEntry } from "./audit-log";
import { recordCreditAudit } from "./credit-audit-log";
import { fireWebhooks } from "./credit-webhooks";
import { invalidateCache } from "./credit-cache";
import { requestOverride } from "./credit-ops/override";
import type { Agent } from "./firestore";

const MIN_CREDIT_SCORE = 300;
const MIN_TRUST_SCORE = 0;

/**
 * Apply a credit/trust penalty directly to the agent's live scores.
 *
 * This is the actual score mutation for auto-detected fraud — separate from
 * emitPenalty(), which only notifies the (optional) swarm-hedera mod's score
 * ledger and is non-blocking/best-effort.
 */
async function applyCreditPenalty(
  agentId: string,
  agent: Agent,
  creditPenalty: number,
  trustPenalty: number,
  reason: string,
): Promise<{ creditBefore: number; creditAfter: number; trustBefore: number; trustAfter: number }> {
  const ref = adminDb().collection("agents").doc(agentId);

  // Re-read inside a transaction rather than using the caller's (possibly
  // stale, pre-loop) `agent` snapshot for the score fields, and write the
  // clamped absolute result. When a single scan produces multiple
  // penalizable signals for the same agent, each call now compounds on the
  // previous call's committed result instead of every call independently
  // computing "baseline - penalty" off the same stale score and overwriting
  // each other (only the last write would have survived).
  const { creditBefore, creditAfter, trustBefore, trustAfter } = await adminDb().runTransaction(
    async (tx) => {
      const snap = await tx.get(ref);
      const data = (snap.data() as Agent) || {};
      const creditBefore = (data.creditScore as number) ?? 680;
      const trustBefore = (data.trustScore as number) ?? 50;
      const creditAfter = Math.max(MIN_CREDIT_SCORE, creditBefore - creditPenalty);
      const trustAfter = Math.max(MIN_TRUST_SCORE, trustBefore - trustPenalty);

      tx.update(ref, {
        creditScore: creditAfter,
        trustScore: trustAfter,
        lastCreditUpdate: FieldValue.serverTimestamp(),
        lastCreditReason: reason,
      });

      return { creditBefore, creditAfter, trustBefore, trustAfter };
    },
  );

  recordCreditAudit({
    agentId,
    asn: agent.asn || "",
    source: "auto",
    creditBefore,
    creditAfter,
    trustBefore,
    trustAfter,
    reason,
    eventType: "fraud_auto_penalty",
  }).catch((err) => console.error("[fraud-auto-penalty] Failed to record credit audit:", err));

  invalidateCache(`credit:${agentId}`);

  fireWebhooks(agentId, "score_change", {
    previousCreditScore: creditBefore,
    newCreditScore: creditAfter,
    previousTrustScore: trustBefore,
    newTrustScore: trustAfter,
    delta: { credit: creditAfter - creditBefore, trust: trustAfter - trustBefore },
    trigger: "fraud_auto_penalty",
  }).catch((err) => console.error("[fraud-auto-penalty] Webhook dispatch error:", err));

  return { creditBefore, creditAfter, trustBefore, trustAfter };
}

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
      const reason = `FRAUD AUTO-DETECT: ${rule.description} (signal: ${signal.signalType}, confidence: ${signal.confidence.toFixed(2)})`;

      if (rule.creditPenalty > 50) {
        // Large penalty → real governance approval workflow (second-admin
        // sign-off), same path used by manual admin overrides. Scores are
        // NOT deducted until an admin approves. Re-read live rather than
        // reusing the pre-loop `agentDoc` snapshot, so a governance proposal
        // that follows an earlier direct penalty in this same scan computes
        // its target off the agent's actual current score.
        const freshDoc = await adminDb().collection("agents").doc(agentId).get();
        const current = (freshDoc.data() as Agent) || agent;
        const currentCredit = (current.creditScore as number) ?? 680;
        const currentTrust = (current.trustScore as number) ?? 50;
        const { overrideId } = await requestOverride({
          agentId,
          asn: agent.asn,
          newCreditScore: Math.max(MIN_CREDIT_SCORE, currentCredit - rule.creditPenalty),
          newTrustScore: Math.max(MIN_TRUST_SCORE, currentTrust - rule.trustPenalty),
          reason,
          overrideType: "permanent",
          requestedBy: "fraud-detection-system",
        });
        governanceProposals.push(overrideId);
        await updateSignalStatus(signal.id!, "escalated");
      } else {
        // Small penalty → apply directly to the agent's live score.
        await applyCreditPenalty(agentId, agent, rule.creditPenalty, rule.trustPenalty, reason);
        await updateSignalStatus(signal.id!, "penalized");
      }

      // Best-effort notify the optional swarm-hedera mod's score ledger.
      // Non-blocking: the real score mutation above already happened.
      emitPenalty(agent.asn, agent.walletAddress, -rule.creditPenalty, reason).catch(() => {
        /* swarm-hedera mod not installed — expected in core */
      });

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
