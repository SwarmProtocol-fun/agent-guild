/**
 * Credit Event Validation
 *
 * Manual field-level validation for canonical credit events.
 * No Zod — matches codebase convention of TypeScript interfaces + manual checks.
 */

import type { CreditEventInput, CreditEventType, EventProvenance, EventSeverity } from "./types";

// ═══════════════════════════════════════════════════════════════
// Valid Values
// ═══════════════════════════════════════════════════════════════

const VALID_EVENT_TYPES: CreditEventType[] = [
  "agent.registered", "agent.verified",
  "task.assigned", "task.accepted", "task.completed", "task.overdue", "task.disputed",
  "payment.settled", "payment.failed",
  "runtime.online", "runtime.offline", "runtime.error",
  "fraud.flagged", "fraud.cleared",
];

const VALID_PROVENANCES: EventProvenance[] = [
  "on_chain", "marketplace", "runtime", "task_lifecycle", "admin", "system",
];

const VALID_SEVERITIES: EventSeverity[] = [
  "info", "low", "medium", "high", "critical",
];

const MAX_CREDIT_DELTA = 100;
const MIN_CREDIT_DELTA = -100;
const MAX_TRUST_DELTA = 50;
const MIN_TRUST_DELTA = -50;
const MAX_FUTURE_DRIFT_SECONDS = 300;

// ═══════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a CreditEventInput. Returns { valid, errors }. */
export function validateCreditEvent(event: Partial<CreditEventInput>): ValidationResult {
  const errors: string[] = [];

  // eventType
  if (!event.eventType) {
    errors.push("eventType is required");
  } else if (!VALID_EVENT_TYPES.includes(event.eventType as CreditEventType)) {
    errors.push(`eventType must be one of: ${VALID_EVENT_TYPES.join(", ")}`);
  }

  // agentId
  if (!event.agentId || typeof event.agentId !== "string") {
    errors.push("agentId is required and must be a string");
  }

  // orgId
  if (!event.orgId || typeof event.orgId !== "string") {
    errors.push("orgId is required and must be a string");
  }

  // provenance
  if (!event.provenance) {
    errors.push("provenance is required");
  } else if (!VALID_PROVENANCES.includes(event.provenance as EventProvenance)) {
    errors.push(`provenance must be one of: ${VALID_PROVENANCES.join(", ")}`);
  }

  // severity
  if (!event.severity) {
    errors.push("severity is required");
  } else if (!VALID_SEVERITIES.includes(event.severity as EventSeverity)) {
    errors.push(`severity must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }

  // creditDelta
  if (typeof event.creditDelta !== "number") {
    errors.push("creditDelta is required and must be a number");
  } else if (event.creditDelta < MIN_CREDIT_DELTA || event.creditDelta > MAX_CREDIT_DELTA) {
    errors.push(`creditDelta must be between ${MIN_CREDIT_DELTA} and ${MAX_CREDIT_DELTA}`);
  }

  // trustDelta
  if (typeof event.trustDelta !== "number") {
    errors.push("trustDelta is required and must be a number");
  } else if (event.trustDelta < MIN_TRUST_DELTA || event.trustDelta > MAX_TRUST_DELTA) {
    errors.push(`trustDelta must be between ${MIN_TRUST_DELTA} and ${MAX_TRUST_DELTA}`);
  }

  // timestamp
  if (typeof event.timestamp !== "number") {
    errors.push("timestamp is required and must be a Unix seconds number");
  } else {
    const now = Math.floor(Date.now() / 1000);
    if (event.timestamp > now + MAX_FUTURE_DRIFT_SECONDS) {
      errors.push("timestamp cannot be more than 5 minutes in the future");
    }
    if (event.timestamp < 0) {
      errors.push("timestamp must be a positive number");
    }
  }

  // source
  if (!event.source) {
    errors.push("source is required");
  } else {
    if (!event.source.system || typeof event.source.system !== "string") {
      errors.push("source.system is required");
    }
    if (!event.source.sourceEventId || typeof event.source.sourceEventId !== "string") {
      errors.push("source.sourceEventId is required");
    }
    if (!event.source.sourceEventType || typeof event.source.sourceEventType !== "string") {
      errors.push("source.sourceEventType is required");
    }
  }

  // description
  if (!event.description || typeof event.description !== "string") {
    errors.push("description is required and must be a string");
  }

  return { valid: errors.length === 0, errors };
}

/** Compute the idempotency key from source fields */
export function computeIdempotencyKey(system: string, sourceEventId: string): string {
  return `${system}:${sourceEventId}`;
}
