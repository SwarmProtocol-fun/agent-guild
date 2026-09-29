/**
 * Approval / Governance System — Types + Firestore CRUD
 *
 * Route sensitive agent actions through human approval.
 * Agents request approval → humans approve/reject → action proceeds or is blocked.
 */

import {
    collection,
    doc,
    addDoc,
    updateDoc,
    getDocs,
    query,
    where,
    orderBy,
    serverTimestamp,
    Timestamp,
    getCountFromServer,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalType =
    | "transaction"    // on-chain tx
    | "job_dispatch"   // dispatching a job
    | "agent_action"   // generic agent action
    | "data_access"    // accessing sensitive data
    | "external_call"  // calling external API
    | "config_change"; // changing settings

export interface Approval {
    id: string;
    orgId: string;
    projectId?: string;
    /** What needs approval */
    type: ApprovalType;
    /** Current status */
    status: ApprovalStatus;
    /** Human-readable title */
    title: string;
    /** Detailed description of what the agent wants to do */
    description: string;
    /** Raw payload (tx data, API call, etc.) */
    payload?: Record<string, unknown>;
    /** Agent's self-assessed confidence (0-1) */
    confidence?: number;
    /** Which agent requested this */
    requestedBy: string;
    requestedByName?: string;
    /** Who reviewed it */
    reviewedBy?: string;
    /** Reviewer's comment */
    reviewComment?: string;
    /** Related task/job IDs */
    taskIds?: string[];
    /** Priority */
    priority?: "low" | "medium" | "high" | "critical";
    createdAt: Date | null;
    reviewedAt: Date | null;
}

export interface ApprovalCreateInput {
    orgId: string;
    projectId?: string;
    type: ApprovalType;
    title: string;
    description: string;
    payload?: Record<string, unknown>;
    confidence?: number;
    requestedBy: string;
    requestedByName?: string;
    taskIds?: string[];
    priority?: "low" | "medium" | "high" | "critical";
}

export interface ApprovalReviewInput {
    status: "approved" | "rejected";
    reviewedBy: string;
    reviewComment?: string;
}

// ═══════════════════════════════════════════════════════════════
// Type Labels & Icons
// ═══════════════════════════════════════════════════════════════

export const APPROVAL_TYPE_CONFIG: Record<ApprovalType, { label: string; icon: string; color: string }> = {
    transaction: { label: "Transaction", icon: "💰", color: "text-amber-400" },
    job_dispatch: { label: "Job Dispatch", icon: "🚀", color: "text-blue-400" },
    agent_action: { label: "Agent Action", icon: "🤖", color: "text-purple-400" },
    data_access: { label: "Data Access", icon: "🔐", color: "text-red-400" },
    external_call: { label: "External API", icon: "🌐", color: "text-cyan-400" },
    config_change: { label: "Config Change", icon: "⚙️", color: "text-emerald-400" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const APPROVALS_COLLECTION = "approvals";

/** Create a new approval request */
export async function createApproval(input: ApprovalCreateInput): Promise<string> {
    const ref = await addDoc(collection(db, APPROVALS_COLLECTION), {
        ...input,
        status: "pending" as ApprovalStatus,
        createdAt: serverTimestamp(),
        reviewedAt: null,
    });
    return ref.id;
}

/** Review (approve/reject) an approval */
export async function reviewApproval(id: string, input: ApprovalReviewInput): Promise<void> {
    const ref = doc(db, APPROVALS_COLLECTION, id);
    await updateDoc(ref, {
        status: input.status,
        reviewedBy: input.reviewedBy,
        reviewComment: input.reviewComment || null,
        reviewedAt: serverTimestamp(),
    });
}

/** Get approvals for an org, optionally filtered by status */
export async function getApprovals(
    orgId: string,
    status?: ApprovalStatus,
): Promise<Approval[]> {
    const constraints = [
        where("orgId", "==", orgId),
        orderBy("createdAt", "desc"),
    ];
    if (status) {
        constraints.splice(1, 0, where("status", "==", status));
    }
    const q = query(collection(db, APPROVALS_COLLECTION), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            projectId: data.projectId,
            type: data.type,
            status: data.status,
            title: data.title,
            description: data.description,
            payload: data.payload,
            confidence: data.confidence,
            requestedBy: data.requestedBy,
            requestedByName: data.requestedByName,
            reviewedBy: data.reviewedBy,
            reviewComment: data.reviewComment,
            taskIds: data.taskIds,
            priority: data.priority,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
            reviewedAt: data.reviewedAt instanceof Timestamp ? data.reviewedAt.toDate() : null,
        } as Approval;
    });
}

/** Get count of pending approvals for an org */
export async function getPendingCount(orgId: string): Promise<number> {
    const q = query(
        collection(db, APPROVALS_COLLECTION),
        where("orgId", "==", orgId),
        where("status", "==", "pending"),
    );
    const snap = await getCountFromServer(q);
    return snap.data().count;
}
