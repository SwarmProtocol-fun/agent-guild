/**
 * Credit Audit Log
 *
 * Firestore collection `creditAuditLog` that records every credit/trust
 * score change with before/after values, source, and reason.
 *
 * Separate from the marketplace `marketplaceAuditLog` — this tracks
 * score changes specifically.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";

const CREDIT_AUDIT_COLLECTION = "creditAuditLog";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CreditAuditEntry {
    id?: string;
    /** Agent document ID */
    agentId: string;
    /** Agent Social Number */
    asn: string;
    /** How the change originated */
    source: "auto" | "admin" | "system";
    /** Wallet address of the admin who performed the override (admin source only) */
    performedBy?: string;
    /** Credit score before the change */
    creditBefore: number;
    /** Credit score after the change */
    creditAfter: number;
    /** Trust score before the change */
    trustBefore: number;
    /** Trust score after the change */
    trustAfter: number;
    /** Human-readable reason for the change */
    reason: string;
    /** HCS event type if source is "auto" */
    eventType?: string;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
    /** Firestore server timestamp */
    timestamp?: { seconds: number; nanoseconds: number };
}

// ═══════════════════════════════════════════════════════════════
// Write
// ═══════════════════════════════════════════════════════════════

/** Record a credit audit entry. Returns the new document ID. */
export async function recordCreditAudit(
    entry: Omit<CreditAuditEntry, "id" | "timestamp">,
): Promise<string> {
    const ref = await adminDb().collection(CREDIT_AUDIT_COLLECTION).add({
        ...entry,
        timestamp: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Read
// ═══════════════════════════════════════════════════════════════

/** Query the credit audit log with optional filters. */
export async function getCreditAuditLog(opts: {
    agentId?: string;
    limit?: number;
    source?: CreditAuditEntry["source"];
}): Promise<CreditAuditEntry[]> {
    let q: Query = adminDb().collection(CREDIT_AUDIT_COLLECTION);

    if (opts.agentId) {
        q = q.where("agentId", "==", opts.agentId);
    }
    if (opts.source) {
        q = q.where("source", "==", opts.source);
    }

    q = q.orderBy("timestamp", "desc").limit(opts.limit || 50);

    const snap = await q.get();

    return snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
    })) as CreditAuditEntry[];
}
