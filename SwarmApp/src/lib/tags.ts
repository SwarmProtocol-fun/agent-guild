/**
 * Tags System — Taggable labels for tasks and boards
 *
 * Inspired by abhi1693/openclaw-mission-control tags component.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface Tag {
    id: string;
    orgId: string;
    name: string;
    color: string; // hex color
    icon?: string;
    usageCount: number;
    createdAt: Date | null;
}

export const TAG_COLORS = [
    "#EF4444", "#F97316", "#EAB308", "#22C55E", "#06B6D4",
    "#3B82F6", "#8B5CF6", "#EC4899", "#6B7280", "#F43F5E",
];

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const TAG_COLLECTION = "tags";

export async function createTag(orgId: string, name: string, color: string): Promise<string> {
    const ref = await adminDb().collection(TAG_COLLECTION).add({
        orgId, name, color, icon: "", usageCount: 0, createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

export async function getTags(orgId: string): Promise<Tag[]> {
    const snap = await adminDb().collection(TAG_COLLECTION).where("orgId", "==", orgId).get();
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id, orgId: data.orgId, name: data.name, color: data.color,
            icon: data.icon, usageCount: data.usageCount || 0,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as Tag;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateTag(id: string, updates: { name?: string; color?: string }): Promise<void> {
    await adminDb().collection(TAG_COLLECTION).doc(id).update(updates);
}

export async function deleteTag(id: string): Promise<void> {
    await adminDb().collection(TAG_COLLECTION).doc(id).delete();
}
