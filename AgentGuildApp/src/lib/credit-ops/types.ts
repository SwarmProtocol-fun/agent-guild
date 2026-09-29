/**
 * Credit Operations — Type Definitions
 *
 * All types for the credit ops governance system: review queue,
 * overrides, policies, models, appeals, disputes, and alerts.
 */

// ═══════════════════════════════════════════════════════════════
// Shared
// ═══════════════════════════════════════════════════════════════

export interface ReviewHistoryEntry {
  action: string;
  performedBy: string;
  performedAt: string; // ISO timestamp
  comment?: string;
}

// ═══════════════════════════════════════════════════════════════
// Review Queue
// ═══════════════════════════════════════════════════════════════

export type ReviewFlagType =
  | "slashing"
  | "anomaly"
  | "fraud"
  | "manual"
  | "appeal_trigger";

export type ReviewStatus = "pending" | "in_review" | "resolved" | "dismissed";

export type ReviewPriority = "low" | "medium" | "high" | "critical";

export type ReviewResolution =
  | "override_applied"
  | "no_action"
  | "penalty_increased"
  | "penalty_reversed"
  | "appeal_granted";

export interface CreditOpsReviewItem {
  id: string;
  agentId: string;
  asn: string;
  agentAddress: string;
  orgId: string;
  // Flagging info
  flagType: ReviewFlagType;
  flagReason: string;
  flaggedBy: "system" | "admin" | "governance";
  sourceEventId?: string;
  // Current scores at time of flagging
  currentCreditScore: number;
  currentTrustScore: number;
  currentTier: string;
  // Review state
  status: ReviewStatus;
  priority: ReviewPriority;
  assignedTo?: string;
  resolution?: ReviewResolution;
  resolutionComment?: string;
  reviewHistory: ReviewHistoryEntry[];
  // Timestamps
  flaggedAt?: { seconds: number; nanoseconds: number };
  reviewedAt?: { seconds: number; nanoseconds: number };
  resolvedAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Overrides
// ═══════════════════════════════════════════════════════════════

export type OverrideType = "temporary" | "permanent";
export type OverrideApprovalStatus = "pending" | "approved" | "rejected";

export interface CreditOpsOverride {
  id: string;
  agentId: string;
  asn: string;
  // What changed
  overrideType: OverrideType;
  previousCreditScore: number;
  previousTrustScore: number;
  newCreditScore: number;
  newTrustScore: number;
  creditDelta: number;
  trustDelta: number;
  // Why
  reason: string;
  reviewQueueItemId?: string;
  appealId?: string;
  // Approval
  requestedBy: string;
  approvedBy: string[];
  approvalStatus: OverrideApprovalStatus;
  // Temporary overrides
  expiresAt?: { seconds: number; nanoseconds: number };
  expired: boolean;
  // Rollback
  rolledBack: boolean;
  rollbackAt?: { seconds: number; nanoseconds: number };
  rollbackBy?: string;
  rollbackReason?: string;
  // On-chain
  hcsTxId?: string;
  onChainTxHash?: string;
  // Timestamps
  createdAt?: { seconds: number; nanoseconds: number };
  appliedAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Policies
// ═══════════════════════════════════════════════════════════════

export type PolicyStatus = "active" | "draft" | "archived";

export interface EventWeight {
  credit: number;
  trust: number;
}

export interface SlashingRule {
  credit: number;
  trust: number;
  hoursThreshold: number;
}

export interface AnomalyThresholds {
  maxScoreChangePerHour: number;
  minEventsForAnomaly: number;
  rapidEventWindowMinutes: number;
  rapidEventMax: number;
}

export interface CreditOpsPolicy {
  id: string;
  version: number;
  status: PolicyStatus;
  // Tier boundaries
  tierBoundaries: {
    platinum: number;
    gold: number;
    silver: number;
  };
  // Score ranges
  scoreRange: { min: number; max: number };
  trustRange: { min: number; max: number };
  defaultCreditScore: number;
  defaultTrustScore: number;
  // Event weights
  eventWeights: {
    task_complete_simple: EventWeight;
    task_complete_medium: EventWeight;
    task_complete_complex: EventWeight;
    task_fail: EventWeight;
    skill_report: EventWeight;
  };
  // Slashing rules
  slashingRules: {
    missedDeadline: SlashingRule;
    severelyLate: SlashingRule;
    abandoned: SlashingRule;
    governanceThreshold: number;
  };
  // Anomaly detection
  anomalyThresholds: AnomalyThresholds;
  // Metadata
  createdBy: string;
  createdAt?: { seconds: number; nanoseconds: number };
  activatedAt?: { seconds: number; nanoseconds: number };
  description?: string;
}

// ═══════════════════════════════════════════════════════════════
// Score Models
// ═══════════════════════════════════════════════════════════════

export type ModelStatus =
  | "draft"
  | "shadow"
  | "active"
  | "deprecated"
  | "rolled_back";

export interface ShadowResults {
  agentsSampled: number;
  avgCreditDivergence: number;
  avgTrustDivergence: number;
  maxCreditDivergence: number;
  promotionRecommendations: number;
  demotionRecommendations: number;
}

export interface CreditOpsModel {
  id: string;
  version: string;
  status: ModelStatus;
  // Model definition
  policyId: string;
  description: string;
  changelog: string;
  // Shadow mode
  shadowModeEnabled: boolean;
  shadowStartedAt?: { seconds: number; nanoseconds: number };
  shadowResults?: ShadowResults;
  // Rollout
  publishedBy: string;
  publishedAt?: { seconds: number; nanoseconds: number };
  activatedAt?: { seconds: number; nanoseconds: number };
  rollbackAt?: { seconds: number; nanoseconds: number };
  rollbackBy?: string;
  rollbackReason?: string;
  previousModelId?: string;
  // Timestamps
  createdAt?: { seconds: number; nanoseconds: number };
  updatedAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Appeals
// ═══════════════════════════════════════════════════════════════

export type AppealType =
  | "penalty"
  | "slashing"
  | "score_anomaly"
  | "tier_demotion";

export type AppealStatus =
  | "submitted"
  | "under_review"
  | "additional_info_requested"
  | "resolved"
  | "rejected"
  | "escalated";

export interface AppealResolution {
  outcome: "granted" | "partially_granted" | "denied";
  overrideId?: string;
  comment: string;
  resolvedBy: string;
}

export interface CreditOpsAppeal {
  id: string;
  // Who is appealing
  appellantType: "agent" | "org_owner";
  appellantId: string;
  agentId: string;
  asn: string;
  orgId: string;
  // What they're appealing
  appealType: AppealType;
  relatedEventId?: string;
  relatedOverrideId?: string;
  // Appeal content
  subject: string;
  description: string;
  evidence?: string[];
  // Score context
  scoreAtTimeOfEvent: { credit: number; trust: number };
  currentScore: { credit: number; trust: number };
  requestedOutcome?: string;
  // Review state
  status: AppealStatus;
  priority: ReviewPriority;
  assignedTo?: string;
  reviewHistory: ReviewHistoryEntry[];
  resolution?: AppealResolution;
  // Timestamps
  submittedAt?: { seconds: number; nanoseconds: number };
  lastUpdatedAt?: { seconds: number; nanoseconds: number };
  resolvedAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Disputes
// ═══════════════════════════════════════════════════════════════

export type DisputeType =
  | "score_discrepancy"
  | "unfair_penalty"
  | "governance_decision"
  | "tier_dispute"
  | "other";

export type DisputeStatus =
  | "filed"
  | "investigating"
  | "mediation"
  | "adjudicated"
  | "closed";

export interface DisputeAction {
  type: "override" | "penalty" | "reversal" | "warning" | "no_action";
  targetAgentId?: string;
  details: Record<string, unknown>;
}

export interface DisputeAdjudication {
  decision: string;
  rationale: string;
  actions: DisputeAction[];
  adjudicatedBy: string;
  adjudicatedAt: string;
}

export interface CreditOpsDispute {
  id: string;
  // Parties
  initiatorType: "agent" | "org";
  initiatorId: string;
  respondentType: "agent" | "org" | "platform";
  respondentId: string;
  // Dispute details
  disputeType: DisputeType;
  subject: string;
  description: string;
  evidence?: string[];
  // Context
  relatedAgentIds: string[];
  relatedEventIds: string[];
  // Adjudication
  status: DisputeStatus;
  priority: ReviewPriority;
  assignedTo?: string;
  adjudication?: DisputeAdjudication;
  reviewHistory: ReviewHistoryEntry[];
  // Timestamps
  filedAt?: { seconds: number; nanoseconds: number };
  lastUpdatedAt?: { seconds: number; nanoseconds: number };
  closedAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Alerts
// ═══════════════════════════════════════════════════════════════

export type AlertType =
  | "anomaly"
  | "threshold_breach"
  | "rapid_change"
  | "rapid_score_change"
  | "mass_slashing"
  | "model_divergence";

export type AlertSeverity = "info" | "warning" | "critical";

export interface CreditOpsAlert {
  id: string;
  alertType: AlertType;
  severity: AlertSeverity;
  agentId?: string;
  asn?: string;
  message: string;
  details: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: { seconds: number; nanoseconds: number };
  autoCreatedReviewId?: string;
  createdAt?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Audit Log
// ═══════════════════════════════════════════════════════════════

export type CreditOpsAuditTargetType =
  | "agent"
  | "policy"
  | "model"
  | "appeal"
  | "dispute"
  | "override";

export interface CreditOpsAuditEntry {
  id?: string;
  action: string;
  performedBy: string;
  targetType: CreditOpsAuditTargetType;
  targetId: string;
  metadata?: Record<string, unknown>;
  timestamp?: { seconds: number; nanoseconds: number };
}
