/**
 * Heartbeat / Agent Status Monitor
 *
 * Track agent uptime with online/offline/degraded status.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type AgentStatus = "online" | "offline" | "degraded" | "paused";

export interface AgentHeartbeat {
    agentId: string;
    agentName?: string;
    status: AgentStatus;
    lastSeen: Date | null;
    latencyMs?: number;
    version?: string;
    uptime?: number; // seconds
}

export const STATUS_CONFIG: Record<AgentStatus, { label: string; color: string; dot: string }> = {
    online: { label: "Online", color: "text-emerald-400", dot: "bg-emerald-400" },
    offline: { label: "Offline", color: "text-red-400", dot: "bg-red-400" },
    degraded: { label: "Degraded", color: "text-amber-400", dot: "bg-amber-400" },
    paused: { label: "Paused", color: "text-gray-400", dot: "bg-gray-400" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore
// ═══════════════════════════════════════════════════════════════

const HEARTBEAT_COLLECTION = "agentHeartbeats";

/** Record/update an agent's heartbeat */
export async function recordHeartbeat(
    orgId: string,
    agentId: string,
    data?: { agentName?: string; latencyMs?: number; version?: string; uptime?: number }
): Promise<void> {
    const ref = adminDb().collection(HEARTBEAT_COLLECTION).doc(`${orgId}_${agentId}`);
    await ref.set({
        orgId,
        agentId,
        agentName: data?.agentName || agentId,
        status: "online" as AgentStatus,
        lastSeen: FieldValue.serverTimestamp(),
        latencyMs: data?.latencyMs,
        version: data?.version,
        uptime: data?.uptime,
    }, { merge: true });
}

/** Get all agent heartbeats for an org */
export async function getHeartbeats(orgId: string): Promise<AgentHeartbeat[]> {
    const snap = await adminDb().collection(HEARTBEAT_COLLECTION).where("orgId", "==", orgId).get();
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000; // 5 minutes

    return snap.docs.map((d) => {
        const data = d.data();
        const lastSeen = data.lastSeen instanceof Timestamp ? data.lastSeen.toDate() : null;
        const elapsed = lastSeen ? now - lastSeen.getTime() : Infinity;

        let status: AgentStatus = "offline";
        if (elapsed < STALE_MS) status = "online";
        else if (elapsed < STALE_MS * 3) status = "degraded";

        return {
            agentId: data.agentId,
            agentName: data.agentName,
            status,
            lastSeen,
            latencyMs: data.latencyMs,
            version: data.version,
            uptime: data.uptime,
        } as AgentHeartbeat;
    });
}

/** Check for stale agents that haven't checked in */
export async function getStaleAgents(orgId: string): Promise<AgentHeartbeat[]> {
    const all = await getHeartbeats(orgId);
    return all.filter(a => a.status !== "online");
}

// ═══════════════════════════════════════════════════════════════
// Pause / Resume
// ═══════════════════════════════════════════════════════════════

/** Pause an agent (prevents message processing) */
export async function pauseAgent(
    orgId: string,
    agentId: string,
    pausedBy: string,
    reason?: string
): Promise<void> {
    // Update agent status in agents collection
    const agentRef = adminDb().collection("agents").doc(agentId);
    await agentRef.set({
        status: "paused",
        pausedAt: FieldValue.serverTimestamp(),
        pausedBy,
        pauseReason: reason || "",
    }, { merge: true });

    // Update heartbeat status
    const heartbeatRef = adminDb().collection(HEARTBEAT_COLLECTION).doc(`${orgId}_${agentId}`);
    await heartbeatRef.set({
        status: "paused" as AgentStatus,
        pausedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

/** Resume a paused agent */
export async function resumeAgent(
    orgId: string,
    agentId: string
): Promise<void> {
    // Update agent status in agents collection
    const agentRef = adminDb().collection("agents").doc(agentId);
    await agentRef.set({
        status: "online",
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
    }, { merge: true });

    // Update heartbeat status
    const heartbeatRef = adminDb().collection(HEARTBEAT_COLLECTION).doc(`${orgId}_${agentId}`);
    await heartbeatRef.set({
        status: "online" as AgentStatus,
        lastSeen: FieldValue.serverTimestamp(),
    }, { merge: true });
}
