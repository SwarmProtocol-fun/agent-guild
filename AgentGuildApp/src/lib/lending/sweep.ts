/**
 * Lending sweep — the scheduled housekeeping job (POST /api/cron/lending-sweep).
 *
 *   1. Default active loans that are past dueAt + LENDING_DEFAULT_GRACE_DAYS.
 *   2. Cancel trust loans still awaiting collateral after
 *      LENDING_PENDING_EXPIRY_DAYS, releasing any pool liquidity they reserved.
 *   3. Reconcile every pool's interest accrual against its active loans.
 *
 * Every step is idempotent and each loan is processed independently, so a
 * failure on one loan never blocks the rest, and re-running is always safe.
 */

import { adminDb } from "@/lib/firebase-admin";
import { lendingLimits } from "./config";
import { accrue } from "./math";
import { cancelLoan, listPools, markLoanDefaulted } from "./lending-service";
import type { LendingPool, Loan } from "./types";

const LOANS = "loans";
const POOLS = "lendingPools";

const nowSec = () => Math.floor(Date.now() / 1000);

export interface SweepResult {
    defaulted: string[];
    expired: string[];
    poolsReconciled: Array<{ poolId: string; activeLoans: number; accruingUsdPerYear: number; interestReceivableUsd: number }>;
    errors: string[];
}

/**
 * Rebuild a pool's accrual totals from its active loans — authoritative, so it
 * also corrects any drift and backfills loans disbursed before accrual
 * tracking existed (marking them tracked so later repayments/defaults adjust
 * the totals incrementally).
 */
export async function reconcilePoolAccrual(poolId: string): Promise<{ activeLoans: number; accruingUsdPerYear: number; interestReceivableUsd: number }> {
    const poolRef = adminDb().collection(POOLS).doc(poolId);
    const activeQuery = adminDb().collection(LOANS).where("poolId", "==", poolId).where("status", "==", "active");

    return adminDb().runTransaction(async (txn) => {
        const [poolSnap, loansSnap] = await Promise.all([txn.get(poolRef), txn.get(activeQuery)]);
        if (!poolSnap.exists) throw new Error("Pool not found");

        const at = nowSec();
        let accruingUsdPerYear = 0;
        let interestReceivableUsd = 0;
        for (const doc of loansSnap.docs) {
            const loan = accrue({ id: doc.id, ...doc.data() } as Loan, at);
            accruingUsdPerYear += loan.principalRemainingUsd * (loan.interestRateBps / 10_000);
            interestReceivableUsd += loan.interestAccruedUsd;
            if (!loan.poolAccrualTracked) txn.update(doc.ref, { poolAccrualTracked: true });
        }

        txn.update(poolRef, {
            accruingUsdPerYear,
            interestReceivableUsd,
            interestAccrualAt: at,
        } satisfies Partial<LendingPool>);

        return { activeLoans: loansSnap.size, accruingUsdPerYear, interestReceivableUsd };
    });
}

export async function sweepLending(): Promise<SweepResult> {
    const limits = lendingLimits();
    const now = nowSec();
    const result: SweepResult = { defaulted: [], expired: [], poolsReconciled: [], errors: [] };

    const overdue = await adminDb().collection(LOANS)
        .where("status", "==", "active")
        .where("dueAt", "<", now - limits.defaultGraceDays * 86400)
        .get();
    for (const doc of overdue.docs) {
        try {
            await markLoanDefaulted(doc.id, { graceDays: limits.defaultGraceDays });
            result.defaulted.push(doc.id);
        } catch (err) {
            result.errors.push(`default ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const stale = await adminDb().collection(LOANS)
        .where("status", "==", "pending_collateral")
        .where("requestedAt", "<", now - limits.pendingExpiryDays * 86400)
        .get();
    for (const doc of stale.docs) {
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
