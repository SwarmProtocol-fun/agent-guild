/**
 * Per-asset pools (SOL, ETH) against the in-memory Firestore: each pool is
 * accounted in its own asset, verified on its own chain, sized against USD
 * limits at the live price, and pays out in the asset it took in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeFirestore, fakeFieldValue, fakeTimestamp, type FakeTxn } from "./fake-firestore";

const db = new FakeFirestore();
type Input = { txSig: string; expectedAmount: number; expectedFromWallet: string; expectedToWallet: string };
const verifyUsdcTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig, received: input.expectedAmount }));
const verifySolTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig, received: input.expectedAmount, lamports: Math.round(input.expectedAmount * 1e9) }));
const verifyEthTransfer = vi.fn(async (input: Input) => ({ txSig: input.txSig.toLowerCase(), received: input.expectedAmount }));
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
    settleLiquidation,
    getLoan,
} from "../lending-service";
import { sweepLending } from "../sweep";
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
    return (await listPools()).find((p) => (p.asset ?? "usdc") === asset && !p.collateralAsset)!;
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
        expect(pools.map((p) => (p.collateralAsset ? `${p.asset ?? "usdc"}/${p.collateralAsset}` : p.asset ?? "usdc"))).toEqual(["usdc", "sol", "eth", "usdc/eth", "usdc/sol"]);
        await listPools();
        expect(db.all("lendingPools")).toHaveLength(5);
        expect(await getPool("market-usdc-eth")).toMatchObject({ collateralAsset: "eth", maxLtvBps: 6500, liquidationLtvBps: 8000 });
        expect(await getPool("community-sol")).toMatchObject({ asset: "sol", name: "SOL Lending Pool" });
    });

    it("leaves ETH out until its treasury is configured", async () => {
        delete process.env.ETH_LENDING_TREASURY_ADDRESS;
        expect((await listPools()).map((p) => p.id)).toEqual([expect.any(String), "community-sol", "market-usdc-sol"]);
    });
});

describe("SOL pool", () => {
    it("takes SOL, verifies native SOL to the Solana treasury, and accounts in SOL", async () => {
        const pool = await poolFor("sol");
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 12.5, solSig());
        expect(verifySolTransfer).toHaveBeenCalledWith(expect.objectContaining({ expectedAmount: 12.5, expectedFromWallet: "LENDER1", expectedToWallet: "TREASURY" }));
        expect(verifyUsdcTransfer).not.toHaveBeenCalled();
        expect(res.credited).toBe(12.5);
        expect((await getPool(pool.id))!.availableLiquidity).toBe(12.5);
        expect(db.all("lendingPoolDeposits")).toMatchObject([{ amount: 12.5, asset: "sol" }]);
    });

    it("applies USD beta caps at the live SOL price and refunds the excess in SOL", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "1000"; // = 10 SOL at $100
        const pool = await poolFor("sol");
        expect((await getDepositCapacity(pool.id, "LENDER1")).capacity).toBe(10);
        const res = await confirmPoolDeposit(pool.id, "LENDER1", 12, solSig());
        expect(res).toMatchObject({ credited: 10, refunded: 2 });
        expect(payouts("deposit_refund")).toMatchObject([{ asset: "sol", amount: 2, fromWallet: "TREASURY", toWallet: "LENDER1" }]);
    });

    it("fails a capped deposit without burning the signature when no price is available", async () => {
        process.env.LENDING_MAX_DEPOSIT_PER_WALLET_USD = "1000";
        prices.sol = new Error("SOL price unavailable right now");
        const pool = await poolFor("sol");
        const sig = solSig();
        await expect(confirmPoolDeposit(pool.id, "LENDER1", 5, sig)).rejects.toThrow(/price unavailable/);
        prices.sol = 100;
        expect((await confirmPoolDeposit(pool.id, "LENDER1", 5, sig)).credited).toBe(5);
    });

    it("sizes loans by USD value: minimum, tier maximum and beta cap", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 500, solSig());
        const req = (amount: number) => requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "sol", amount, requestedByWallet: "BORROWER" });
        await expect(req(0.4)).rejects.toThrow(/worth at least \$50 \(≈ 0\.5 SOL\)/);
        await expect(req(101)).rejects.toThrow(/maximum for this loan type \(\$10,000 \(≈ 100 SOL\)\)/);
        process.env.LENDING_MAX_LOAN_USD = "300";
        await expect(req(4)).rejects.toThrow(/capped at \$300/);
        delete process.env.LENDING_MAX_LOAN_USD;
        const loan = await req(5);
        expect(loan).toMatchObject({ asset: "sol", principal: 5, principalUsdValue: 500, poolId: pool.id, status: "pending_disbursement" });
    });

    it("runs a SOL trust loan end to end: collateral, disbursement, interest and repayment all in SOL", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 100, solSig());
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", poolId: pool.id, amount: 10, requestedByWallet: "BORROWER" });
        expect(loan).toMatchObject({ asset: "sol", collateral: 5, status: "pending_collateral" });

        await postLoanCollateral(loan.id, "BORROWER", solSig());
        expect(verifySolTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAmount: 5, expectedFromWallet: "BORROWER", expectedToWallet: "TREASURY" }));
        await confirmLoanDisbursement(loan.id, solSig());
        expect(verifySolTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAmount: 10, expectedFromWallet: "TREASURY", expectedToWallet: "BORROWER" }));

        vi.setSystemTime(T0 + 30 * DAY * 1000);
        const interest = 10 * 0.1 * (30 / 365);
        expect(poolSharePrice((await getPool(pool.id))!)).toBeCloseTo(1 + interest / 100, 9);

        const { loan: after } = await repayLoan(loan.id, 11, "BORROWER", solSig());
        expect(after.status).toBe("repaid");
        expect(after.interestPaid).toBeCloseTo(interest, 9);
        expect(verifyUsdcTransfer).not.toHaveBeenCalled();
        expect(payouts("collateral_return")).toMatchObject([{ asset: "sol", amount: 5, toWallet: "BORROWER" }]);
        expect(payouts("overpayment_refund")[0]).toMatchObject({ asset: "sol" });
        expect(payouts("overpayment_refund")[0].amount).toBeCloseTo(1 - interest, 9);
        expect((await getPool(pool.id))!.availableLiquidity).toBeCloseTo(100 + interest, 9);
    });

    it("on default, collateral is applied in SOL and the loss written off in SOL", async () => {
        const pool = await poolFor("sol");
        await confirmPoolDeposit(pool.id, "LENDER1", 100, solSig());
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "trust", source: "pool", poolId: pool.id, amount: 10, requestedByWallet: "BORROWER" });
        await postLoanCollateral(loan.id, "BORROWER", solSig());
        await confirmLoanDisbursement(loan.id, solSig());
        vi.setSystemTime(T0 + 31 * DAY * 1000);
        await markLoanDefaulted(loan.id);
        expect((await getPool(pool.id))!.totalDefaulted).toBeCloseTo(5, 9);
    });
});

describe("ETH pool", () => {
    it("takes deposits only from Ethereum logins and verifies them on Ethereum", async () => {
        const pool = await poolFor("eth");
        await expect(confirmPoolDeposit(pool.id, "SOLANA_LOGIN", 1, ethHash())).rejects.toThrow(/needs an Ethereum wallet/);
        const hash = ethHash();
        await confirmPoolDeposit(pool.id, EVM_LENDER.toUpperCase().replace("0X", "0x"), 1.5, hash.toUpperCase().replace("0X", "0x"));
        expect(verifyEthTransfer).toHaveBeenCalledWith(expect.objectContaining({ txSig: hash, expectedAmount: 1.5, expectedFromWallet: EVM_LENDER, expectedToWallet: ETH_TREASURY }));
        expect(verifySolTransfer).not.toHaveBeenCalled();
        expect(db.col("lendingOnChainTxs").has(hash)).toBe(true);
        expect((await getPool(pool.id))!.availableLiquidity).toBe(1.5);
    });

    it("claims the lowercase hash, so a re-cased hash can't be credited twice", async () => {
        const pool = await poolFor("eth");
        const hash = ethHash();
        await confirmPoolDeposit(pool.id, EVM_LENDER, 1, hash);
        await expect(confirmPoolDeposit(pool.id, EVM_LENDER, 1, hash.toUpperCase().replace("0X", "0x"))).rejects.toThrow();
        expect((await getPool(pool.id))!.availableLiquidity).toBe(1);
    });

    it("withdrawals pay the lender's Ethereum address from the ETH treasury", async () => {
        const pool = await poolFor("eth");
        await confirmPoolDeposit(pool.id, EVM_LENDER, 2, ethHash());
        const req = await requestPoolWithdrawal(pool.id, EVM_LENDER, 0.5);
        expect(req).toMatchObject({ asset: "eth", payoutWalletAddress: EVM_LENDER, amount: 0.5 });
        await confirmPoolWithdrawal(req.id, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: ETH_TREASURY, expectedToWallet: EVM_LENDER, expectedAmount: 0.5 }));
        expect((await getPool(pool.id))!.availableLiquidity).toBe(1.5);
    });

    it("pays an ETH loan to an Ethereum address — the agent's, else the requester's", async () => {
        const pool = await poolFor("eth");
        await confirmPoolDeposit(pool.id, EVM_LENDER, 2, ethHash());
        await expect(
            requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "eth", amount: 0.1, requestedByWallet: "SOLANA_LOGIN" }),
        ).rejects.toThrow(/pays out on Ethereum/);
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", asset: "eth", amount: 0.1, requestedByWallet: EVM_BORROWER });
        expect(loan).toMatchObject({ asset: "eth", borrowerWalletAddress: EVM_BORROWER, principalUsdValue: 200 });
        await confirmLoanDisbursement(loan.id, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: ETH_TREASURY, expectedToWallet: EVM_BORROWER, expectedAmount: 0.1 }));
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
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "solo", asset: "eth", amount: 100, requestedByWallet: "BORROWER" });
        expect(loan.asset).toBeUndefined();
        expect(loan.principal).toBe(100);
    });
});

describe("collateral markets (USDC/ETH, USDC/SOL)", () => {
    async function fundedMarket(id: "market-usdc-eth" | "market-usdc-sol", usdc = 5000) {
        await listPools();
        await confirmPoolDeposit(id, "LENDER1", usdc, solSig());
        return (await getPool(id))!;
    }
    const borrow = (poolId: string, amount: number, kind: "trust" | "unsecured" = "trust") =>
        requestLoan({ agentId: "agent1", orgId: "org1", kind, source: "pool", poolId, amount, requestedByWallet: EVM_BORROWER });

    it("plain USDC loans still go to the USDC pool, not a market", async () => {
        const pool = await fundedMarket("market-usdc-eth");
        await confirmPoolDeposit((await poolFor("usdc")).id, "LENDER1", 1000, solSig());
        const loan = await requestLoan({ agentId: "agent1", orgId: "org1", kind: "unsecured", source: "pool", amount: 100, requestedByWallet: "BORROWER" });
        expect(loan.poolId).not.toBe(pool.id);
        expect(loan.collateralAsset).toBeUndefined();
    });

    it("lends USDC against ETH collateral sized to the market's max LTV", async () => {
        const pool = await fundedMarket("market-usdc-eth");
        await expect(borrow(pool.id, 1000, "unsecured")).rejects.toThrow(/collateralized/);
        const loan = await borrow(pool.id, 1000);
        // $1000 at 65% LTV = $1538.46 of ETH at $2000.
        expect(loan.asset).toBeUndefined(); // lends USDC
        expect(loan).toMatchObject({ collateralAsset: "eth", liquidationLtvBps: 8000, status: "pending_collateral", principal: 1000 });
        expect(loan.collateral).toBeCloseTo(1000 / 0.65 / 2000, 8);
        expect(loan.collateral * 2000).toBeGreaterThanOrEqual(1000 / 0.65);
    });

    it("runs end to end: ETH collateral on Ethereum, USDC on Solana, collateral returned in ETH", async () => {
        const pool = await fundedMarket("market-usdc-eth");
        const loan = await borrow(pool.id, 1000);
        await expect(postLoanCollateral(loan.id, "SOLANA_LOGIN", ethHash())).rejects.toThrow(/needs an Ethereum wallet/);
        await postLoanCollateral(loan.id, EVM_BORROWER, ethHash());
        expect(verifyEthTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: EVM_BORROWER, expectedToWallet: ETH_TREASURY, expectedAmount: loan.collateral }));
        await confirmLoanDisbursement(loan.id, solSig());
        expect(verifyUsdcTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: "TREASURY", expectedToWallet: "BORROWER", expectedAmount: 1000 }));
        const { loan: after } = await repayLoan(loan.id, 1000, "BORROWER", solSig());
        expect(after.status).toBe("repaid");
        expect(payouts("collateral_return")).toMatchObject([{ asset: "eth", fromWallet: ETH_TREASURY, toWallet: EVM_BORROWER, amount: loan.collateral }]);
    });

    it("the sweep liquidates when the price drops past the threshold; a shortfall becomes a default", async () => {
        const pool = await fundedMarket("market-usdc-eth");
        const loan = await borrow(pool.id, 1000);
        await postLoanCollateral(loan.id, EVM_BORROWER, ethHash());
        await confirmLoanDisbursement(loan.id, solSig());

        prices.eth = 1700; // LTV ≈ 76% — under 80%
        expect((await sweepLending()).liquidating).toEqual([]);
        prices.eth = 1500; // LTV = 86.7%
        const res = await sweepLending();
        expect(res.liquidating).toEqual([loan.id]);
        const liq = (await getLoan(loan.id))!;
        expect(liq).toMatchObject({ status: "liquidating", collateralStatus: "seized", liquidationReason: "ltv", liquidationPriceUsd: 1500 });
        expect((await getPool(pool.id))!.accruingPerYear).toBe(0);

        await settleLiquidation(loan.id, 900, solSig());
        expect(verifyUsdcTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedFromWallet: null, expectedToWallet: "TREASURY", expectedAmount: 900 }));
        const settled = (await getLoan(loan.id))!;
        expect(settled).toMatchObject({ status: "defaulted", principalRemaining: 100, principalPaid: 900, liquidationProceeds: 900 });
        const p = (await getPool(pool.id))!;
        expect(p).toMatchObject({ availableLiquidity: 4900, totalLent: 0, totalDefaulted: 100 });
        await expect(settleLiquidation(loan.id, 1, solSig())).rejects.toThrow(/not being liquidated/);
    });

    it("proceeds above the debt close it as liquidated and refund the surplus in USDC", async () => {
        const pool = await fundedMarket("market-usdc-sol");
        const loan = await borrow(pool.id, 550);
        expect(loan.collateral).toBeCloseTo(10, 8); // $550 at 55% LTV = $1000 = 10 SOL at $100
        await postLoanCollateral(loan.id, "BORROWER", solSig());
        expect(verifySolTransfer).toHaveBeenLastCalledWith(expect.objectContaining({ expectedToWallet: "TREASURY", expectedAmount: 10 }));
        await confirmLoanDisbursement(loan.id, solSig());
        prices.sol = 70; // LTV = 78.6% ≥ 75%
        expect((await sweepLending()).liquidating).toEqual([loan.id]);
        await settleLiquidation(loan.id, 650, solSig());
        expect((await getLoan(loan.id))!).toMatchObject({ status: "liquidated", principalRemaining: 0 });
        expect(payouts("liquidation_surplus")).toMatchObject([{ fromWallet: "TREASURY", toWallet: "BORROWER", amount: 100 }]);
        expect((await getPool(pool.id))!.availableLiquidity).toBe(5000 + 100 - 100);
    });

    it("an overdue market loan is liquidated rather than defaulted", async () => {
        const pool = await fundedMarket("market-usdc-sol");
        const loan = await borrow(pool.id, 550);
        await postLoanCollateral(loan.id, "BORROWER", solSig());
        await confirmLoanDisbursement(loan.id, solSig());
        vi.setSystemTime(T0 + 31 * DAY * 1000);
        expect((await markLoanDefaulted(loan.id)).status).toBe("liquidating");
        expect((await getLoan(loan.id))!.liquidationReason).toBe("overdue");
    });

    it("skips liquidation checks while prices are unavailable, and reports it", async () => {
        const pool = await fundedMarket("market-usdc-sol");
        const loan = await borrow(pool.id, 550);
        await postLoanCollateral(loan.id, "BORROWER", solSig());
        await confirmLoanDisbursement(loan.id, solSig());
        prices.sol = new Error("SOL price unavailable right now");
        const res = await sweepLending();
        expect(res.liquidating).toEqual([]);
        expect(res.errors.join(" ")).toMatch(/liquidation check .*price unavailable/);
        expect((await getLoan(loan.id))!.status).toBe("active");
    });
});
