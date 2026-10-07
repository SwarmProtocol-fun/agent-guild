/**
 * End-to-end ledger tests for lending-service against an in-memory Firestore
 * (see fake-firestore.ts). On-chain verification is mocked to "succeeded";
 * the signature claim still goes through the fake transaction so replay and
 * rollback behave like production.
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
    createLoanOffer,
    acceptLoanOffer,
} from "../lending-service";
import { confirmPayout } from "../payouts";
import { reconcilePoolAccrual } from "../sweep";
import { poolValue, poolSharePrice } from "../math";
import type { LendingPayout } from "../types";

const DAY = 86400;
let sig = 0;
const nextSig = () => `sig${++sig}`;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

function payouts(kind?: string): LendingPayout[] {
    return (db.all("lendingPayouts") as unknown as LendingPayout[]).filter((p) => !kind || p.kind === kind);
}

async function seedPool(depositAmount: number): Promise<string> {
    const [pool] = await listPools();
    if (depositAmount > 0) await confirmPoolDeposit(pool.id, "LENDER1", depositAmount, nextSig());
    return pool.id;
}

async function poolTrustLoan(amount: number) {
    const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amount, requestedByWallet: "BORROWER" });
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
        expect(pool.availableLiquidity).toBe(1000);
        expect(db.all("lendingPoolDeposits")).toHaveLength(1);
    });

    it("rejects a replayed signature and leaves the ledger untouched", async () => {
        const [pool] = await listPools();
        await confirmPoolDeposit(pool.id, "LENDER1", 100, "dup");
        await expect(confirmPoolDeposit(pool.id, "LENDER1", 100, "dup")).rejects.toThrow();
        expect((await getPool(pool.id))!.availableLiquidity).toBe(100);
    });

    it("rolls the signature claim back when the credit fails", async () => {
        await expect(confirmPoolDeposit("no-such-pool", "LENDER1", 100, "orphan")).rejects.toThrow(/Pool not found/);
        expect(db.col("lendingOnChainTxs").has("orphan")).toBe(false);
    });

    it("credits up to the beta cap and queues a refund for the rest", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "300";
        const [pool] = await listPools();
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 500, nextSig());
        expect(res.credited).toBe(300);
        expect(res.refunded).toBe(200);
        expect((await getPool(pool.id))!.availableLiquidity).toBe(300);
        expect(payouts("deposit_refund")).toMatchObject([{ fromWallet: "TREASURY", toWallet: "LENDER1", amount: 200, status: "pending" }]);
    });

    it("credits nothing and refunds everything while paused", async () => {
        process.env.LENDING_PAUSED = "true";
        const [pool] = await listPools();
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 250, nextSig());
        expect(res.credited).toBe(0);
        expect((await getPool(pool.id))!.totalShares).toBe(0);
        expect(payouts("deposit_refund")[0].amount).toBe(250);
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
        expect((await getPool(poolId))!.availableLiquidity).toBe(600);
        await cancelPoolWithdrawal(r1.id);
        expect((await getPool(poolId))!.availableLiquidity).toBe(1000);

        const r2 = await requestPoolWithdrawal(poolId, "LENDER1", 250);
        await confirmPoolWithdrawal(r2.id, nextSig());
        const pool = (await getPool(poolId))!;
        expect(pool.totalShares).toBeCloseTo(750, 9);
        expect(pool.availableLiquidity).toBe(750);
        expect(pool.pendingWithdrawalShares).toBeCloseTo(0, 9);
        expect(pool.pendingWithdrawal).toBeCloseTo(0, 9);
    });

    it("liquidity reserved for a withdrawal can't be lent out", async () => {
        const poolId = await seedPool(1000);
        await requestPoolWithdrawal(poolId, "LENDER1", 900);
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amount: 500, requestedByWallet: "BORROWER" }),
        ).rejects.toThrow(/enough available liquidity/);
    });
});

describe("trust loan lifecycle (pool)", () => {
    it("requires collateral before disbursement", async () => {
        await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amount: 400, requestedByWallet: "BORROWER" });
        expect(loan.status).toBe("pending_collateral");
        expect(loan.collateral).toBe(200);
        await expect(confirmLoanDisbursement(loan.id, nextSig())).rejects.toThrow(/not awaiting disbursement/);

        const posted = await postLoanCollateral(loan.id, "BORROWER", nextSig());
        expect(posted.status).toBe("pending_disbursement");
        expect(posted.collateralStatus).toBe("held");
    });

    it("accrues interest into pool value and returns collateral on full repayment", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400); // 10% APR
        let pool = (await getPool(poolId))!;
        expect(pool.accruingPerYear).toBeCloseTo(40, 9);

        vi.setSystemTime(T0 + 73 * DAY * 1000); // 73 days = 0.2 yr => $8 interest
        pool = (await getPool(poolId))!;
        expect(poolValue(pool)).toBeCloseTo(1008, 6);

        const repaid = await repayLoan(loan.id, 408, "BORROWER", nextSig());
        expect(repaid.loan.status).toBe("repaid");
        pool = (await getPool(poolId))!;
        expect(pool.availableLiquidity).toBeCloseTo(1008, 6);
        expect(pool.totalLent).toBeCloseTo(0, 9);
        expect(pool.accruingPerYear).toBeCloseTo(0, 9);
        expect(pool.interestReceivable).toBeCloseTo(0, 6);
        expect(poolValue(pool)).toBeCloseTo(1008, 6);
        expect(payouts("collateral_return")).toMatchObject([{ toWallet: "BORROWER", amount: 200 }]);
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
        expect(repayment.excess).toBeCloseTo(50, 9);
        const refund = payouts("overpayment_refund")[0];
        expect(refund).toMatchObject({ fromWallet: "TREASURY", toWallet: "BORROWER", repaymentId: repayment.id });

        await confirmPayout(refund.id, nextSig());
        expect((await getLoan(loan.id))!.overpaymentOwed).toBeCloseTo(0, 9);
        expect(db.col("loanRepayments").get(repayment.id)!.refundStatus).toBe("refunded");
    });

    it("refunds a repayment that arrives after the loan closed", async () => {
        await seedPool(1000);
        const loan = await poolTrustLoan(400);
        await repayLoan(loan.id, 400, "BORROWER", nextSig());
        await expect(repayLoan(loan.id, 25, "BORROWER", nextSig())).rejects.toThrow(/already closed/);
        expect(payouts("repayment_refund")).toMatchObject([{ toWallet: "BORROWER", amount: 25 }]);
    });

    it("default applies collateral to principal and writes off only the remainder", async () => {
        const poolId = await seedPool(1000);
        const loan = await poolTrustLoan(400); // collateral 200
        vi.setSystemTime(T0 + 40 * DAY * 1000); // past the 30d term
        await expect(markLoanDefaulted(loan.id, { graceDays: 30 })).rejects.toThrow(/grace/);
        await markLoanDefaulted(loan.id);

        const pool = (await getPool(poolId))!;
        expect(pool.totalDefaulted).toBeCloseTo(200, 9);
        expect(pool.totalLent).toBeCloseTo(0, 9);
        expect(pool.availableLiquidity).toBeCloseTo(800, 9);
        expect(pool.accruingPerYear).toBeCloseTo(0, 9);
        expect(pool.interestReceivable).toBeCloseTo(0, 6);
        expect((await getLoan(loan.id))!.collateralStatus).toBe("seized");
        expect(payouts("collateral_return")).toHaveLength(0);
    });

    it("cancelling before disbursement releases liquidity and returns held collateral", async () => {
        const poolId = await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amount: 400, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", nextSig());
        await expect(cancelLoan(loan.id, { byAdmin: false, reason: "x" })).rejects.toThrow(/only a platform admin/);
        await cancelLoan(loan.id, { byAdmin: true, reason: "stuck" });
        expect((await getPool(poolId))!.availableLiquidity).toBe(1000);
        expect(payouts("collateral_return")[0].amount).toBe(200);
    });

    it("collateral posted after cancellation is recorded and returned, not lost", async () => {
        await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amount: 400, requestedByWallet: "BORROWER" });
        await cancelLoan(loan.id, { byAdmin: false, reason: "changed mind" });
        await expect(postLoanCollateral(loan.id, "BORROWER", "late-collateral")).rejects.toThrow(/no longer awaiting/);
        expect(db.col("lendingOnChainTxs").has("late-collateral")).toBe(true);
        expect(payouts("collateral_return")[0].amount).toBe(200);
    });
});

describe("solo loans", () => {
    it("queues a borrower→lender refund for a duplicate funding", async () => {
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "solo", amount: 300, requestedByWallet: "BORROWER" });
        await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        await expect(fundLoanSolo(loan.id, "LENDER_B", nextSig())).rejects.toThrow(/refund from the borrower has been queued/);
        expect(payouts("funding_refund")).toMatchObject([{ fromWallet: "BORROWER", toWallet: "LENDER_B", amount: 300 }]);
        expect((await getLoan(loan.id))!.lenderWalletAddress).toBe("LENDER_A");
    });

    it("on default, seized collateral is owed to the solo lender and any excess back to the borrower", async () => {
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "solo", amount: 300, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", nextSig()); // 150 held
        await fundLoanSolo(loan.id, "LENDER_A", nextSig());
        await repayLoan(loan.id, 200, "BORROWER", nextSig()); // leaves ~100 principal
        vi.setSystemTime(T0 + 31 * DAY * 1000);
        await markLoanDefaulted(loan.id);
        const toLender = payouts("collateral_to_lender")[0];
        const excess = payouts("collateral_return")[0];
        expect(toLender.toWallet).toBe("LENDER_A");
        expect(excess.toWallet).toBe("BORROWER");
        expect(toLender.amount + excess.amount).toBeCloseTo(150, 6);
    });
});

describe("launch guards", () => {
    it("blocks new loans for non-allowlisted wallets and over the loan cap", async () => {
        await seedPool(1000);
        process.env.LENDING_ALLOWLIST = "SOMEONE_ELSE";
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amount: 100, requestedByWallet: "BORROWER" }),
        ).rejects.toThrow(/allowlist/);
        delete process.env.LENDING_ALLOWLIST;
        process.env.LENDING_MAX_LOAN_USD = "100";
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amount: 150, requestedByWallet: "BORROWER" }),
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
        db.col("lendingPools").set(poolId, { ...db.col("lendingPools").get(poolId)!, accruingPerYear: 0, interestReceivable: 0 });

        vi.setSystemTime(T0 + 73 * DAY * 1000);
        const r = await reconcilePoolAccrual(poolId);
        expect(r.activeLoans).toBe(1);
        expect(r.accruingPerYear).toBeCloseTo(40, 9);
        expect(r.interestReceivable).toBeCloseTo(8, 6);
        expect((await getLoan(loan.id))!.poolAccrualTracked).toBe(true);
    });
});

describe("EVM-login accounts use their linked Solana wallet on-chain", () => {
    const EVM = "0xf35c7725406e572a5f9e743a4f75b1d81d2f3d5a";
    const SOL = "So11111111111111111111111111111111111111112";
    const link = () => db.col("solanaWalletLinks").set(EVM, { solanaAddress: SOL });
    const lastTransfer = () => verifyUsdcTransfer.mock.lastCall![0] as unknown as { expectedFromWallet: string; expectedToWallet: string };

    it("withdrawals stay keyed to the account but pay the linked wallet", async () => {
        link();
        const [pool] = await listPools();
        await confirmPoolDeposit(pool.id, EVM, 500, nextSig());
        const req = await requestPoolWithdrawal(pool.id, EVM, 200);
        expect(req).toMatchObject({ walletAddress: EVM, payoutWalletAddress: SOL });
        await confirmPoolWithdrawal(req.id, nextSig());
        expect(lastTransfer()).toMatchObject({ expectedFromWallet: "TREASURY", expectedToWallet: SOL });
    });

    it("an unlinked EVM account can't request a withdrawal it could never be paid for", async () => {
        link();
        const [pool] = await listPools();
        await confirmPoolDeposit(pool.id, EVM, 500, nextSig());
        db.col("solanaWalletLinks").set(EVM, {});
        await expect(requestPoolWithdrawal(pool.id, EVM, 200)).rejects.toThrow(/Link a Solana wallet/);
    });

    it("offers from an EVM lender: must be linked to post, then fundable from the linked wallet", async () => {
        await expect(createLoanOffer({ lenderWalletAddress: EVM, kind: "unsecured", amount: 300, rateBps: 1000 })).rejects.toThrow(/Link a Solana wallet/);
        link();
        const offer = await createLoanOffer({ lenderWalletAddress: EVM, kind: "unsecured", amount: 300, rateBps: 1000 });
        const loan = await acceptLoanOffer({ offerId: offer.id, agentId: "agent1", orgId: "org1", requestedByWallet: "BORROWER" });
        const funded = await fundLoanSolo(loan.id, EVM, nextSig());
        expect(lastTransfer()).toMatchObject({ expectedFromWallet: SOL, expectedToWallet: "BORROWER" });
        // Repayments go to the wallet that actually sent the money.
        expect(funded.lenderWalletAddress).toBe(SOL);
    });

    it("an offer reserved under an EVM account is still fundable after the account links later", async () => {
        // Offers posted before this fix stored the raw 0x account.
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "solo", amount: 300, requestedByWallet: "BORROWER", reservedLenderWallet: EVM, offerId: "legacy" });
        link();
        expect((await fundLoanSolo(loan.id, EVM, nextSig())).status).toBe("active");
    });

    it("EVM borrowers post collateral and repay from the linked wallet; refunds go there too", async () => {
        link();
        db.col("agents").set("agent1", { walletAddress: EVM, creditScore: 700, trustScore: 50, orgId: "org1", asn: "asn1" });
        await seedPool(1000);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", amount: 400, requestedByWallet: EVM });
        expect(loan.borrowerWalletAddress).toBe(SOL);
        await postLoanCollateral(loan.id, EVM, nextSig());
        expect(lastTransfer()).toMatchObject({ expectedFromWallet: SOL, expectedToWallet: "TREASURY" });
        await confirmLoanDisbursement(loan.id, nextSig());
        const { loan: after } = await repayLoan(loan.id, 500, EVM, nextSig());
        expect(lastTransfer()).toMatchObject({ expectedFromWallet: SOL, expectedToWallet: "TREASURY" });
        expect(after.status).toBe("repaid");
        expect(payouts("overpayment_refund")[0].toWallet).toBe(SOL);
        expect(payouts("collateral_return")[0].toWallet).toBe(SOL);
    });

    it("refuses a loan for an EVM-owned agent with no linked Solana wallet", async () => {
        db.col("agents").set("agent1", { walletAddress: EVM, creditScore: 700, trustScore: 50, orgId: "org1", asn: "asn1" });
        await seedPool(1000);
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amount: 100, requestedByWallet: EVM }),
        ).rejects.toThrow(/no Solana wallet/);
    });
});

describe("documents stored with legacy ...Usd field names", () => {
    const LEGACY_POOL = {
        name: "Legacy Pool", totalShares: 500, availableLiquidityUsd: 500, totalLentUsd: 0, totalDepositedUsd: 500,
        totalInterestEarnedUsd: 0, totalDefaultedUsd: 0, pendingWithdrawalUsd: 0, pendingWithdrawalShares: 0,
        accruingUsdPerYear: 0, interestReceivableUsd: 0, interestAccrualAt: T0 / 1000, createdAt: 0,
    };

    it("reads, then migrates in place, a legacy pool and position on the next deposit", async () => {
        db.col("lendingPools").set("legacy", { ...LEGACY_POOL });
        db.col("lendingPoolPositions").set("legacy_LENDER1", {
            poolId: "legacy", walletAddress: "LENDER1", shares: 500, principalDepositedUsd: 500, principalWithdrawnUsd: 0, pendingWithdrawalShares: 0,
        });
        expect((await getPool("legacy"))!.availableLiquidity).toBe(500);

        await confirmPoolDeposit("legacy", "LENDER1", 100, nextSig());
        const pool = db.col("lendingPools").get("legacy")!;
        expect(pool).toMatchObject({ availableLiquidity: 600, totalDeposited: 600, totalShares: 600 });
        expect(pool).not.toHaveProperty("availableLiquidityUsd");
        expect(pool).not.toHaveProperty("totalDepositedUsd");
        const pos = db.col("lendingPoolPositions").get("legacy_LENDER1")!;
        expect(pos).toMatchObject({ principalDeposited: 600, shares: 600 });
        expect(pos).not.toHaveProperty("principalDepositedUsd");
    });

    it("cancelling a withdrawal on a legacy pool doesn't lose its balance", async () => {
        db.col("lendingPools").set("legacy", { ...LEGACY_POOL, availableLiquidityUsd: 300, pendingWithdrawalUsd: 200, pendingWithdrawalShares: 200 });
        db.col("lendingPoolPositions").set("legacy_LENDER1", {
            poolId: "legacy", walletAddress: "LENDER1", shares: 500, principalDepositedUsd: 500, principalWithdrawnUsd: 0, pendingWithdrawalShares: 200,
        });
        db.col("lendingPoolWithdrawals").set("w1", {
            poolId: "legacy", walletAddress: "LENDER1", amountUsd: 200, sharesToBurn: 200, status: "pending_payout", requestedAt: 0, reserved: true,
        });
        await cancelPoolWithdrawal("w1");
        expect(db.col("lendingPools").get("legacy")).toMatchObject({ availableLiquidity: 500, pendingWithdrawal: 0, pendingWithdrawalShares: 0 });
        expect(db.col("lendingPools").get("legacy")).not.toHaveProperty("availableLiquidityUsd");
    });

    it("repays a loan stored with legacy names and settles its legacy pool", async () => {
        await seedPool(1000);
        const loan = await poolTrustLoan(400);
        // Rewrite the stored loan and pool as an older deployment would have left them.
        const toLegacy = (col: string, id: string, map: Record<string, string>) => {
            const doc = { ...db.col(col).get(id)! };
            for (const [oldKey, newKey] of Object.entries(map)) if (newKey in doc) { doc[oldKey] = doc[newKey]; delete doc[newKey]; }
            db.col(col).set(id, doc);
        };
        toLegacy("loans", loan.id, { principalUsd: "principal", principalRemainingUsd: "principalRemaining", principalPaidUsd: "principalPaid", interestAccruedUsd: "interestAccrued", interestPaidUsd: "interestPaid", collateralUsd: "collateral" });
        toLegacy("lendingPools", loan.poolId!, { availableLiquidityUsd: "availableLiquidity", totalLentUsd: "totalLent", accruingUsdPerYear: "accruingPerYear", interestReceivableUsd: "interestReceivable" });
        expect((await getLoan(loan.id))!.principal).toBe(400);

        const { loan: after } = await repayLoan(loan.id, 400, "BORROWER", nextSig());
        expect(after.status).toBe("repaid");
        const stored = db.col("loans").get(loan.id)!;
        expect(stored).toMatchObject({ principalRemaining: 0, principalPaid: 400, status: "repaid" });
        expect(stored).not.toHaveProperty("principalUsd");
        const pool = db.col("lendingPools").get(loan.poolId!)!;
        expect(pool).toMatchObject({ availableLiquidity: 1000, totalLent: 0 });
        expect(pool).not.toHaveProperty("totalLentUsd");
        expect(payouts("collateral_return")[0].amount).toBe(200);
    });
});
