import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/firebase", () => ({ db: {} }));

const { derivedCapabilityIds, toResolvedCapability, AGENT_WALLET_CAPABILITY, CAPABILITY_REGISTRY, MOD_REGISTRY } =
    await import("../skills");

const chefReported = ["web-search", "code-interpreter", "shell", "repo-edit", "vault"].map((id) => ({ id }));

describe("derivedCapabilityIds", () => {
    it("gives chef agent-wallet plus the reported skills that exist in the registry", () => {
        expect(derivedCapabilityIds({ hasWallet: true, reportedSkills: chefReported })).toEqual([
            "agent-wallet",
            "web-search",
            "code-interpreter",
        ]);
    });

    it("drops agent-wallet when the agent has no wallet, and never takes it from a report", () => {
        expect(derivedCapabilityIds({ hasWallet: false, reportedSkills: [{ id: "agent-wallet" }] })).toEqual([]);
    });

    it("never unlocks a paid mod's capability from a report", () => {
        const paid = CAPABILITY_REGISTRY.find((c) => {
            const model = MOD_REGISTRY.find((m) => m.id === c.modId)?.pricing?.model;
            return model && model !== "free";
        });
        if (!paid) return;
        expect(derivedCapabilityIds({ hasWallet: false, reportedSkills: [{ id: paid.id }] })).toEqual([]);
    });

    it("resolves agent-wallet as a read-only skill with its own mod name", () => {
        expect(toResolvedCapability(AGENT_WALLET_CAPABILITY)).toMatchObject({
            key: "agent-wallet",
            name: "Agent Wallet",
            modId: "agent-wallet",
            modName: "Agent Wallet",
            type: "skill",
            permissionScopes: ["read"],
        });
    });
});
