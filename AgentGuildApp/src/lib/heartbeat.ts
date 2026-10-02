/**
 * Heartbeat / Agent Status Monitor
 *
 * Track agent uptime with online/offline/degraded status.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { PRESENCE_STALE_MS, liveStatus } from "./presence";

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

/**
 * Daemon heartbeat. Keeps paused/busy. Anything else with a fresh ping is
 * online, and a previous checkout is cleared.
 */
export async function noteAgentHeartbeat(
    agentId: string,
    orgId?: string | null,
    extra?: { agentName?: string; latencyMs?: number; version?: string; uptime?: number },
): Promise<string> {
    const agentRef = adminDb().collection("agents").doc(agentId);
    const snap = await agentRef.get();
    const data = snap.exists ? snap.data() : undefined;
    const stored = data?.status;
    const status = stored === "paused" || stored === "busy" ? stored : "online";

    // Daemons ping every 30s but presence only goes stale after
    // PRESENCE_STALE_MS, so refreshing lastSeen on every ping doubles the
    // write bill for nothing. Skip while nothing changed and the stored
    // lastSeen is still recent; a status change or checkout always writes.
    const lastSeenMs = data?.lastSeen instanceof Timestamp ? data.lastSeen.toMillis() : 0;
    if (status === stored && !data?.offlineAt && Date.now() - lastSeenMs < HEARTBEAT_WRITE_MIN_MS) {
        return status;
    }

    await agentRef.set({
        status,
        lastSeen: FieldValue.serverTimestamp(),
        offlineAt: FieldValue.delete(),
    }, { merge: true });
    if (orgId) {
        await recordHeartbeat(orgId, agentId, extra);
        // The sibling sweep reads every agent in the org. Run on every 30s
        // ping it scaled reads with agents² — a 20-agent org cost >1M
        // reads/day. Once per org per window is enough: readers derive live
        // status from lastSeen anyway, and the global tick still sweeps.
        const lastSweep = lastOrgSweepAt.get(orgId) || 0;
        if (Date.now() - lastSweep >= ORG_SWEEP_INTERVAL_MS) {
            lastOrgSweepAt.set(orgId, Date.now());
            await sweepStaleAgents(orgId);
        }
    }
    return status;
}

const HEARTBEAT_WRITE_MIN_MS = PRESENCE_STALE_MS / 2;
const ORG_SWEEP_INTERVAL_MS = PRESENCE_STALE_MS / 2;
const lastOrgSweepAt = new Map<string, number>();

/** Process checked out. Does not refresh lastSeen. */
export async function noteAgentOffline(agentId: string): Promise<void> {
    await adminDb().collection("agents").doc(agentId).set({
        status: "offline",
        offlineAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

/**
 * Flip stored status to match the heartbeat clock.
 * With an orgId, every agent in that org is checked (so a fresh heartbeat
 * can also correct siblings). Without one, only stored online/busy rows are
 * scanned — that's the global tick, and it is what marks a dead daemon
 * offline after the process itself is gone.
 */
export async function sweepStaleAgents(orgId?: string): Promise<number> {
    const base = adminDb().collection("agents");
    const snap = orgId
        ? await base.where("orgId", "==", orgId).get()
        : await base.where("status", "in", ["online", "busy"]).get();
    const now = Date.now();
    let flipped = 0;
    for (const doc of snap.docs) {
        const data = doc.data();
        const live = liveStatus({
            status: data.status,
            lastSeen: data.lastSeen,
            offlineAt: data.offlineAt,
        }, now);
        if (live === data.status) continue;
        if (live === "offline") {
            await doc.ref.set({
                status: "offline",
                offlineAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } else {
            await doc.ref.set({
                status: live,
                offlineAt: FieldValue.delete(),
            }, { merge: true });
        }
        flipped++;
    }
    return flipped;
}

export { PRESENCE_STALE_MS };

/** Record/update an agent's heartbeat */
export async function recordHeartbeat(
    orgId: string,
    agentId: string,
    data?: { agentName?: string; latencyMs?: number; version?: string; uptime?: number }
): Promise<void> {
    const ref = adminDb().collection(HEARTBEAT_COLLECTION).doc(`${orgId}_${agentId}`);
    // firebase-admin rejects undefined. The daemon ping calls this with no
    // metrics, so those fields stay off the document instead of failing the write.
    const patch: { [key: string]: unknown } = {
        orgId,
        agentId,
        agentName: data?.agentName || agentId,
        status: "online" as AgentStatus,
        lastSeen: FieldValue.serverTimestamp(),
    };
    if (typeof data?.latencyMs === "number") patch.latencyMs = data.latencyMs;
    if (data?.version) patch.version = data.version;
    if (typeof data?.uptime === "number") patch.uptime = data.uptime;
    await ref.set(patch, { merge: true });
}

/** Get all agent heartbeats for an org */
export async function getHeartbeats(orgId: string): Promise<AgentHeartbeat[]> {
    const snap = await adminDb().collection(HEARTBEAT_COLLECTION).where("orgId", "==", orgId).get();
    const now = Date.now();
    const STALE_MS = PRESENCE_STALE_MS;

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
    const snap = await agentRef.get();
    const data = snap.data() || {};
    // Resume clears pause. It does not invent a heartbeat — a dead daemon
    // stays offline until the process pings again.
    const live = liveStatus({ status: "online", lastSeen: data.lastSeen, offlineAt: null });
    await agentRef.set({
        status: live,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
        ...(live === "offline"
            ? { offlineAt: FieldValue.serverTimestamp() }
            : { offlineAt: FieldValue.delete() }),
    }, { merge: true });

    const heartbeatRef = adminDb().collection(HEARTBEAT_COLLECTION).doc(`${orgId}_${agentId}`);
    await heartbeatRef.set({
        status: live,
    }, { merge: true });
}
