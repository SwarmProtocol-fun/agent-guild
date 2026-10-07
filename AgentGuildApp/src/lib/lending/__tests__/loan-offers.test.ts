/**
 * Lender-posted loan offers against the in-memory Firestore: post → accept →
 * reserved funding → repay, plus the guards that keep an offer from being
 * double-accepted, hijacked by another lender, or stuck after a failed accept.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp, type FakeTxn } from "./fake-firestore";

const db = new FakeFirestore();
const verifyUsdcTransfer = vi.fn(async (input: { txSig: string; expectedAmount: number }) => ({ txSig: input.txSig, received: input.expectedAmount }));
const verifySolTransfer = vi.fn(async (input: { txSig: string; expectedAmount: number }) => ({ txSig: input.txSig, received: input.expectedAmount, lamports: 2_000_000_000 }));

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/solana/lending-verify", () => ({
    verifyUsdcTransfer: (input: { txSig: string; expectedAmount: number }) => verifyUsdcTransfer(input),
    verifySolTransfer: (input: { txSig: string; expectedAmount: number }) => verifySolTransfer(input),
    claimUsdcTransferInTxn: (txn: FakeTxn, input: { txSig: string; purpose: string }) =>
        txn.create(db.collection("lendingOnChainTxs").doc(input.txSig), { purpose: input.purpose }),
    treasuryAddress: () => "TREASURY",
}));
vi.mock("@/lib/agent-policy", () => ({
    resolveAgentPolicy: async () => ({ ok: true, policy: { name: "standard", escrowRatio: 0.5 } }),
}));
vi.mock("@/lib/credit-policy", () => ({
    calculateRequiredEscrow: (_policy: unknown, amount: number) => ({ escrowAmount: amount * 0.5, escrowRatio: 0.5 }),
}));
vi.mock("@/lib/credit-audit-log", () => ({ recordCreditAudit: async () => undefined }));
vi.mock("@/lib/credit-cache", () => ({ invalidateCache: () => undefined }));
vi.mock("@/lib/credit-events/ingest", () => ({ ingestCreditEvent: async () => undefined }));
vi.mock("@/lib/scoring-engine", () => ({ recomputeAndSync: async () => undefined }));
vi.mock("../eligibility", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../eligibility")>();
    const gate = { eligible: true, maxAmountUsd: 10_000, rateBps: 1000 };
    return {
        ...orig,
        evaluateEligibility: (input: { activeLoanCount: number }) => ({
            policyTier: "standard",
            creditScore: 700,
            completedTrustLoans: 0,
            completedUnsecuredLoans: 0,
            trustLoansRequiredForUnsecured: 0,
            activeLoanCount: input.activeLoanCount,
            hasUnresolvedDefault: false,
            trust: gate,
            unsecured: gate,
        }),
    };
});

import {
    createLoanOffer,
    withdrawLoanOffer,
    acceptLoanOffer,
    getLoanOffer,
    listOpenLoanOffers,
    listLoanOffersForWallet,
    fundLoanSolo,
    postLoanCollateral,
    repayLoan,
    getLoan,
} from "../lending-service";
import type { LendingPayout } from "../types";

let sig = 0;
const nextSig = () => `sig${++sig}`;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function payouts(kind?: string): LendingPayout[] {
    return (db.all("lendingPayouts") as unknown as LendingPayout[]).filter((p) => !kind || p.kind === kind);
}

const offerInput = { lenderWalletAddress: "LENDER_A", kind: "unsecured" as const, amount: 500, rateBps: 1200, termDays: 45 };
const accept = (offerId: string, amount?: number) =>
    acceptLoanOffer({ offerId, agentId: "agent1", orgId: "org1", amount, requestedByWallet: "BORROWER" });

beforeEach(() => {
    db.store.clear();
    verifyUsdcTransfer.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    for (const k of ["LENDING_PAUSED", "LENDING_ALLOWLIST", "LENDING_MAX_POOL_TVL_USD", "LENDING_MAX_DEPOSIT_PER_WALLET_USD", "LENDING_MAX_LOAN_USD"]) delete process.env[k];
    db.col("agents").set("agent1", { walletAddress: "BORROWER", creditScore: 700, trustScore: 50, orgId: "org1", asn: "asn1" });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("posting offers", () => {
    it("stores an open offer with rounded amount and clamped term", async () => {
        const offer = await createLoanOffer({ ...offerInput, amount: 500.456, termDays: 400 });
        expect(offer).toMatchObject({ status: "open", amount: 500.46, rateBps: 1200, termDays: 90 });
        expect(await getLoanOffer(offer.id)).toMatchObject({ id: offer.id, status: "open" });
    });

    it("rejects amounts under the minimum and rates outside 1%–100% APR", async () => {
        await expect(createLoanOffer({ ...offerInput, amount: 10 })).rejects.toThrow(/at least/);
        await expect(createLoanOffer({ ...offerInput, rateBps: 50 })).rejects.toThrow(/Rate must be/);
        await expect(createLoanOffer({ ...offerInput, rateBps: 20_000 })).rejects.toThrow(/Rate must be/);
        await expect(createLoanOffer({ ...offerInput, rateBps: Number.NaN })).rejects.toThrow(/Rate must be/);
        expect(db.all("loanOffers")).toHaveLength(0);
    });

    it("applies the beta guards (pause, allowlist, loan cap) to lenders", async () => {
        process.env.LENDING_MAX_LOAN_USD = "100";
        await expect(createLoanOffer(offerInput)).rejects.toThrow(/capped/);
        delete process.env.LENDING_MAX_LOAN_USD;
        process.env.LENDING_ALLOWLIST = "SOMEONE_ELSE";
        await expect(createLoanOffer(offerInput)).rejects.toThrow(/allowlist/);
        delete process.env.LENDING_ALLOWLIST;
        process.env.LENDING_PAUSED = "true";
        await expect(createLoanOffer(offerInput)).rejects.toThrow();
    });
});

describe("withdrawing offers", () => {
    it("only the posting lender can withdraw, and only while open", async () => {
        const offer = await createLoanOffer(offerInput);
        await expect(withdrawLoanOffer(offer.id, "LENDER_B")).rejects.toThrow(/Only the lender/);
        expect((await withdrawLoanOffer(offer.id, "LENDER_A")).status).toBe("withdrawn");
        await expect(withdrawLoanOffer(offer.id, "LENDER_A")).rejects.toThrow(/not open/);
        await expect(accept(offer.id)).rejects.toThrow(/not open/);
    });

    it("withdrawn offers drop out of the marketplace but stay in the lender's history", async () => {
        const keep = await createLoanOffer(offerInput);
        vi.setSystemTime(T0 + 1000);
        const gone = await createLoanOffer(offerInput);
        await withdrawLoanOffer(gone.id, "LENDER_A");
        expect((await listOpenLoanOffers()).map((o) => o.id)).toEqual([keep.id]);
        expect((await listLoanOffersForWallet("LENDER_A")).map((o) => o.id)).toEqual([gone.id, keep.id]);
    });

    it("a lender can't withdraw an offer someone already accepted", async () => {
        const offer = await createLoanOffer(offerInput);
        await accept(offer.id);
        await expect(withdrawLoanOffer(offer.id, "LENDER_A")).rejects.toThrow(/not open/);
    });
});

describe("accepting offers", () => {
    it("creates a pending solo loan on the offer's terms, reserved for its lender", async () => {
        const offer = await createLoanOffer(offerInput);
        const loan = await accept(offer.id);
        expect(loan).toMatchObject({
            source: "solo",
            kind: "unsecured",
            status: "pending",
            principal: 500,
            interestRateBps: 1200,
            termDays: 45,
            offerId: offer.id,
            reservedLenderWallet: "LENDER_A",
        });
        expect(await getLoanOffer(offer.id)).toMatchObject({ status: "fulfilled", acceptedLoanId: loan.id });
    });

    it("accepts a smaller amount than offered", async () => {
        const offer = await createLoanOffer(offerInput);
        expect((await accept(offer.id, 200)).principal).toBe(200);
    });

    it("can't be accepted twice", async () => {
        const offer = await createLoanOffer(offerInput);
        await accept(offer.id);
        await expect(accept(offer.id)).rejects.toThrow(/not open/);
        expect(db.all("loans")).toHaveLength(1);
    });

    it("reopens the offer when the requested amount exceeds it", async () => {
        const offer = await createLoanOffer(offerInput);
        await expect(accept(offer.id, 600)).rejects.toThrow(/exceeds the offer/);
        expect((await getLoanOffer(offer.id))!.status).toBe("open");
        expect(db.all("loans")).toHaveLength(0);
    });

    it("reopens the offer when the borrower fails the eligibility gate", async () => {
        // Tier rate is 10% → solo band 5%–20%; a 30% offer is out of band for this agent.
        const offer = await createLoanOffer({ ...offerInput, rateBps: 3000 });
        await expect(accept(offer.id)).rejects.toThrow(/Rate must be between 5.0% and 20.0%/);
        expect((await getLoanOffer(offer.id))!.status).toBe("open");
        expect(db.all("loans")).toHaveLength(0);
    });

    it("rejects an unknown offer", async () => {
        await expect(accept("nope")).rejects.toThrow(/not found/);
    });
});

describe("offer-backed loan lifecycle", () => {
    it("only the offering lender can fund; anyone else's transfer is refunded", async () => {
        const offer = await createLoanOffer(offerInput);
        const loan = await accept(offer.id);
        await expect(fundLoanSolo(loan.id, "LENDER_B", nextSig())).rejects.toThrow(/reserved for a different lender/);
        expect(payouts("funding_refund")).toMatchObject([{ fromWallet: "BORROWER", toWallet: "LENDER_B", amount: 500 }]);
        expect((await getLoan(loan.id))!.status).toBe("pending");

        const funded = await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        expect(funded).toMatchObject({ status: "active", lenderWalletAddress: "LENDER_A" });
        expect(verifyUsdcTransfer).toHaveBeenLastCalledWith(
            expect.objectContaining({ expectedFromWallet: "LENDER_A", expectedToWallet: "BORROWER", expectedAmount: 500 }),
        );
    });

    it("runs offer → accept → fund → repay at the offer's rate", async () => {
        const offer = await createLoanOffer(offerInput);
        const loan = await accept(offer.id);
        await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        vi.setSystemTime(T0 + 45 * 86400 * 1000);
        const owed = 500 + 500 * 0.12 * (45 / 365);
        const { loan: after } = await repayLoan(loan.id, Math.ceil(owed * 100) / 100, "BORROWER", nextSig());
        expect(after.status).toBe("repaid");
        expect(after.interestPaid).toBeCloseTo(500 * 0.12 * (45 / 365), 2);
        expect(verifyUsdcTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: "BORROWER", expectedToWallet: "LENDER_A" }));
    });

    it("a trust offer needs collateral before the lender can fund it", async () => {
        const offer = await createLoanOffer({ ...offerInput, kind: "trust" });
        const loan = await accept(offer.id, 300);
        expect(loan).toMatchObject({ status: "pending_collateral", collateral: 150, reservedLenderWallet: "LENDER_A" });
        await postLoanCollateral(loan.id, "BORROWER", nextSig());
        expect((await getLoan(loan.id))!.status).toBe("pending");
        expect((await fundLoanSolo(loan.id, "LENDER_A", nextSig())).status).toBe("active");
    });
});
