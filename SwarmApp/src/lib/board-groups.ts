/**
 * Board Groups — Group multiple boards under a category
 *
 * Inspired by abhi1693/openclaw-mission-control board-groups component.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface BoardGroup {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    icon?: string;
    boardIds: string[];
    position: number;
    createdAt: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const BOARD_GROUP_COLLECTION = "boardGroups";

export async function createBoardGroup(
    orgId: string,
    name: string,
    opts?: { description?: string; icon?: string },
): Promise<string> {
    const snap = await adminDb().collection(BOARD_GROUP_COLLECTION).where("orgId", "==", orgId).get();
    const maxPos = snap.docs.reduce((m, d) => Math.max(m, d.data().position || 0), 0);

    const ref = await adminDb().collection(BOARD_GROUP_COLLECTION).add({
        orgId, name, description: opts?.description || "", icon: opts?.icon || "📁",
        boardIds: [], position: maxPos + 1, createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

export async function getBoardGroups(orgId: string): Promise<BoardGroup[]> {
    const snap = await adminDb()
        .collection(BOARD_GROUP_COLLECTION)
        .where("orgId", "==", orgId)
        .orderBy("position", "asc")
        .get();
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id, orgId: data.orgId, name: data.name, description: data.description,
            icon: data.icon, boardIds: data.boardIds || [], position: data.position,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as BoardGroup;
    });
}

export async function updateBoardGroup(id: string, updates: Partial<BoardGroup>): Promise<void> {
    const { id: _id, createdAt, ...rest } = updates;
    await adminDb().collection(BOARD_GROUP_COLLECTION).doc(id).update(rest);
}

export async function addBoardToGroup(groupId: string, boardId: string): Promise<void> {
    const ref = adminDb().collection(BOARD_GROUP_COLLECTION).doc(groupId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const ids: string[] = snap.data()!.boardIds || [];
    if (!ids.includes(boardId)) {
        await ref.update({ boardIds: [...ids, boardId] });
    }
}

export async function deleteBoardGroup(id: string): Promise<void> {
    await adminDb().collection(BOARD_GROUP_COLLECTION).doc(id).delete();
}
