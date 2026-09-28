/**
 * Gateway Audit Logger — Immutable log of state transitions.
 *
 * Records:
 * - Worker registration/deregistration
 * - Task state transitions
 * - Task reassignments
 * - Worker status changes
 * - Cancellations
 *
 * All writes are non-blocking — audit failures never break the operation
 * they are recording.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";

const AUDIT_COLLECTION = "gatewayAuditLog";

export type AuditAction =
  | "worker:registered"
  | "worker:deregistered"
  | "worker:marked_offline"
  | "worker:drained"
  | "task:enqueued"
  | "task:claimed"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  | "task:reassigned"
  | "task:timed_out";

export interface AuditEntry {
  id?: string;
  orgId: string;
  action: AuditAction;
  /** The ID of the entity this action applies to (workerId or taskId) */
  targetId: string;
  targetType: "worker" | "task";
  /** Who triggered this action (walletAddress, workerId, or "system") */
  actor?: string;
  /** Additional context — varies by action */
  details?: Record<string, unknown>;
  /** Firestore server timestamp (set automatically) */
  timestamp?: unknown;
}

/**
 * Write an audit entry. Non-blocking — swallows errors so callers are
 * never affected by audit failures.
 */
export async function logAudit(
  entry: Omit<AuditEntry, "id" | "timestamp">,
): Promise<void> {
  try {
    await adminDb().collection(AUDIT_COLLECTION).add({
      ...entry,
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[audit] Failed to log:", err);
    // Non-blocking — don't fail the operation for audit
  }
}

/**
 * Retrieve audit log entries for an org, optionally filtered by target.
 *
 * @param orgId   — organisation scope
 * @param targetId — optional filter by workerId or taskId
 * @param max     — maximum entries to return (default 100)
 */
export async function getAuditLog(
  orgId: string,
  targetId?: string,
  max = 100,
): Promise<AuditEntry[]> {
  let q: Query = adminDb().collection(AUDIT_COLLECTION).where("orgId", "==", orgId);
  if (targetId) q = q.where("targetId", "==", targetId);
  q = q.orderBy("timestamp", "desc").limit(max);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AuditEntry);
}
