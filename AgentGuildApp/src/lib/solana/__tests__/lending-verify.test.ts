import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/firebase-admin", () => ({ adminDb: vi.fn() }));

import { tokenBalanceDelta, usdcMintAddress, lendingCluster } from "../lending-verify";

const MINT = "MintAAA";
const bal = (owner: string, amount: string, mint = MINT) => ({ owner, mint, uiTokenAmount: { amount } });

describe("tokenBalanceDelta", () => {
    it("computes a simple received amount in USDC units", () => {
        expect(tokenBalanceDelta([bal("A", "0")], [bal("A", "2500000")], "A", MINT)).toBe(2.5);
    });

    it("sums across multiple token accounts owned by the same wallet", () => {
        const pre = [bal("A", "1000000"), bal("A", "5000000")];
        const post = [bal("A", "1000000"), bal("A", "2000000")];
        expect(tokenBalanceDelta(pre, post, "A", MINT)).toBe(-3);
    });

    it("ignores other owners and other mints", () => {
        const pre = [bal("A", "0"), bal("B", "9000000"), bal("A", "0", "OtherMint")];
        const post = [bal("A", "1000000"), bal("B", "0"), bal("A", "7000000", "OtherMint")];
        expect(tokenBalanceDelta(pre, post, "A", MINT)).toBe(1);
    });

    it("treats a newly created account (absent in pre) as starting from zero", () => {
        expect(tokenBalanceDelta([], [bal("A", "4000000")], "A", MINT)).toBe(4);
    });

    it("handles null/undefined balance arrays", () => {
        expect(tokenBalanceDelta(null, undefined, "A", MINT)).toBe(0);
    });
});

describe("mainnet configuration guard", () => {
    const env = { ...process.env };
    afterEach(() => {
        process.env = { ...env };
    });

    it("defaults to devnet with the devnet mint", () => {
        delete process.env.SOLANA_CLUSTER;
        delete process.env.SOLANA_USDC_MINT;
        expect(lendingCluster()).toBe("devnet");
        expect(usdcMintAddress()).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    });

    it("refuses mainnet without an explicit mint", () => {
        process.env.SOLANA_CLUSTER = "mainnet-beta";
        delete process.env.SOLANA_USDC_MINT;
        expect(() => usdcMintAddress()).toThrow(/SOLANA_USDC_MINT must be set/);
    });

    it("refuses mainnet with the devnet mint", () => {
        process.env.SOLANA_CLUSTER = "mainnet-beta";
        process.env.SOLANA_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        expect(() => usdcMintAddress()).toThrow(/devnet mint/);
    });

    it("rejects an unknown cluster name", () => {
        process.env.SOLANA_CLUSTER = "mainnet";
        expect(() => lendingCluster()).toThrow(/SOLANA_CLUSTER must be/);
    });
});
