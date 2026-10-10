// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeFirestore } from "../lending/__tests__/fake-firestore";

let db: FakeFirestore;
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));

const { verifyHuman, isOwnerHumanVerified, isVerifiedHuman, VERIFICATION_TTL_MS } = await import("@/lib/human-verification");

type Brain = { status: string; verdict?: string; confidence?: number };
let calls: string[];

function mockPoh(brains: Brain[], opts: { checkerStatus?: number } = {}) {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith("/checker")) {
            return new Response(JSON.stringify({ brainKey: "bk1", count: 3 }), { status: opts.checkerStatus ?? 200 });
        }
        return new Response(JSON.stringify(brains.shift() ?? { status: "pending" }), { status: 200 });
    }));
}

beforeEach(() => { db = new FakeFirestore(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("isVerifiedHuman", () => {
    it("needs HUMAN at >= 0.7 confidence", () => {
        expect(isVerifiedHuman("HUMAN", 0.85)).toBe(true);
        expect(isVerifiedHuman("HUMAN", 0.55)).toBe(false);
        expect(isVerifiedHuman("UNCERTAIN", 0.95)).toBe(false);
        expect(isVerifiedHuman("AI", 0.99)).toBe(false);
    });
});

describe("verifyHuman", () => {
    it("verifies a confident HUMAN verdict and stores it", async () => {
        mockPoh([{ status: "pending" }, { status: "done", verdict: "HUMAN", confidence: 0.86 }]);
        const v = await verifyHuman("W1", { pollDelayMs: 0 });
        expect(v).toMatchObject({ status: "done", verified: true, verdict: "HUMAN" });
        expect(await isOwnerHumanVerified("W1")).toBe(true);
    });

    it("UNCERTAIN isn't verified — but nothing is blocked either", async () => {
        mockPoh([{ status: "done", verdict: "UNCERTAIN", confidence: 0.3 }]);
        expect(await verifyHuman("W1", { pollDelayMs: 0 })).toMatchObject({ verified: false, verdict: "UNCERTAIN" });
        expect(await isOwnerHumanVerified("W1")).toBe(false);
    });

    it("a slow verdict stays pending, and the next call polls instead of spending another scan", async () => {
        mockPoh([], {});
        const first = await verifyHuman("W1", { pollAttempts: 2, pollDelayMs: 0 });
        expect(first).toMatchObject({ status: "pending", brainKey: "bk1" });

        mockPoh([{ status: "done", verdict: "HUMAN", confidence: 0.9 }]);
        const second = await verifyHuman("W1", { pollDelayMs: 0 });
        expect(second.verified).toBe(true);
        expect(calls.some((u) => u.endsWith("/checker"))).toBe(false);
    });

    it("an outage is recorded, never thrown", async () => {
        mockPoh([], { checkerStatus: 503 });
        expect(await verifyHuman("W1", { pollDelayMs: 0 })).toMatchObject({ status: "error", verified: false });
    });

    it("expired verifications no longer count", async () => {
        await db.collection("humanVerifications").doc("W1").set({
            wallet: "W1", status: "done", verdict: "HUMAN", confidence: 0.9, verified: true, checkedAt: Date.now() - VERIFICATION_TTL_MS - 1,
        });
        expect(await isOwnerHumanVerified("W1")).toBe(false);
    });
});
