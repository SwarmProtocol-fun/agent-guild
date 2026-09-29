/**
 * Credit Event Ingestion Pipeline
 *
 * Core pipeline: validate → dedup → store → optional HCS forward.
 * Includes normalizers for each source system.
 */

import type {
  CreditEventInput,
  CreditEventType,
  EventProvenance,
  EventSeverity,
  IngestResult,
  BatchIngestResult,
} from "./types";
import { SOURCE_EVENT_MAP } from "./types";
import { validateCreditEvent, computeIdempotencyKey } from "./validation";
import { isDuplicate, storeCreditEvent } from "./store";
// [swarm-core] Hedera HCS removed — install swarm-hedera mod
import type { ScoreEvent } from "@/lib/credit-types";
const isHCSConfigured = () => false;
const submitScoreEvent = async (..._args: unknown[]) => ({});

// ═══════════════════════════════════════════════════════════════
// Core Ingestion Pipeline
// ═══════════════════════════════════════════════════════════════

/**
 * Ingest a single credit event through the full pipeline:
 * validate → dedup → store → optional HCS forward.
 */
export async function ingestCreditEvent(
  event: CreditEventInput,
  options?: { forwardToHCS?: boolean },
): Promise<IngestResult> {
  // Step 1: Validate
  const validation = validateCreditEvent(event);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join("; ") };
  }

  // Step 2: Idempotency check
  const idempotencyKey = computeIdempotencyKey(
    event.source.system,
    event.source.sourceEventId,
  );
  const duplicate = await isDuplicate(idempotencyKey);
  if (duplicate) {
    return { success: true, deduplicated: true };
  }

  // Step 3: Store
  const eventId = await storeCreditEvent(event);

  // Step 4: Optional HCS forward (non-blocking)
  if (options?.forwardToHCS && isHCSConfigured()) {
    forwardToHCS(event).catch((err) => {
      console.error("Failed to forward credit event to HCS:", err);
    });
  }

  return { success: true, eventId };
}

/**
 * Ingest a batch of credit events.
 */
export async function ingestCreditEventBatch(
  events: CreditEventInput[],
  options?: { forwardToHCS?: boolean },
): Promise<BatchIngestResult> {
  const result: BatchIngestResult = {
    total: events.length,
    ingested: 0,
    deduplicated: 0,
    errors: [],
    eventIds: [],
  };

  for (let i = 0; i < events.length; i++) {
    const ingestResult = await ingestCreditEvent(events[i], options);
    if (ingestResult.success) {
      if (ingestResult.deduplicated) {
        result.deduplicated++;
      } else {
        result.ingested++;
        if (ingestResult.eventId) {
          result.eventIds.push(ingestResult.eventId);
        }
      }
    } else {
      result.errors.push({ index: i, error: ingestResult.error || "Unknown error" });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// HCS Forwarding (non-blocking, fire-and-forget)
// ═══════════════════════════════════════════════════════════════

async function forwardToHCS(event: CreditEventInput): Promise<void> {
  const scoreEvent: ScoreEvent = {
    type: mapToScoreEventType(event.eventType),
    asn: event.asn || "",
    agentAddress: event.agentAddress || "",
    creditDelta: event.creditDelta,
    trustDelta: event.trustDelta,
    timestamp: event.timestamp,
    metadata: {
      canonicalEventType: event.eventType,
      provenance: event.provenance,
      ...event.metadata,
    },
  };

  await submitScoreEvent(scoreEvent);
}

function mapToScoreEventType(eventType: CreditEventType): ScoreEvent["type"] {
  if (eventType === "task.completed") return "task_complete";
  if (eventType === "task.overdue" || eventType === "task.disputed") return "task_fail";
  if (eventType === "agent.verified") return "skill_report";
  if (eventType.startsWith("fraud.")) return "penalty";
  return "bonus";
}

// ═══════════════════════════════════════════════════════════════
// Normalizers — Convert source system events to CreditEventInput
// ═══════════════════════════════════════════════════════════════

// [swarm-core] Hedera integration removed — install swarm-hedera mod
export function normalizeScoreEvent(
  scoreEvent: ScoreEvent,
  agentId: string,
  orgId: string,
): CreditEventInput {
  const eventType = SOURCE_EVENT_MAP[scoreEvent.type] || "task.completed";
  return {
    eventType,
    agentId,
    asn: scoreEvent.asn,
    agentAddress: scoreEvent.agentAddress,
    orgId,
    creditDelta: scoreEvent.creditDelta,
    trustDelta: scoreEvent.trustDelta,
    provenance: "on_chain",
    severity: deriveSeverity(scoreEvent.creditDelta),
    source: {
      system: "hedera-hcs",
      sourceEventId: `${scoreEvent.asn}-${scoreEvent.timestamp}-${scoreEvent.type}`,
      sourceEventType: scoreEvent.type,
    },
    timestamp: scoreEvent.timestamp,
    description: `HCS score event: ${scoreEvent.type} (credit: ${scoreEvent.creditDelta > 0 ? "+" : ""}${scoreEvent.creditDelta})`,
    metadata: scoreEvent.metadata,
  };
}

/** Normalize a SlashingEvent into CreditEventInput */
export function normalizeSlashingEvent(
  slashingEvent: {
    taskId: string;
    agentId: string;
    asn: string;
    agentAddress: string;
    reason: "missed_deadline" | "severely_late" | "abandoned" | "sla_violation";
    creditPenalty: number;
    trustPenalty: number;
  },
  orgId: string,
): CreditEventInput {
  const eventType = SOURCE_EVENT_MAP[slashingEvent.reason] || "task.overdue";
  return {
    eventType,
    agentId: slashingEvent.agentId,
    asn: slashingEvent.asn,
    agentAddress: slashingEvent.agentAddress,
    orgId,
    creditDelta: slashingEvent.creditPenalty,
    trustDelta: slashingEvent.trustPenalty,
    provenance: "system",
    severity: slashingEvent.reason === "abandoned" ? "high" : "medium",
    source: {
      system: "hedera-slashing",
      sourceEventId: `slash-${slashingEvent.taskId}-${slashingEvent.reason}`,
      sourceEventType: slashingEvent.reason,
    },
    timestamp: Math.floor(Date.now() / 1000),
    description: `Auto-slash: ${slashingEvent.reason.replace(/_/g, " ")} for task ${slashingEvent.taskId}`,
    metadata: { taskId: slashingEvent.taskId },
  };
}

/** Normalize a TaskAssignment status change into CreditEventInput */
export function normalizeAssignmentEvent(
  assignmentId: string,
  agentId: string,
  orgId: string,
  statusChange: "created" | "accepted" | "completed" | "rejected" | "overdue",
  metadata?: Record<string, unknown>,
): CreditEventInput {
  const sourceType = `assignment.${statusChange}`;
  const eventType = SOURCE_EVENT_MAP[sourceType] || "task.assigned";

  const deltas: Record<string, { credit: number; trust: number }> = {
    created: { credit: 0, trust: 0 },
    accepted: { credit: 0, trust: 0 },
    completed: { credit: 5, trust: 1 },
    rejected: { credit: 0, trust: 0 },
    overdue: { credit: -5, trust: -1 },
  };

  const delta = deltas[statusChange] || { credit: 0, trust: 0 };

  return {
    eventType,
    agentId,
    orgId,
    creditDelta: delta.credit,
    trustDelta: delta.trust,
    provenance: "task_lifecycle",
    severity: statusChange === "overdue" ? "medium" : "info",
    source: {
      system: "assignments",
      sourceEventId: `assign-${assignmentId}-${statusChange}`,
      sourceEventType: sourceType,
    },
    timestamp: Math.floor(Date.now() / 1000),
    description: `Assignment ${statusChange}: ${assignmentId}`,
    metadata: { assignmentId, ...metadata },
  };
}

/** Normalize a JobBountyEvent into CreditEventInput */
export function normalizeJobBountyEvent(
  bountyEvent: {
    type: "job_posted" | "job_claimed" | "bounty_escrowed" | "bounty_released" | "bounty_refunded";
    jobId: string;
    scheduledTxId?: string;
    bountyAmount?: string;
    recipientAccountId?: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  },
  agentId: string,
  orgId: string,
): CreditEventInput {
  const eventType = SOURCE_EVENT_MAP[bountyEvent.type] || "payment.settled";

  const deltas: Record<string, { credit: number; trust: number }> = {
    job_posted: { credit: 0, trust: 0 },
    job_claimed: { credit: 0, trust: 0 },
    bounty_escrowed: { credit: 0, trust: 0 },
    bounty_released: { credit: 10, trust: 2 },
    bounty_refunded: { credit: -5, trust: -1 },
  };

  const delta = deltas[bountyEvent.type] || { credit: 0, trust: 0 };

  return {
    eventType,
    agentId,
    orgId,
    creditDelta: delta.credit,
    trustDelta: delta.trust,
    provenance: bountyEvent.type.startsWith("bounty") ? "on_chain" : "marketplace",
    severity: bountyEvent.type === "bounty_refunded" ? "medium" : "info",
    source: {
      system: "hedera-job-bounty",
      sourceEventId: `job-${bountyEvent.jobId}-${bountyEvent.type}`,
      sourceEventType: bountyEvent.type,
    },
    timestamp: bountyEvent.timestamp,
    description: `Job bounty: ${bountyEvent.type.replace(/_/g, " ")} for job ${bountyEvent.jobId}`,
    metadata: {
      jobId: bountyEvent.jobId,
      scheduledTxId: bountyEvent.scheduledTxId,
      bountyAmount: bountyEvent.bountyAmount,
      ...bountyEvent.metadata,
    },
  };
}

/** Normalize an agent registration event */
export function normalizeAgentRegistration(
  agentId: string,
  orgId: string,
  asn?: string,
  walletAddress?: string,
  isOnChain?: boolean,
): CreditEventInput {
  return {
    eventType: isOnChain ? "agent.verified" : "agent.registered",
    agentId,
    asn,
    agentAddress: walletAddress,
    orgId,
    creditDelta: isOnChain ? 10 : 0,
    trustDelta: isOnChain ? 5 : 0,
    provenance: isOnChain ? "on_chain" : "system",
    severity: "info",
    source: {
      system: "firestore",
      sourceEventId: `agent-reg-${agentId}${isOnChain ? "-onchain" : ""}`,
      sourceEventType: isOnChain ? "agent.onchain_registered" : "agent.created",
    },
    timestamp: Math.floor(Date.now() / 1000),
    description: isOnChain
      ? `Agent ${agentId} verified on-chain`
      : `Agent ${agentId} registered`,
    metadata: { asn, walletAddress },
  };
}

/** Normalize a runtime status event (online/offline/error) */
export function normalizeRuntimeEvent(
  agentId: string,
  orgId: string,
  status: "online" | "offline" | "error",
  metadata?: Record<string, unknown>,
): CreditEventInput {
  const eventTypeMap: Record<string, CreditEventType> = {
    online: "runtime.online",
    offline: "runtime.offline",
    error: "runtime.error",
  };

  return {
    eventType: eventTypeMap[status],
    agentId,
    orgId,
    creditDelta: status === "error" ? -2 : 0,
    trustDelta: status === "error" ? -1 : 0,
    provenance: "runtime",
    severity: status === "error" ? "medium" : "info",
    source: {
      system: "runtime",
      sourceEventId: `runtime-${agentId}-${status}-${Math.floor(Date.now() / 1000)}`,
      sourceEventType: `agent.${status === "online" ? "connected" : status === "offline" ? "disconnected" : "error"}`,
    },
    timestamp: Math.floor(Date.now() / 1000),
    description: `Agent ${agentId} ${status}`,
    metadata,
  };
}

/** Normalize a fraud/moderation event */
export function normalizeFraudEvent(
  agentId: string,
  orgId: string,
  action: "flagged" | "cleared",
  reason: string,
  creditDelta: number,
  trustDelta: number,
  metadata?: Record<string, unknown>,
): CreditEventInput {
  return {
    eventType: action === "flagged" ? "fraud.flagged" : "fraud.cleared",
    agentId,
    orgId,
    creditDelta,
    trustDelta,
    provenance: "admin",
    severity: action === "flagged" ? "high" : "medium",
    source: {
      system: "admin",
      sourceEventId: `fraud-${agentId}-${action}-${Math.floor(Date.now() / 1000)}`,
      sourceEventType: `fraud.${action}`,
    },
    timestamp: Math.floor(Date.now() / 1000),
    description: `Fraud ${action}: ${reason}`,
    metadata: { reason, ...metadata },
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function deriveSeverity(creditDelta: number): EventSeverity {
  const abs = Math.abs(creditDelta);
  if (abs === 0) return "info";
  if (abs <= 5) return "low";
  if (abs <= 15) return "medium";
  if (abs <= 30) return "high";
  return "critical";
}
