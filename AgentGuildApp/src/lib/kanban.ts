/**
 * Kanban Boards — Types + Firestore CRUD
 *
 * Multi-board system with agent assignments.
 * Each board has 5 columns: Inbox → Up Next → In Progress → In Review → Done
 */

import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
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

export type KanbanStatus = "inbox" | "up_next" | "in_progress" | "in_review" | "done";
export type KanbanPriority = "none" | "low" | "medium" | "high";

export const KANBAN_COLUMNS: { key: KanbanStatus; label: string; color: string; icon: string }[] = [
    { key: "inbox", label: "Inbox", color: "border-zinc-500/30", icon: "📥" },
    { key: "up_next", label: "Up Next", color: "border-blue-500/30", icon: "📋" },
    { key: "in_progress", label: "In Progress", color: "border-amber-500/30", icon: "⚡" },
    { key: "in_review", label: "In Review", color: "border-purple-500/30", icon: "🔍" },
    { key: "done", label: "Done", color: "border-emerald-500/30", icon: "✅" },
];

export const PRIORITY_CONFIG: Record<KanbanPriority, { label: string; color: string; dot: string }> = {
    none: { label: "None", color: "text-muted-foreground", dot: "bg-zinc-400" },
    low: { label: "Low", color: "text-blue-400", dot: "bg-blue-400" },
    medium: { label: "Medium", color: "text-amber-400", dot: "bg-amber-400" },
    high: { label: "High", color: "text-red-400", dot: "bg-red-400" },
};

export interface SubTask {
    id: string;
    title: string;
    completed: boolean;
}

// ── Board ──

export interface KanbanBoard {
    id: string;
    orgId: string;
    name: string;
    description?: string;
    /** Agent IDs assigned to this board */
    agentIds: string[];
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface KanbanBoardInput {
    orgId: string;
    name: string;
    description?: string;
    agentIds?: string[];
}

// ── Task ──

export interface KanbanTask {
    id: string;
    orgId: string;
    boardId: string;
    projectId?: string;
    title: string;
    description?: string;
    status: KanbanStatus;
    priority: KanbanPriority;
    assignee?: string;
    assigneeName?: string;
    subtasks: SubTask[];
    dueDate?: string;
    position: number;
    /** Task IDs that block this task */
    blockedBy?: string[];
    /** Reason for blocking */
    blockReason?: string;
    /** When the task was blocked */
    blockedAt?: Date | null;
    /** Group/category (e.g., Engineering, Design, Marketing) */
    group?: string;
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface KanbanTaskInput {
    orgId: string;
    boardId: string;
    projectId?: string;
    title: string;
    description?: string;
    status?: KanbanStatus;
    priority?: KanbanPriority;
    assignee?: string;
    assigneeName?: string;
    subtasks?: SubTask[];
    dueDate?: string;
    blockedBy?: string[];
    blockReason?: string;
    group?: string;
}

// ═══════════════════════════════════════════════════════════════
// Board CRUD
// ═══════════════════════════════════════════════════════════════

const BOARD_COLLECTION = "kanbanBoards";

export async function createBoard(input: KanbanBoardInput): Promise<string> {
    const ref = await addDoc(collection(db, BOARD_COLLECTION), {
        ...input,
        agentIds: input.agentIds || [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

export async function updateBoard(id: string, updates: Partial<Omit<KanbanBoard, "id" | "createdAt">>): Promise<void> {
    const ref = doc(db, BOARD_COLLECTION, id);
    await updateDoc(ref, { ...updates, updatedAt: serverTimestamp() });
}

export async function deleteBoard(id: string): Promise<void> {
    // Delete all tasks belonging to this board
    const q = query(collection(db, KANBAN_COLLECTION), where("boardId", "==", id));
    const snap = await getDocs(q);
    const deletes = snap.docs.map(d => deleteDoc(doc(db, KANBAN_COLLECTION, d.id)));
    await Promise.all(deletes);
    // Delete the board itself
    await deleteDoc(doc(db, BOARD_COLLECTION, id));
}

export async function getBoards(orgId: string): Promise<KanbanBoard[]> {
    const q = query(
        collection(db, BOARD_COLLECTION),
        where("orgId", "==", orgId),
        orderBy("createdAt", "asc"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            name: data.name,
            description: data.description,
            agentIds: data.agentIds || [],
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        } as KanbanBoard;
    });
}

// ═══════════════════════════════════════════════════════════════
// Task CRUD
// ═══════════════════════════════════════════════════════════════

const KANBAN_COLLECTION = "kanbanTasks";

export async function createKanbanTask(input: KanbanTaskInput): Promise<string> {
    // Get max position in the target column for this board
    const q = query(
        collection(db, KANBAN_COLLECTION),
        where("orgId", "==", input.orgId),
        where("boardId", "==", input.boardId),
        where("status", "==", input.status || "inbox"),
    );
    const snap = await getDocs(q);
    const maxPos = snap.docs.reduce((max, d) => Math.max(max, d.data().position || 0), 0);

    const ref = await addDoc(collection(db, KANBAN_COLLECTION), {
        ...input,
        status: input.status || "inbox",
        priority: input.priority || "none",
        subtasks: input.subtasks || [],
        position: maxPos + 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

export async function updateKanbanTask(id: string, updates: Partial<KanbanTask>): Promise<void> {
    const ref = doc(db, KANBAN_COLLECTION, id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, createdAt, ...rest } = updates;
    await updateDoc(ref, { ...rest, updatedAt: serverTimestamp() });
}

export async function moveTask(id: string, newStatus: KanbanStatus, newPosition: number): Promise<void> {
    const ref = doc(db, KANBAN_COLLECTION, id);
    await updateDoc(ref, { status: newStatus, position: newPosition, updatedAt: serverTimestamp() });
}

export async function deleteKanbanTask(id: string): Promise<void> {
    await deleteDoc(doc(db, KANBAN_COLLECTION, id));
}

export async function getKanbanTasks(orgId: string, boardId: string): Promise<KanbanTask[]> {
    const q = query(
        collection(db, KANBAN_COLLECTION),
        where("orgId", "==", orgId),
        where("boardId", "==", boardId),
        orderBy("position", "asc"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            boardId: data.boardId,
            projectId: data.projectId,
            title: data.title,
            description: data.description,
            status: data.status,
            priority: data.priority,
            assignee: data.assignee,
            assigneeName: data.assigneeName,
            subtasks: data.subtasks || [],
            dueDate: data.dueDate,
            position: data.position,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        } as KanbanTask;
    });
}

/** Group tasks by column status */
export function groupByStatus(tasks: KanbanTask[]): Record<KanbanStatus, KanbanTask[]> {
    const groups: Record<KanbanStatus, KanbanTask[]> = {
        inbox: [], up_next: [], in_progress: [], in_review: [], done: [],
    };
    for (const task of tasks) {
        groups[task.status]?.push(task);
    }
    // Sort each column by position
    for (const key of Object.keys(groups) as KanbanStatus[]) {
        groups[key].sort((a, b) => a.position - b.position);
    }
    return groups;
}
