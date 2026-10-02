/**
 * End-to-end ledger tests for lending-service against an in-memory Firestore
 * (see fake-firestore.ts). On-chain verification is mocked to "succeeded";
 * the signature claim still goes through the fake transaction so replay and
 * rollback behave like production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp, type FakeTxn } from "./fake-firestore";

const db = new FakeFirestore();
const verifyUsdcTransfer = vi.fn(async (input: { txSig: string; expectedAmountUsd: number }) => ({ txSig: input.txSig, receivedUsd: input.expectedAmountUsd }));
const verifySolTransfer = vi.fn(async (input: { txSig: string; expectedAmountUsd: number }) => ({ txSig: input.txSig, receivedUsd: input.expectedAmountUsd, lamports: 2_000_000_000 }));

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/solana/lending-verify", () => ({
    verifyUsdcTransfer: (input: { txSig: string; expectedAmountUsd: number }) => verifyUsdcTransfer(input),
    verifySolTransfer: (input: { txSig: string; expectedAmountUsd: number }) => verifySolTransfer(input),
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
    listPools,
    getPool,
    confirmPoolDeposit,
    requestPoolWithdrawal,
    cancelPoolWithdrawal,
    confirmPoolWithdrawal,
    requestLoan,
    postLoanCollateral,
    confirmLoanDisbursement,
    repayLoan,
    markLoanDefaulted,
    fundLoanSolo,
    cancelLoan,
    getLoan,
} from "../lending-service";
import { confirmPayout } from "../payouts";
import { reconcilePoolAccrual } from "../sweep";
import { poolValueUsd, poolSharePrice } from "../math";
import type { LendingPayout } from "../types";

const DAY = 86400;
let sig = 0;
const nextSig = () => `sig${++sig}`;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function payouts(kind?: string): LendingPayout[] {
    return (db.all("lendingPayouts") as unknown as LendingPayout[]).filter((p) => !kind || p.kind === kind);
}

async function seedPool(depositUsd: number): Promise<string> {
    const [pool] = await listPools();
    if (depositUsd > 0) await confirmPoolDeposit(pool.id, "LENDER1", depositUsd, nextSig());
    return pool.id;
}

async function poolTrustLoan(amountUsd: number) {
    const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amountUsd, requestedByWallet: "BORROWER" });
    await postLoanCollateral(loan.id, "BORROWER", nextSig());
    return confirmLoanDisbursement(loan.id, nextSig());
}

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

describe("pool deposits", () => {
    it("mints shares 1:1 into an empty pool and records the deposit", async () => {
        const poolId = await seedPool(1000);
        const pool = (await getPool(poolId))!;
        expect(pool.totalShares).toBe(1000);
        expect(pool.availableLiquidityUsd).toBe(1000);
        expect(db.all("lendingPoolDeposits")).toHaveLength(1);
    });

    it("rejects a replayed signature and leaves the ledger untouched", async () => {
        const [pool] = await listPools();
        await confirmPoolDeposit(pool.id, "LENDER1", 100, "dup");
        await expect(confirmPoolDeposit(pool.id, "LENDER1", 100, "dup")).rejects.toThrow();
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(100);
    });

    it("rolls the signature claim back when the credit fails", async () => {
        await expect(confirmPoolDeposit("no-such-pool", "LENDER1", 100, "orphan")).rejects.toThrow(/Pool not found/);
        expect(db.col("lendingOnChainTxs").has("orphan")).toBe(false);
    });

    it("credits up to the beta cap and queues a refund for the rest", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "300";
        const [pool] = await listPools();
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 500, nextSig());
        expect(res.creditedUsd).toBe(300);
        expect(res.refundedUsd).toBe(200);
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(300);
        expect(payouts("deposit_refund")).toMatchObject([{ fromWallet: "TREASURY", toWallet: "LENDER1", amountUsd: 200, status: "pending" }]);
    });

    it("credits a native SOL deposit in USD and records the lamports received", async () => {
        verifyUsdcTransfer.mockClear();
        const [pool] = await listPools();
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 300, nextSig(), "sol");
        expect(verifySolTransfer).toHaveBeenCalledWith(expect.objectContaining({ expectedAmountUsd: 300, expectedToWallet: "TREASURY" }));
        expect(verifyUsdcTransfer).not.toHaveBeenCalled();
        expect(res.creditedUsd).toBe(300);
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(300);
        expect(db.all("lendingPoolDeposits")).toMatchObject([{ amountUsd: 300, asset: "sol", lamports: 2_000_000_000 }]);
    });

    it("credits nothing and refunds everything while paused", async () => {
        process.env.LENDING_PAUSED = "true";
        const [pool] = await listPools();
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 250, nextSig());
        expect(res.creditedUsd).toBe(0);
        expect((await getPool(pool.id))!.totalShares).toBe(0);
        expect(payouts("deposit_refund")[0].amountUsd).toBe(250);
    });
});

describe("pool withdrawals", () => {
    it("reserves shares so a lender can't stack requests beyond their position", async () => {
        const poolId = await seedPool(1000);
        await requestPoolWithdrawal(poolId, "LENDER1", 800);
        await expect(requestPoolWithdrawal(poolId, "LENDER1", 800)).rejects.toThrow(/exceeds your withdrawable/);
    });

    it("cancel releases the reservation; confirm burns exactly the reserved shares", async () => {
        const poolId = await seedPool(1000);
        const r1 = await requestPoolWithdrawal(poolId, "LENDER1", 400);
        expect((await getPool(poolId))!.availableLiquidityUsd).toBe(600);
        await cancelPoolWithdrawal(r1.id);
        expect((await getPool(poolId))!.availableLiquidityUsd).toBe(1000);

        const r2 = await requestPoolWithdrawal(poolId, "LENDER1", 250);
        await confirmPoolWithdrawal(r2.id, nextSig());
        const pool = (await getPool(poolId))!;
        expect(pool.totalShares).toBeCloseTo(750, 9);
        expect(pool.availableLiquidityUsd).toBe(750);
        expect(pool.pendingWithdrawalShares).toBeCloseTo(0, 9);
        expect(pool.pendingWithdrawalUsd).toBeCloseTo(0, 9);
    });

    it("liquidity reserved for a withdrawal can't be lent out", async () => {
        const poolId = await seedPool(1000);
        await requestPoolWithdrawal(poolId, "LENDER1", 900);
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amountUsd: 500, requestedByWallet: "BORROWER" }),
        ).rejects.toThrow(/enough available liquidity/);
    });
});

describe("trust loan lifecycle (pool)", () => {
    it("requires collateral before disbursement", async () => {
        await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amountUsd: 400, requestedByWallet: "BORROWER" });
        expect(loan.status).toBe("pending_collateral");
        expect(loan.collateralUsd).toBe(200);
        await expect(confirmLoanDisbursement(loan.id, nextSig())).rejects.toThrow(/not awaiting disbursement/);

        const posted = await postLoanCollateral(loan.id, "BORROWER", nextSig());
        expect(posted.status).toBe("pending_disbursement");
        expect(posted.collateralStatus).toBe("held");
    });

    it("accrues interest into pool value and returns collateral on full repayment", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400); // 10% APR
        let pool = (await getPool(poolId))!;
        expect(pool.accruingUsdPerYear).toBeCloseTo(40, 9);

        vi.setSystemTime(T0 + 73 * DAY * 1000); // 73 days = 0.2 yr => $8 interest
        pool = (await getPool(poolId))!;
        expect(poolValueUsd(pool)).toBeCloseTo(1008, 6);

        const repaid = await repayLoan(loan.id, 408, "BORROWER", nextSig());
        expect(repaid.loan.status).toBe("repaid");
        pool = (await getPool(poolId))!;
        expect(pool.availableLiquidityUsd).toBeCloseTo(1008, 6);
        expect(pool.totalLentUsd).toBeCloseTo(0, 9);
        expect(pool.accruingUsdPerYear).toBeCloseTo(0, 9);
        expect(pool.interestReceivableUsd).toBeCloseTo(0, 6);
        expect(poolValueUsd(pool)).toBeCloseTo(1008, 6);
        expect(payouts("collateral_return")).toMatchObject([{ toWallet: "BORROWER", amountUsd: 200 }]);
        expect((await getLoan(loan.id))!.collateralStatus).toBe("return_pending");
    });

    it("share price doesn't jump at repayment (no free interest for late depositors)", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400);
        vi.setSystemTime(T0 + 73 * DAY * 1000);
        const before = poolSharePrice((await getPool(poolId))!);
        await repayLoan(loan.id, 408, "BORROWER", nextSig());
        const after = poolSharePrice((await getPool(poolId))!);
        expect(after).toBeCloseTo(before, 9);
    });

    it("queues and settles an overpayment refund", async () => {
        await seedPool(1000);
        const loan = await poolTrustLoan(400);
        const { repayment } = await repayLoan(loan.id, 450, "BORROWER", nextSig());
        expect(repayment.excessUsd).toBeCloseTo(50, 9);
        const refund = payouts("overpayment_refund")[0];
        expect(refund).toMatchObject({ fromWallet: "TREASURY", toWallet: "BORROWER", repaymentId: repayment.id });

        await confirmPayout(refund.id, nextSig());
        expect((await getLoan(loan.id))!.overpaymentOwedUsd).toBeCloseTo(0, 9);
        expect(db.col("loanRepayments").get(repayment.id)!.refundStatus).toBe("refunded");
    });

    it("refunds a repayment that arrives after the loan closed", async () => {
        await seedPool(1000);
        const loan = await poolTrustLoan(400);
        await repayLoan(loan.id, 400, "BORROWER", nextSig());
        await expect(repayLoan(loan.id, 25, "BORROWER", nextSig())).rejects.toThrow(/already closed/);
        expect(payouts("repayment_refund")).toMatchObject([{ toWallet: "BORROWER", amountUsd: 25 }]);
    });

    it("default applies collateral to principal and writes off only the remainder", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400); // collateral 200
        vi.setSystemTime(T0 + 40 * DAY * 1000); // past the 30d term
        await expect(markLoanDefaulted(loan.id, { graceDays: 30 })).rejects.toThrow(/grace/);
        await markLoanDefaulted(loan.id);

        const pool = (await getPool(poolId))!;
        expect(pool.totalDefaultedUsd).toBeCloseTo(200, 9);
        expect(pool.totalLentUsd).toBeCloseTo(0, 9);
        expect(pool.availableLiquidityUsd).toBeCloseTo(800, 9);
        expect(pool.accruingUsdPerYear).toBeCloseTo(0, 9);
        expect(pool.interestReceivableUsd).toBeCloseTo(0, 6);
        expect((await getLoan(loan.id))!.collateralStatus).toBe("seized");
        expect(payouts("collateral_return")).toHaveLength(0);
    });

    it("cancelling before disbursement releases liquidity and returns held collateral", async () => {
        const poolId = await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amountUsd: 400, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", nextSig());
        await expect(cancelLoan(loan.id, { byAdmin: false, reason: "x" })).rejects.toThrow(/only a platform admin/);
        await cancelLoan(loan.id, { byAdmin: true, reason: "stuck" });
        expect((await getPool(poolId))!.availableLiquidityUsd).toBe(1000);
        expect(payouts("collateral_return")[0].amountUsd).toBe(200);
    });

    it("collateral posted after cancellation is recorded and returned, not lost", async () => {
        await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amountUsd: 400, requestedByWallet: "BORROWER" });
        await cancelLoan(loan.id, { byAdmin: false, reason: "changed mind" });
        await expect(postLoanCollateral(loan.id, "BORROWER", "late-collateral")).rejects.toThrow(/no longer awaiting/);
        expect(db.col("lendingOnChainTxs").has("late-collateral")).toBe(true);
        expect(payouts("collateral_return")[0].amountUsd).toBe(200);
    });
});

describe("solo loans", () => {
    it("queues a borrower→lender refund for a duplicate funding", async () => {
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "solo", amountUsd: 300, requestedByWallet: "BORROWER" });
        await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        await expect(fundLoanSolo(loan.id, "LENDER_B", nextSig())).rejects.toThrow(/refund from the borrower has been queued/);
        expect(payouts("funding_refund")).toMatchObject([{ fromWallet: "BORROWER", toWallet: "LENDER_B", amountUsd: 300 }]);
        expect((await getLoan(loan.id))!.lenderWalletAddress).toBe("LENDER_A");
    });

    it("on default, seized collateral is owed to the solo lender and any excess back to the borrower", async () => {
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "solo", amountUsd: 300, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", nextSig()); // 150 held
        await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        await repayLoan(loan.id, 200, "BORROWER", nextSig()); // leaves ~100 principal
        vi.setSystemTime(T0 + 31 * DAY * 1000);
        await markLoanDefaulted(loan.id);
        const toLender = payouts("collateral_to_lender")[0];
        const excess = payouts("collateral_return")[0];
        expect(toLender.toWallet).toBe("LENDER_A");
        expect(excess.toWallet).toBe("BORROWER");
        expect(toLender.amountUsd + excess.amountUsd).toBeCloseTo(150, 6);
    });
});

describe("launch guards", () => {
    it("blocks new loans for non-allowlisted wallets and over the loan cap", async () => {
        await seedPool(1000);
        process.env.LENDING_ALLOWLIST = "SOMEONE_ELSE";
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amountUsd: 100, requestedByWallet: "BORROWER" }),
        ).rejects.toThrow(/allowlist/);
        delete process.env.LENDING_ALLOWLIST;
        process.env.LENDING_MAX_LOAN_USD = "100";
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amountUsd: 150, requestedByWallet: "BORROWER" }),
        ).rejects.toThrow(/capped/);
    });

    it("never blocks repayments, even while paused", async () => {
        await seedPool(1000);
        const loan = await poolTrustLoan(400);
        process.env.LENDING_PAUSED = "true";
        const { loan: after } = await repayLoan(loan.id, 400, "BORROWER", nextSig());
        expect(after.status).toBe("repaid");
    });
});

describe("reconcilePoolAccrual", () => {
    it("backfills a legacy loan disbursed before accrual tracking and marks it tracked", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400);
        // Simulate a pre-tracking pool/loan.
        db.col("loans").set(loan.id, { ...db.col("loans").get(loan.id)!, poolAccrualTracked: false });
        db.col("lendingPools").set(poolId, { ...db.col("lendingPools").get(poolId)!, accruingUsdPerYear: 0, interestReceivableUsd: 0 });

        vi.setSystemTime(T0 + 73 * DAY * 1000);
        const r = await reconcilePoolAccrual(poolId);
        expect(r.activeLoans).toBe(1);
        expect(r.accruingUsdPerYear).toBeCloseTo(40, 9);
        expect(r.interestReceivableUsd).toBeCloseTo(8, 6);
        expect((await getLoan(loan.id))!.poolAccrualTracked).toBe(true);
    });
});
