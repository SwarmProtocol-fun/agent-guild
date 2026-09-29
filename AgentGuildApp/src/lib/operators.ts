/**
 * Operators — Track users interacting with agents
 *
 * Inspired by jontsai/openclaw-command-center Operators panel.
 */

import {
    collection,
    doc,
    setDoc,
    getDocs,
    query,
    where,
    orderBy,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type OperatorRole = "admin" | "member" | "viewer";

export interface Operator {
    id: string;
    orgId: string;
    address: string;
    displayName?: string;
    role: OperatorRole;
    activeSessions: number;
    totalSessions: number;
    lastActive: Date | null;
}

export const ROLE_CONFIG: Record<OperatorRole, { label: string; color: string; bg: string }> = {
    admin: { label: "Admin", color: "text-amber-400", bg: "bg-amber-500/10" },
    member: { label: "Member", color: "text-blue-400", bg: "bg-blue-500/10" },
    viewer: { label: "Viewer", color: "text-zinc-400", bg: "bg-zinc-500/10" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore
// ═══════════════════════════════════════════════════════════════

const OPERATORS_COLLECTION = "operators";

export async function upsertOperator(
    orgId: string,
    address: string,
    data?: { displayName?: string; role?: OperatorRole }
): Promise<void> {
    const ref = doc(db, OPERATORS_COLLECTION, `${orgId}_${address}`);
    await setDoc(ref, {
        orgId,
        address,
        displayName: data?.displayName || address.slice(0, 6) + "..." + address.slice(-4),
        role: data?.role || "member",
        lastActive: serverTimestamp(),
    }, { merge: true });
}

export async function getOperators(orgId: string): Promise<Operator[]> {
    const q = query(
        collection(db, OPERATORS_COLLECTION),
        where("orgId", "==", orgId),
        orderBy("lastActive", "desc"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            address: data.address,
            displayName: data.displayName,
            role: data.role || "member",
            activeSessions: data.activeSessions || 0,
            totalSessions: data.totalSessions || 0,
            lastActive: data.lastActive instanceof Timestamp ? data.lastActive.toDate() : null,
        } as Operator;
    });
}

export async function updateRole(operatorId: string, role: OperatorRole): Promise<void> {
    const { updateDoc } = await import("firebase/firestore");
    await updateDoc(doc(db, OPERATORS_COLLECTION, operatorId), { role });
}
