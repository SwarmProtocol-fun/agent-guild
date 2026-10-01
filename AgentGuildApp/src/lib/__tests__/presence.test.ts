import { describe, expect, it } from "vitest";
import { PRESENCE_STALE_MS, applyLivePresence, liveStatus, timestampMillis } from "../presence";

const NOW = 1_700_000_000_000;

describe("liveStatus", () => {
    it("stays paused even when the heartbeat is old", () => {
        expect(liveStatus({ status: "paused", lastSeen: NOW - PRESENCE_STALE_MS * 10 }, NOW)).toBe("paused");
    });

    it("is online when the heartbeat is fresh", () => {
        expect(liveStatus({ status: "online", lastSeen: NOW - 20_000 }, NOW)).toBe("online");
    });

    it("is offline when the stored flag still says online but the heartbeat is stale", () => {
        expect(liveStatus({ status: "online", lastSeen: NOW - PRESENCE_STALE_MS - 1 }, NOW)).toBe("offline");
    });

    it("keeps busy only while the heartbeat is fresh", () => {
        expect(liveStatus({ status: "busy", lastSeen: NOW - 10_000 }, NOW)).toBe("busy");
        expect(liveStatus({ status: "busy", lastSeen: NOW - PRESENCE_STALE_MS - 1 }, NOW)).toBe("offline");
    });

    it("is offline with no heartbeat", () => {
        expect(liveStatus({ status: "online" }, NOW)).toBe("offline");
    });

    it("honors an explicit checkout newer than the last heartbeat", () => {
        expect(liveStatus({
            status: "online",
            lastSeen: NOW - 5_000,
            offlineAt: NOW - 1_000,
        }, NOW)).toBe("offline");
    });

    it("comes back online when a newer heartbeat lands after checkout", () => {
        expect(liveStatus({
            status: "offline",
            lastSeen: NOW - 5_000,
            offlineAt: NOW - 30_000,
        }, NOW)).toBe("online");
    });

    it("reads Firestore-style timestamps", () => {
        expect(timestampMillis({ seconds: 1_700_000_000 })).toBe(1_700_000_000_000);
        expect(timestampMillis({ toMillis: () => NOW })).toBe(NOW);
    });

    it("applyLivePresence overwrites a stale stored online flag", () => {
        const agent = applyLivePresence({ id: "a", status: "online", lastSeen: NOW - PRESENCE_STALE_MS - 5 }, NOW);
        expect(agent.status).toBe("offline");
        expect(agent.id).toBe("a");
    });
});
