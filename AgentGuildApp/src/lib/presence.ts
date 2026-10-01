/**
 * Live presence. The stored `status` field is a hint. A daemon is online
 * only while its heartbeat (`lastSeen`) is fresh. `paused` is intentional
 * and stays paused. `offlineAt` newer than `lastSeen` means the process
 * checked out on purpose.
 */

export const PRESENCE_STALE_MS = 2 * 60 * 1000;

export type LiveStatus = "online" | "offline" | "busy" | "paused";

export function timestampMillis(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1e12 ? value * 1000 : value;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === "string") {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === "object") {
        const v = value as {
            toMillis?: () => number;
            toDate?: () => Date;
            seconds?: number;
            _seconds?: number;
        };
        if (typeof v.toMillis === "function") {
            const ms = v.toMillis();
            return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
        }
        if (typeof v.toDate === "function") {
            const ms = v.toDate().getTime();
            return Number.isNaN(ms) ? null : ms;
        }
        const seconds = v.seconds ?? v._seconds;
        if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds * 1000;
    }
    return null;
}

export function liveStatus(
    input: { status?: string | null; lastSeen?: unknown; offlineAt?: unknown },
    now = Date.now(),
): LiveStatus {
    const stored = input.status || "offline";
    if (stored === "paused") return "paused";

    const lastSeen = timestampMillis(input.lastSeen);
    const offlineAt = timestampMillis(input.offlineAt);
    if (offlineAt != null && (lastSeen == null || offlineAt >= lastSeen)) return "offline";
    if (lastSeen == null || now - lastSeen > PRESENCE_STALE_MS) return "offline";
    if (stored === "busy") return "busy";
    return "online";
}

export function applyLivePresence<T extends { status?: string | null; lastSeen?: unknown; offlineAt?: unknown }>(
    agent: T,
    now = Date.now(),
): T {
    return { ...agent, status: liveStatus(agent, now) };
}

export function heartbeatAgeLabel(value: unknown, now = Date.now()): string | null {
    const ms = timestampMillis(value);
    if (ms == null) return null;
    const sec = Math.max(0, Math.round((now - ms) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 120) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return `${hr}h ago`;
}
