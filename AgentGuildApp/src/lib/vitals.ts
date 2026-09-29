/**
 * System Vitals — CPU, RAM, Disk monitoring
 *
 * Inspired by jontsai/openclaw-command-center vitals rendering.
 */

import {
    collection,
    doc,
    setDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CpuInfo {
    usage: number;      // 0-100
    userPercent?: number;
    sysPercent?: number;
    idlePercent?: number;
    chip?: string;
}

export interface MemoryInfo {
    usedBytes: number;
    totalBytes: number;
    percent: number;    // 0-100
}

export interface DiskInfo {
    usedBytes: number;
    totalBytes: number;
    percent: number;    // 0-100
}

export interface SystemVitals {
    id: string;
    orgId: string;
    hostname?: string;
    uptime?: string;
    cpu: CpuInfo;
    memory: MemoryInfo;
    disk: DiskInfo;
    timestamp: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

export function fmtBytes(bytes: number): string {
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(1)} KB`;
}

export function vitalColor(pct: number): string {
    if (pct >= 85) return "text-red-400";
    if (pct >= 60) return "text-amber-400";
    return "text-emerald-400";
}

export function vitalBg(pct: number): string {
    if (pct >= 85) return "bg-red-500";
    if (pct >= 60) return "bg-amber-500";
    return "bg-emerald-500";
}

// ═══════════════════════════════════════════════════════════════
// Firestore
// ═══════════════════════════════════════════════════════════════

const VITALS_COLLECTION = "systemVitals";

export async function recordVitals(
    orgId: string,
    data: Omit<SystemVitals, "id" | "orgId" | "timestamp">
): Promise<void> {
    const ref = doc(db, VITALS_COLLECTION, `${orgId}_latest`);
    await setDoc(ref, { orgId, ...data, timestamp: serverTimestamp() }, { merge: true });
}

export async function getLatestVitals(orgId: string): Promise<SystemVitals | null> {
    const q = query(
        collection(db, VITALS_COLLECTION),
        where("orgId", "==", orgId),
        orderBy("timestamp", "desc"),
        limit(1),
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    const data = d.data();
    return {
        id: d.id,
        orgId: data.orgId,
        hostname: data.hostname,
        uptime: data.uptime,
        cpu: data.cpu,
        memory: data.memory,
        disk: data.disk,
        timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
    };
}
