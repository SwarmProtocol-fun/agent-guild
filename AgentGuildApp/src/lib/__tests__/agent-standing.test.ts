import { describe, it, expect, afterEach } from "vitest";
import { evaluateStanding, checkOwnerQuota, toMillis, PROVISIONAL_MIN_DAYS, type AgentBond } from "@/lib/agent-standing";
import { resolveAgentPolicy, type PolicyLoaders } from "@/lib/agent-policy";
import type { Agent } from "@/lib/firestore";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const bond = (extra: Partial<AgentBond> = {}): AgentBond => ({
    status: "posted", amountUsd: 25, postedByWallet: "w", txSig: "s", postedAt: NOW - 40 * DAY, ...extra,
});
const graduated = {
    provisional: true,
    provisionalSince: NOW - (PROVISIONAL_MIN_DAYS + 1) * DAY,
    tasksCompleted: 3,
    riskFlags: [],
    bond: bond(),
};

afterEach(() => { delete process.env.NEXT_PUBLIC_AGENT_BOND_USD; });

describe("evaluateStanding", () => {
    it("never makes a pre-existing (unflagged) agent provisional", () => {
        expect(evaluateStanding({ creditScore: 300 } as never, NOW)).toMatchObject({ provisional: false, grandfathered: true });
    });

    it("a brand-new identity is provisional with every requirement listed", () => {
        const s = evaluateStanding({ provisional: true, provisionalSince: NOW }, NOW);
        expect(s.provisional).toBe(true);
        expect(s.requirements.map((r) => [r.key, r.met])).toEqual([
            ["tenure", false], ["tasks", false], ["risk", true], ["bond", false],
        ]);
    });

    it("clears once tenure, work, clean record and bond are all in place", () => {
        expect(evaluateStanding(graduated, NOW).provisional).toBe(false);
    });

    it.each([
        ["too young", { provisionalSince: NOW - 2 * DAY }],
        ["too few tasks", { tasksCompleted: 2 }],
        ["open risk flag", { riskFlags: ["sybil_suspicion"] }],
        ["no bond", { bond: null }],
        ["slashed bond", { bond: bond({ status: "slashed", slashReason: "default" }) }],
        ["underfunded bond", { bond: bond({ amountUsd: 10 }) }],
    ])("falls back to provisional: %s", (_label, patch) => {
        expect(evaluateStanding({ ...graduated, ...patch }, NOW).provisional).toBe(true);
    });

    it("reads Firestore Timestamps and epoch seconds", () => {
        expect(toMillis({ toMillis: () => 5 })).toBe(5);
        expect(toMillis({ seconds: 2 })).toBe(2000);
        expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000);
        expect(evaluateStanding({ ...graduated, provisionalSince: { seconds: (NOW - 20 * DAY) / 1000 } }, NOW).provisional).toBe(false);
    });

    it("NEXT_PUBLIC_AGENT_BOND_USD=0 drops the bond requirement", () => {
        process.env.NEXT_PUBLIC_AGENT_BOND_USD = "0";
        const s = evaluateStanding({ ...graduated, bond: null }, NOW);
        expect(s.requirements.some((r) => r.key === "bond")).toBe(false);
        expect(s.provisional).toBe(false);
    });
});

describe("checkOwnerQuota", () => {
    const old = { keyBoundAt: NOW - 10 * DAY };
    it("unverified owners get 3 active agents", () => {
        expect(checkOwnerQuota([old, old], false, NOW).ok).toBe(true);
        expect(checkOwnerQuota([old, old, old], false, NOW)).toMatchObject({ ok: false, code: "OWNER_AGENT_LIMIT" });
    });
    it("retired agents don't count", () => {
        expect(checkOwnerQuota([old, old, { ...old, retiredAt: NOW }], false, NOW).ok).toBe(true);
    });
    it("caps registrations per 24h", () => {
        const fresh = { keyBoundAt: NOW - 3600_000 };
        expect(checkOwnerQuota([fresh, fresh], false, NOW)).toMatchObject({ ok: false, code: "OWNER_DAILY_LIMIT" });
    });
    it("proof-of-human raises the limits", () => {
        expect(checkOwnerQuota([old, old, old, old], true, NOW).ok).toBe(true);
    });
});

describe("resolveAgentPolicy — provisional cap", () => {
    const loaders = (agent: Partial<Agent>, orgOverride: unknown = null): PolicyLoaders => ({
        getAgent: async () => ({ id: "a1", orgId: "o1", ...agent }) as Agent,
        getCreditPolicyConfig: async () => ({ enforcementEnabled: true }) as never,
        getOrgPolicyOverride: async () => orgOverride as never,
    });

    it("caps a high-scoring provisional agent at Restricted", async () => {
        const r = await resolveAgentPolicy("a1", loaders({ creditScore: 880, provisional: true, provisionalSince: Date.now() }));
        expect(r.tier).toBe("restricted");
        expect(r.adjustments?.some((a) => a.includes("provisional"))).toBe(true);
    });

    it("an org minTier override can't lift a provisional agent", async () => {
        const r = await resolveAgentPolicy("a1", loaders(
            { creditScore: 700, provisional: true, provisionalSince: Date.now() },
            { orgId: "o1", minTier: "trusted" },
        ));
        expect(r.tier).toBe("restricted");
    });

    it("leaves grandfathered agents alone", async () => {
        const r = await resolveAgentPolicy("a1", loaders({ creditScore: 680, verificationLevel: "verified" } as never));
        expect(r.tier).toBe("standard");
    });

    it("doesn't raise an agent that's already below the cap", async () => {
        const r = await resolveAgentPolicy("a1", loaders({ creditScore: 320, provisional: true, provisionalSince: Date.now() }));
        expect(r.tier).toBe("high_risk");
    });
});
