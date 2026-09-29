/**
 * Memory & Vector Search — Browse agent memory, semantic search
 *
 * Inspired by robsannaa/openclaw-mission-control memory-view + vector-view.
 */

import {
    collection,
    doc,
    addDoc,
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

export type MemoryType = "journal" | "long_term" | "workspace" | "vector";
export type MemorySubtype = "working_md" | "daily_note" | "memory_md" | "session_log";

export interface MemoryEntry {
    id: string;
    orgId: string;
    agentId: string;
    agentName?: string;
    type: MemoryType;
    title: string;
    content: string;
    filePath?: string;
    sizeBytes?: number;
    tags?: string[];
    subtype?: MemorySubtype;
    structuredData?: {
        date?: string;
        template?: string;
        sessionId?: string;
        [key: string]: unknown;
    };
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface VectorSearchResult {
    id: string;
    content: string;
    similarity: number; // 0-1
    source: string;
    agentId: string;
}

export const MEMORY_TYPE_CONFIG: Record<MemoryType, { label: string; icon: string; color: string }> = {
    journal: { label: "Daily Journal", icon: "📓", color: "text-blue-400" },
    long_term: { label: "Long-term", icon: "🧠", color: "text-purple-400" },
    workspace: { label: "Workspace", icon: "📁", color: "text-amber-400" },
    vector: { label: "Vector", icon: "🔍", color: "text-emerald-400" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const MEMORY_COLLECTION = "agentMemories";

export async function addMemoryEntry(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<string> {
    const ref = await addDoc(collection(db, MEMORY_COLLECTION), {
        ...entry, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    return ref.id;
}

export async function getMemoryEntries(orgId: string, agentId?: string, type?: MemoryType): Promise<MemoryEntry[]> {
    let q;
    if (agentId && type) {
        q = query(collection(db, MEMORY_COLLECTION),
            where("orgId", "==", orgId), where("agentId", "==", agentId), where("type", "==", type),
            orderBy("updatedAt", "desc"));
    } else if (agentId) {
        q = query(collection(db, MEMORY_COLLECTION),
            where("orgId", "==", orgId), where("agentId", "==", agentId),
            orderBy("updatedAt", "desc"));
    } else {
        q = query(collection(db, MEMORY_COLLECTION),
            where("orgId", "==", orgId), orderBy("updatedAt", "desc"));
    }
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id, orgId: data.orgId, agentId: data.agentId, agentName: data.agentName,
            type: data.type, title: data.title, content: data.content,
            filePath: data.filePath, sizeBytes: data.sizeBytes, tags: data.tags || [],
            subtype: data.subtype, structuredData: data.structuredData,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        } as MemoryEntry;
    });
}

/** Simple text search (full vector search requires external embedding service) */
export function searchMemory(entries: MemoryEntry[], query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return entries.filter(e =>
        e.title.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower) ||
        (e.tags && e.tags.some(t => t.toLowerCase().includes(lower)))
    );
}

export function fmtFileSize(bytes: number): string {
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
    return `${bytes} B`;
}
