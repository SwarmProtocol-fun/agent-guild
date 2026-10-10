// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp } from "../lending/__tests__/fake-firestore";

let db: FakeFirestore;
let verifyResult: Error | null = null;

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/solana/lending-verify", () => ({
    treasuryAddress: () => "TREASURY",
    verifyUsdcTransfer: async (input: { txSig: string }) => {
        if (verifyResult) throw verifyResult;
        return { txSig: input.txSig, received: 25 };
    },
    claimUsdcTransferInTxn: (txn: { create: (r: unknown, d: unknown) => void }, input: { txSig: string }) =>
        txn.create(db.collection("lendingOnChainTxs").doc(input.txSig), { claimed: true }),
}));

const { postBond, slashBond, requestBondRefund, bondRefundBlocker, BOND_MIN_HOLD_DAYS } = await import("@/lib/agent-bond");
const { evaluateStanding } = await import("@/lib/agent-standing");

const DAY = 86_400_000;
const agent = () => db.col("agents").get("a1")!;

beforeEach(async () => {
    db = new FakeFirestore();
    verifyResult = null;
    await db.collection("agents").doc("a1").set({ orgId: "org1", name: "bot", asn: "ASN-1", provisional: true });
});

describe("postBond", () => {
    it("records a verified bond and claims the signature", async () => {
        const bond = await postBond("a1", { txSig: "sig1", fromWallet: "W" });
        expect(bond).toMatchObject({ status: "posted", amountUsd: 25, postedByWallet: "W" });
        expect(agent().bond).toMatchObject({ status: "posted" });
        expect(db.col("lendingOnChainTxs").has("sig1")).toBe(true);
    });

    it("refuses a second bond while one is posted", async () => {
        await postBond("a1", { txSig: "sig1", fromWallet: "W" });
        await expect(postBond("a1", { txSig: "sig2", fromWallet: "W" })).rejects.toThrow("already has a bond");
    });

    it("records nothing when on-chain verification fails", async () => {
        verifyResult = new Error("Transaction not found");
        await expect(postBond("a1", { txSig: "bad", fromWallet: "W" })).rejects.toThrow("not found");
        expect(agent().bond).toBeUndefined();
    });
});

describe("slashBond", () => {
    it("forfeits a posted bond — and the agent drops back to provisional", async () => {
        await db.collection("agents").doc("a1").update({
            provisionalSince: Date.now() - 30 * DAY, tasksCompleted: 9, riskFlags: [],
        });
        await postBond("a1", { txSig: "sig1", fromWallet: "W" });
        expect(evaluateStanding(agent()).provisional).toBe(false);

        expect(await slashBond("a1", "Defaulted on unsecured loan")).toBe(true);
        expect(agent().bond).toMatchObject({ status: "slashed", slashReason: "Defaulted on unsecured loan" });
        expect(evaluateStanding(agent()).provisional).toBe(true);
    });

    it("is a no-op without a bond, and never throws", async () => {
        expect(await slashBond("a1", "x")).toBe(false);
        expect(await slashBond("missing", "x")).toBe(false);
    });

    it("a slashed agent can post a fresh bond", async () => {
        await postBond("a1", { txSig: "sig1", fromWallet: "W" });
        await slashBond("a1", "fraud");
        await expect(postBond("a1", { txSig: "sig2", fromWallet: "W" })).resolves.toMatchObject({ status: "posted" });
    });
});

describe("refund", () => {
    const posted = (daysAgo: number) => ({ status: "posted" as const, amountUsd: 25, postedByWallet: "W", txSig: "s", postedAt: Date.now() - daysAgo * DAY });

    it("blocks refunds while the bond is young, loans are open, or risk is flagged", () => {
        expect(bondRefundBlocker({ bond: posted(1) }, 0)).toMatch(`${BOND_MIN_HOLD_DAYS} days`);
        expect(bondRefundBlocker({ bond: posted(40) }, 1)).toMatch("open loans");
        expect(bondRefundBlocker({ bond: posted(40), riskFlags: ["wash_trading"] }, 0)).toMatch("risk flags");
        expect(bondRefundBlocker({ bond: { ...posted(40), status: "slashed" } }, 0)).toMatch("slashed");
        expect(bondRefundBlocker({ bond: posted(40) }, 0)).toBeNull();
    });

    it("retires the agent and queues the bond back to the poster", async () => {
        await db.collection("agents").doc("a1").update({ bond: posted(40) });
        const { payoutId } = await requestBondRefund("a1");
        expect(agent()).toMatchObject({ status: "offline", bond: { status: "refund_pending", refundPayoutId: payoutId } });
        expect(agent().retiredAt).toBeTypeOf("number");
        expect(db.col("lendingPayouts").get(payoutId!)).toMatchObject({
            kind: "bond_refund", fromWallet: "TREASURY", toWallet: "W", amount: 25, agentId: "a1", status: "pending",
        });
    });

    it("won't refund while a loan is open", async () => {
        await db.collection("agents").doc("a1").update({ bond: posted(40) });
        await db.collection("loans").doc("l1").set({ borrowerAgentId: "a1", status: "active" });
        await expect(requestBondRefund("a1")).rejects.toThrow("open loans");
        expect(agent().retiredAt).toBeUndefined();
    });
});
