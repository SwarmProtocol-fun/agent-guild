/**
 * Credit Event Ingestion — Canonical Types
 *
 * Single source of truth for all score-affecting agent behavior.
 * Normalizes events from 7+ source systems into a unified schema.
 */

// ═══════════════════════════════════════════════════════════════
// Canonical Event Taxonomy
// ═══════════════════════════════════════════════════════════════

/** 14 canonical event types covering all credit-affecting actions */
export type CreditEventType =
  | "agent.registered"
  | "agent.verified"
  | "task.assigned"
  | "task.accepted"
  | "task.completed"
  | "task.overdue"
  | "task.disputed"
  | "payment.settled"
  | "payment.failed"
  | "runtime.online"
  | "runtime.offline"
  | "runtime.error"
  | "fraud.flagged"
  | "fraud.cleared";

/** Where the event originated */
export type EventProvenance =
  | "on_chain"
  | "marketplace"
  | "runtime"
  | "task_lifecycle"
  | "admin"
  | "system";

/** Severity level for scoring impact */
export type EventSeverity = "info" | "low" | "medium" | "high" | "critical";

// ═══════════════════════════════════════════════════════════════
// Core Event Interface
// ═══════════════════════════════════════════════════════════════

/** The canonical credit event — single source of truth */
export interface CreditEvent {
  /** Firestore document ID */
  id: string;
  /** Canonical event type */
  eventType: CreditEventType;
  /** Agent identifiers */
  agentId: string;
  asn?: string;
  agentAddress?: string;
  orgId: string;
  /** Credit/trust impact */
  creditDelta: number;
  trustDelta: number;
  /** Provenance + severity */
  provenance: EventProvenance;
  severity: EventSeverity;
  /** Source tracking */
  source: {
    system: string;
    sourceEventId: string;
    sourceEventType: string;
  };
  /** Deduplication key: "{source.system}:{source.sourceEventId}" */
  idempotencyKey: string;
  /** Event timestamp — Unix seconds */
  timestamp: number;
  /** Human-readable description */
  description: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Firestore server timestamp */
  createdAt: unknown;
  /** HCS transaction ID if forwarded to chain */
  hcsTxId?: string;
}

/** Input shape for creating a credit event (before ID/createdAt/idempotencyKey) */
export type CreditEventInput = Omit<CreditEvent, "id" | "createdAt" | "idempotencyKey">;

// ═══════════════════════════════════════════════════════════════
// Result Types
// ═══════════════════════════════════════════════════════════════

export interface IngestResult {
  success: boolean;
  eventId?: string;
  deduplicated?: boolean;
  error?: string;
}

export interface BatchIngestResult {
  total: number;
  ingested: number;
  deduplicated: number;
  errors: Array<{ index: number; error: string }>;
  eventIds: string[];
}

// ═══════════════════════════════════════════════════════════════
// Query Types
// ═══════════════════════════════════════════════════════════════

export interface CreditEventQuery {
  agentId?: string;
  asn?: string;
  orgId?: string;
  eventType?: CreditEventType;
  provenance?: EventProvenance;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  orderDirection?: "asc" | "desc";
}

export interface ReplayRequest {
  fromTimestamp: number;
  toTimestamp: number;
  agentId?: string;
  eventType?: CreditEventType;
  dryRun?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Source Event Mapping
// ═══════════════════════════════════════════════════════════════

/** Maps source system event types → canonical CreditEventType */
export const SOURCE_EVENT_MAP: Record<string, CreditEventType> = {
  // hedera-hcs-client ScoreEvent types
  "task_complete": "task.completed",
  "task_fail": "task.disputed",
  "skill_report": "agent.verified",
  "penalty": "fraud.flagged",
  "bonus": "task.completed",
  "checkpoint": "agent.verified",

  // hedera-slashing SlashingEvent reasons
  "missed_deadline": "task.overdue",
  "severely_late": "task.overdue",
  "abandoned": "task.overdue",
  "sla_violation": "task.disputed",

  // assignments status transitions
  "assignment.created": "task.assigned",
  "assignment.accepted": "task.accepted",
  "assignment.completed": "task.completed",
  "assignment.rejected": "task.disputed",
  "assignment.overdue": "task.overdue",

  // hedera-job-bounty event types
  "job_posted": "task.assigned",
  "job_claimed": "task.accepted",
  "bounty_escrowed": "payment.settled",
  "bounty_released": "payment.settled",
  "bounty_refunded": "payment.failed",

  // firestore agent lifecycle
  "agent.created": "agent.registered",
  "agent.onchain_registered": "agent.verified",

  // activity event types (credit-relevant subset)
  "agent.connected": "runtime.online",
  "agent.disconnected": "runtime.offline",
};
