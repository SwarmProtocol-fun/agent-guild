/**
 * Marketplace Audit Log
 *
 * Thin Firestore helper for recording and querying admin actions
 * in the `marketplaceAuditLog` collection.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";

const AUDIT_COLLECTION = "marketplaceAuditLog";

export interface AuditEntry {
  id?: string;
  action: string; // e.g. "submission.approved", "listing.suspended", "publisher.banned"
  performedBy: string; // admin wallet address
  targetType: "submission" | "listing" | "publisher" | "report" | "mod_service" | "settings" | "ranking" | "transaction" | "risk_signal" | "fraud_case" | "risk_profile";
  targetId: string;
  metadata?: Record<string, unknown>;
  timestamp?: { seconds: number; nanoseconds: number };
}

/** Record an audit entry. Returns the new document ID. */
export async function recordAuditEntry(
  entry: Omit<AuditEntry, "id" | "timestamp">,
): Promise<string> {
  const ref = await adminDb().collection(AUDIT_COLLECTION).add({
    ...entry,
    timestamp: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Query the audit log with optional filters. */
export async function getAuditLog(opts: {
  limit?: number;
  action?: string;
  targetId?: string;
  targetType?: AuditEntry["targetType"];
}): Promise<AuditEntry[]> {
  let q: Query = adminDb().collection(AUDIT_COLLECTION);

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
  })) as AuditEntry[];
}
