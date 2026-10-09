/**
 * Lending sweep — the scheduled housekeeping job (POST /api/cron/lending-sweep).
 *
 *   1. Default active loans that are past dueAt + LENDING_DEFAULT_GRACE_DAYS
 *      (collateral-market loans are liquidated instead).
 *   1b. Liquidate collateral-market loans whose loan-to-value reached their
 *      market's liquidation threshold at live prices.
 *   2. Post collateral that was sent from an agent's own wallet and has
 *      since finalized (Ethereum takes ~15 minutes), then cancel loans still
 *      awaiting collateral after LENDING_PENDING_EXPIRY_DAYS, releasing any
 *      pool liquidity they reserved. A loan whose agent-wallet transfer is
 *      already on-chain is never expired — its collateral is on the way.
 *   3. Reconcile every pool's interest accrual against its active loans.
 *
 * Every step is idempotent and each loan is processed independently, so a
 * failure on one loan never blocks the rest, and re-running is always safe.
 */

import { adminDb } from "@/lib/firebase-admin";
import { lendingLimits } from "./config";
import { accrue } from "./math";
import { cancelLoan, listPools, markLoanDefaulted, currentLoanToValue, startLiquidation } from "./lending-service";
import type { LendingPool, Loan } from "./types";
import { normalizeLegacy, healLegacyInTxn } from "./legacy-fields";
import { finishPendingAgentCollateral, finishPendingAgentTopUps } from "./agent-collateral";
import { finishPendingAgentRepays } from "./agent-repay";

const LOANS = "loans";
const POOLS = "lendingPools";

const nowSec = () => Math.floor(Date.now() / 1000);

export interface SweepResult {
    defaulted: string[];
    /** Collateral-market loans moved to "liquidating" (overdue or under-collateralized). */
    liquidating: string[];
    expired: string[];
    /** Loans whose agent-wallet collateral finalized and was posted this run. */
    collateralPosted: string[];
    /** Loans whose agent-wallet top-up or repayment finalized and was applied this run. */
    agentSendsSettled: string[];
    poolsReconciled: Array<{ poolId: string; activeLoans: number; accruingPerYear: number; interestReceivable: number }>;
    errors: string[];
}

/**
 * Rebuild a pool's accrual totals from its active loans — authoritative, so it
 * also corrects any drift and backfills loans disbursed before accrual
 * tracking existed (marking them tracked so later repayments/defaults adjust
 * the totals incrementally).
 */
export async function reconcilePoolAccrual(poolId: string): Promise<{ activeLoans: number; accruingPerYear: number; interestReceivable: number }> {
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const activeQuery = adminDb().collection(LOANS).where("poolId", "==", poolId).where("status", "==", "active");

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, loansSnap] = await Promise.all([txn.get(poolRef), txn.get(activeQuery)]);
        if (!poolSnap.exists) throw new Error("Pool not found");
        healLegacyInTxn(txn, poolRef, "lendingPools", poolSnap.data());

        const at = nowSec();
        let accruingPerYear = 0;
        let interestReceivable = 0;
        for (const doc of loansSnap.docs) {
            const loan = accrue({ id: doc.id, ...normalizeLegacy("loans", doc.data()) } as Loan, at);
            accruingPerYear += loan.principalRemaining * (loan.interestRateBps / 10_000);
            interestReceivable += loan.interestAccrued;
            if (!loan.poolAccrualTracked) txn.update(doc.ref, { poolAccrualTracked: true });
        }

        txn.update(poolRef, {
            accruingPerYear,
            interestReceivable,
            interestAccrualAt: at,
        } satisfies Partial<LendingPool>);

        return { activeLoans: loansSnap.size, accruingPerYear, interestReceivable };
    });
}

export async function sweepLending(): Promise<SweepResult> {
    const limits = lendingLimits();
    const now = nowSec();
    const result: SweepResult = { defaulted: [], liquidating: [], expired: [], collateralPosted: [], agentSendsSettled: [], poolsReconciled: [], errors: [] };

    const overdue = await adminDb().collection(LOANS)
        .where("status", "==", "active")
        .where("dueAt", "<", now - limits.defaultGraceDays * 86400)
        .get();
    for (const doc of overdue.docs) {
        try {
            const loan = await markLoanDefaulted(doc.id, { graceDays: limits.defaultGraceDays });
            (loan.status === "liquidating" ? result.liquidating : result.defaulted).push(doc.id);
        } catch (err) {
            result.errors.push(`default ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Under-collateralized market loans. A price outage skips them (fail closed) and is reported.
    const active = await adminDb().collection(LOANS).where("status", "==", "active").get();
    for (const doc of active.docs) {
        const loan = { id: doc.id, ...normalizeLegacy("loans", doc.data()) } as Loan;
        if (!loan.collateralAsset || !loan.liquidationLtvBps || result.liquidating.includes(loan.id)) continue;
        try {
            const ltv = await currentLoanToValue(loan, now);
            if (ltv * 10_000 >= loan.liquidationLtvBps) {
                await startLiquidation(loan.id, "ltv");
                result.liquidating.push(loan.id);
            }
        } catch (err) {
            result.errors.push(`liquidation check ${loan.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    for (const [label, finish, into] of [
        ["agent collateral", finishPendingAgentCollateral, result.collateralPosted],
        ["agent top-up", finishPendingAgentTopUps, result.agentSendsSettled],
        ["agent repayment", finishPendingAgentRepays, result.agentSendsSettled],
    ] as const) {
        try {
            const finished = await finish();
            into.push(...finished.posted);
            result.errors.push(...finished.errors.map((e) => `${label} ${e}`));
        } catch (err) {
            result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const stale = await adminDb().collection(LOANS)
        .where("status", "==", "pending_collateral")
        .where("requestedAt", "<", now - limits.pendingExpiryDays * 86400)
        .get();
    for (const doc of stale.docs) {
        const send = (doc.data() as Loan).agentCollateralSend;
        // A transfer from the agent's wallet is in flight; the loan waits for it to settle.
        if (send?.status === "sent" || send?.status === "sending") continue;
        try {
            await cancelLoan(doc.id, { byAdmin: true, reason: `Collateral not posted within ${limits.pendingExpiryDays} days` });
            result.expired.push(doc.id);
        } catch (err) {
            result.errors.push(`expire ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    for (const pool of await listPools()) {
        try {
            result.poolsReconciled.push({ poolId: pool.id, ...(await reconcilePoolAccrual(pool.id)) });
        } catch (err) {
            result.errors.push(`reconcile ${pool.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return result;
}
