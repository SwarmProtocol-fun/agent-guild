/**
 * Credit Operations — Audit Log
 *
 * Thin Firestore helper for recording and querying credit-ops
 * admin actions in the `creditOpsAuditLog` collection.
 * Mirrors pattern from `@/lib/audit-log.ts`.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import type { CreditOpsAuditEntry, CreditOpsAuditTargetType } from "./types";

const CREDIT_OPS_AUDIT_COLLECTION = "creditOpsAuditLog";

/** Record a credit-ops audit entry. Returns the new document ID. */
export async function recordCreditOpsAudit(
  entry: Omit<CreditOpsAuditEntry, "id" | "timestamp">,
): Promise<string> {
  const ref = await adminDb().collection(CREDIT_OPS_AUDIT_COLLECTION).add({
    ...entry,
    timestamp: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Query the credit-ops audit log with optional filters. */
export async function getCreditOpsAuditLog(opts: {
  limit?: number;
  action?: string;
  targetId?: string;
  targetType?: CreditOpsAuditTargetType;
}): Promise<CreditOpsAuditEntry[]> {
  let q: Query = adminDb().collection(CREDIT_OPS_AUDIT_COLLECTION);

  if (opts.action) {
    q = q.where("action", "==", opts.action);
  }
  if (opts.targetId) {
    q = q.where("targetId", "==", opts.targetId);
  }
  if (opts.targetType) {
    q = q.where("targetType", "==", opts.targetType);
  }

  q = q.orderBy("timestamp", "desc").limit(opts.limit || 50);

  const snap = await q.get();

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as CreditOpsAuditEntry[];
}

/** Get audit entries for a specific agent (by ASN or agentId in targetId). */
export async function getCreditOpsAuditForAgent(
  agentIdentifier: string,
  max?: number,
): Promise<CreditOpsAuditEntry[]> {
  const snap = await adminDb()
    .collection(CREDIT_OPS_AUDIT_COLLECTION)
    .where("targetType", "==", "agent")
    .where("targetId", "==", agentIdentifier)
    .orderBy("timestamp", "desc")
    .limit(max || 50)
    .get();

  return snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as CreditOpsAuditEntry[];
}
