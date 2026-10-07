/**
 * Per-asset pools (SOL, ETH) against the in-memory Firestore: each pool is
 * accounted in its own asset, verified on its own chain, sized against USD
 * limits at the live price, and pays out in the asset it took in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp, type FakeTxn } from "./fake-firestore";

const db = new FakeFirestore();
type Input = { txSig: string; expectedAmountUsd: number; expectedFromWallet: string; expectedToWallet: string };
const verifyUsdcTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig, receivedUsd: input.expectedAmountUsd }));
const verifySolTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig, receivedUsd: input.expectedAmountUsd, lamports: Math.round(input.expectedAmountUsd * 1e9) }));
const verifyEthTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig.toLowerCase(), receivedUsd: input.expectedAmountUsd }));
const prices: Record<string, number | Error> = { sol: 100, eth: 2000 };

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => db }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue, Timestamp: fakeTimestamp }));
vi.mock("@/lib/solana/lending-verify", () => ({
    verifyUsdcTransfer: (input: Input) => verifyUsdcTransfer(input),
    verifySolTransfer: (input: Input) => verifySolTransfer(input),
    claimUsdcTransferInTxn: (txn: FakeTxn, input: { txSig: string; purpose: string }) =>
        txn.create(db.collection("lendingOnChainTxs").doc(input.txSig), { purpose: input.purpose }),
    treasuryAddress: () => "TREASURY",
}));
// Real hash normalization, claim and treasury config — only the RPC read is stubbed.
vi.mock("@/lib/ethereum/lending-verify", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ethereum/lending-verify")>()),
    verifyEthTransfer: (input: Input) => verifyEthTransfer(input),
}));
vi.mock("../prices", () => ({
    getUsdPrice: async (asset: string) => {
        if (asset === "usdc") return 1;
        const p = prices[asset];
        if (p instanceof Error) throw p;
        return p;
    },
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
    getDepositCapacity,
    confirmPoolDeposit,
    requestPoolWithdrawal,
    confirmPoolWithdrawal,
    requestLoan,
    postLoanCollateral,
    confirmLoanDisbursement,
    repayLoan,
    markLoanDefaulted,
} from "../lending-service";
import { confirmPayout, canConfirmPayout } from "../payouts";
import { poolSharePrice } from "../math";
import type { LendingPayout, LendingPool } from "../types";

const DAY = 86400;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
let n = 0;
const solSig = () => `solsig${++n}`;
const ethHash = () => "0x" + (++n).toString(16).padStart(64, "0");

const EVM_LENDER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVM_BORROWER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ETH_TREASURY = "0xcccccccccccccccccccccccccccccccccccccccc";

function payouts(kind?: string): LendingPayout[] {
    return (db.all("lendingPayouts") as unknown as LendingPayout[]).filter((p) => !kind || p.kind === kind);
}
async function poolFor(asset: "usdc" | "sol" | "eth"): Promise<LendingPool> {
    return (await listPools()).find((p) => (p.asset ?? "usdc") === asset)!;
}

beforeEach(() => {
    db.store.clear();
    for (const fn of [verifyUsdcTransfer, verifySolTransfer, verifyEthTransfer]) fn.mockClear();
    prices.sol = 100;
    prices.eth = 2000;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    for (const k of ["LENDING_PAUSED", "LENDING_ALLOWLIST", "LENDING_MAX_POOL_TVL_USD", "LENDING_MAX_DEPOSIT_PER_WALLET_USD", "LENDING_MAX_LOAN_USD"]) delete process.env[k];
    process.env.ETH_LENDING_TREASURY_ADDRESS = ETH_TREASURY;
    db.col("agents").set("agent1", { walletAddress: "BORROWER", creditScore: 700, trustScore: 50, orgId: "org1", asn: "asn1" });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("pool seeding", () => {
    it("creates one pool per enabled asset, once", async () => {
        const pools = await listPools();
        expect(pools.map((p) => p.asset ?? "usdc")).toEqual(["usdc", "sol", "eth"]);
        await listPools();
        expect(db.all("lendingPools")).toHaveLength(3);
        expect(await getPool("community-sol")).toMatchObject({ asset: "sol", name: "SOL Lending Pool" });
    });

    it("leaves ETH out until its treasury is configured", async () => {
        delete process.env.ETH_LENDING_TREASURY_ADDRESS;
        expect((await listPools()).map((p) => p.asset ?? "usdc")).toEqual(["usdc", "sol"]);
    });
});

describe("SOL pool", () => {
    it("takes SOL, verifies native SOL to the Solana treasury, and accounts in SOL", async () => {
        const pool = await poolFor("sol");
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 12.5, solSig());
        expect(verifySolTransfer).toHaveBeenCalledWith(expect.objectContaining({ expectedAmountUsd: 12.5, expectedFromWallet: "LENDER1", expectedToWallet: "TREASURY" }));
        expect(verifyUsdcTransfer).not.toHaveBeenCalled();
        expect(res.creditedUsd).toBe(12.5);
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(12.5);
        expect(db.all("lendingPoolDeposits")).toMatchObject([{ amountUsd: 12.5, asset: "sol" }]);
    });

    it("applies USD beta caps at the live SOL price and refunds the excess in SOL", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "1000"; // = 10 SOL at $100
        const pool = await poolFor("sol");
        expect((await getDepositCapacity(pool.id, "LENDER1")).capacityUsd).toBe(10);
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 12, solSig());
        expect(res).toMatchObject({ creditedUsd: 10, refundedUsd: 2 });
        expect(payouts("deposit_refund")).toMatchObject([{ asset: "sol", amountUsd: 2, fromWallet: "TREASURY", toWallet: "LENDER1" }]);
    });

    it("fails a capped deposit without burning the signature when no price is available", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "1000";
        prices.sol = new Error("SOL price unavailable right now");
        const pool = await poolFor("sol");
        const sig = solSig();
        await expect(confirmPoolDeposit(pool.id, "LENDER1", 5, sig)).rejects.toThrow(/price unavailable/);
        prices.sol = 100;
        expect((await confirmPoolDeposit(pool.id, "LENDER1", 5, sig)).creditedUsd).toBe(5);
    });

    it("sizes loans by USD value: minimum, tier maximum and beta cap", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 500, solSig());
        const req = (amountUsd: number) => requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "sol", amountUsd, requestedByWallet: "BORROWER" });
        await expect(req(0.4)).rejects.toThrow(/worth at least \$50 \(≈ 0\.5 SOL\)/);
        await expect(req(101)).rejects.toThrow(/maximum for this loan type \(\$10,000 \(≈ 100 SOL\)\)/);
        process.env.LENDING_MAX_LOAN_USD = "300";
        await expect(req(4)).rejects.toThrow(/capped at \$300/);
        delete process.env.LENDING_MAX_LOAN_USD;
        const loan = await req(5);
        expect(loan).toMatchObject({ asset: "sol", principalUsd: 5, principalUsdValue: 500, poolId: pool.id, status: "pending_disbursement" });
    });

    it("runs a SOL trust loan end to end: collateral, disbursement, interest and repayment all in SOL", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 100, solSig());
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", poolId: pool.id, amountUsd: 10, requestedByWallet: "BORROWER" });
        expect(loan).toMatchObject({ asset: "sol", collateralUsd: 5, status: "pending_collateral" });

        await postLoanCollateral(loan.id, "BORROWER", solSig());
        expect(verifySolTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAmountUsd: 5, expectedFromWallet: "BORROWER", expectedToWallet: "TREASURY" }));
        await confirmLoanDisbursement(loan.id, solSig());
        expect(verifySolTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAmountUsd: 10, expectedFromWallet: "TREASURY", expectedToWallet: "BORROWER" }));

        vi.setSystemTime(T0 + 30 * DAY * 1000);
        const interest = 10 * 0.1 * (30 / 365);
        expect(poolSharePrice((await getPool(pool.id))!)).toBeCloseTo(1 + interest / 100, 9);

        const { loan: after } = await repayLoan(loan.id, 11, "BORROWER", solSig());
        expect(after.status).toBe("repaid");
        expect(after.interestPaidUsd).toBeCloseTo(interest, 9);
        expect(verifyUsdcTransfer).not.toHaveBeenCalled();
        expect(payouts("collateral_return")).toMatchObject([{ asset: "sol", amountUsd: 5, toWallet: "BORROWER" }]);
        expect(payouts("overpayment_refund")[0]).toMatchObject({ asset: "sol" });
        expect(payouts("overpayment_refund")[0].amountUsd).toBeCloseTo(1 - interest, 9);
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBeCloseTo(100 + interest, 9);
    });

    it("on default, collateral is applied in SOL and the loss written off in SOL", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 100, solSig());
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", poolId: pool.id, amountUsd: 10, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", solSig());
        await confirmLoanDisbursement(loan.id, solSig());
        vi.setSystemTime(T0 + 31 * DAY * 1000);
        await markLoanDefaulted(loan.id);
        expect((await getPool(pool.id))!.totalDefaultedUsd).toBeCloseTo(5, 9);
    });
});

describe("ETH pool", () => {
    it("takes deposits only from Ethereum logins and verifies them on Ethereum", async () => {
        const pool = await poolFor("eth");
        await expect(confirmPoolDeposit(pool.id, "SOLANA_LOGIN", 1, ethHash())).rejects.toThrow(/needs an Ethereum wallet/);
        const hash = ethHash();
        await confirmPoolDeposit(pool.id, EVM_LENDER.toUpperCase().replace("0X", "0x"), 1.5, hash.toUpperCase().replace("0X", "0x"));
        expect(verifyEthTransfer).toHaveBeenCalledWith(expect.objectContaining({ txSig: hash, expectedAmountUsd: 1.5, expectedFromWallet: EVM_LENDER, expectedToWallet: ETH_TREASURY }));
        expect(verifySolTransfer).not.toHaveBeenCalled();
        expect(db.col("lendingOnChainTxs").has(hash)).toBe(true);
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(1.5);
    });

    it("claims the lowercase hash, so a re-cased hash can't be credited twice", async () => {
        const pool = await poolFor("eth");
        const hash = ethHash();
        await confirmPoolDeposit(pool.id, EVM_LENDER, 1, hash);
        await expect(confirmPoolDeposit(pool.id, EVM_LENDER, 1, hash.toUpperCase().replace("0X", "0x"))).rejects.toThrow();
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(1);
    });

    it("withdrawals pay the lender's Ethereum address from the ETH treasury", async () => {
        const pool = await poolFor("eth");
        await confirmPoolDeposit(pool.id, EVM_LENDER, 2, ethHash());
        const req = await requestPoolWithdrawal(pool.id, EVM_LENDER, 0.5);
        expect(req).toMatchObject({ asset: "eth", payoutWalletAddress: EVM_LENDER, amountUsd: 0.5 });
        await confirmPoolWithdrawal(req.id, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: ETH_TREASURY, expectedToWallet: EVM_LENDER, expectedAmountUsd: 0.5 }));
        expect((await getPool(pool.id))!.availableLiquidityUsd).toBe(1.5);
    });

    it("pays an ETH loan to an Ethereum address — the agent's, else the requester's", async () => {
        const pool = await poolFor("eth");
        await confirmPoolDeposit(pool.id, EVM_LENDER, 2, ethHash());
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "eth", amountUsd: 0.1, requestedByWallet: "SOLANA_LOGIN" }),
        ).rejects.toThrow(/pays out on Ethereum/);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "eth", amountUsd: 0.1, requestedByWallet: EVM_BORROWER });
        expect(loan).toMatchObject({ asset: "eth", borrowerWalletAddress: EVM_BORROWER, principalUsdValue: 200 });
        await confirmLoanDisbursement(loan.id, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: ETH_TREASURY, expectedToWallet: EVM_BORROWER, expectedAmountUsd: 0.1 }));
        const { loan: after } = await repayLoan(loan.id, 0.2, EVM_BORROWER, ethHash());
        expect(after.status).toBe("repaid");
        const refund = payouts("overpayment_refund")[0];
        expect(refund).toMatchObject({ asset: "eth", fromWallet: ETH_TREASURY, toWallet: EVM_BORROWER });
        // Only an admin can confirm a treasury payout, and it's verified on Ethereum.
        expect(canConfirmPayout(refund, ETH_TREASURY, false)).toBe(false);
        await confirmPayout(refund.id, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: ETH_TREASURY, expectedToWallet: EVM_BORROWER }));
        expect(payouts("overpayment_refund")[0].status).toBe("paid");
    });

    it("solo loans stay USDC whatever asset is passed", async () => {
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "solo", asset: "eth", amountUsd: 100, requestedByWallet: "BORROWER" });
        expect(loan.asset).toBeUndefined();
        expect(loan.principalUsd).toBe(100);
    });
});
