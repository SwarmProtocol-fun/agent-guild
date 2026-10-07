/**
 * Legacy `...Usd` field names. Lending documents written before the rename
 * (see assets.ts) used `principalUsd`, `availableLiquidityUsd`, etc. for
 * amounts that are really in the record's asset. Two mechanisms retire them:
 *
 *   - normalizeLegacy() — every read maps old names to new ones, so a legacy
 *     document behaves exactly like a migrated one.
 *   - healLegacyInTxn() — before a transaction writes renamed fields on a
 *     pool, position or loan, it rewrites that document's old fields under the
 *     new names and deletes the old ones in the same transaction. Without this,
 *     an increment() on a new name would start from zero next to the old value.
 *
 * scripts/migrate-lending-fields.ts migrates everything in bulk; after it has
 * run (and no older deployment is still writing old names) this module is a
 * no-op on every document.
 */
import { FieldValue } from "firebase-admin/firestore";

export type LegacyCollection =
    | "lendingPools"
    | "lendingPoolPositions"
    | "lendingPoolWithdrawals"
    | "lendingPoolDeposits"
    | "loans"
    | "loanRepayments"
    | "loanOffers"
    | "lendingPayouts"
    | "lendingOnChainTxs";

/** old name → new name, per collection. */
export const LEGACY_FIELDS: Record<LegacyCollection, Record<string, string>> = {
    lendingPools: {
        availableLiquidityUsd: "availableLiquidity",
        totalLentUsd: "totalLent",
        totalDepositedUsd: "totalDeposited",
        totalInterestEarnedUsd: "totalInterestEarned",
        totalDefaultedUsd: "totalDefaulted",
        pendingWithdrawalUsd: "pendingWithdrawal",
        accruingUsdPerYear: "accruingPerYear",
        interestReceivableUsd: "interestReceivable",
    },
    lendingPoolPositions: {
        principalDepositedUsd: "principalDeposited",
        principalWithdrawnUsd: "principalWithdrawn",
    },
    lendingPoolWithdrawals: { amountUsd: "amount" },
    lendingPoolDeposits: { amountUsd: "amount", refundedUsd: "refunded" },
    loans: {
        principalUsd: "principal",
        principalRemainingUsd: "principalRemaining",
        principalPaidUsd: "principalPaid",
        interestAccruedUsd: "interestAccrued",
        interestPaidUsd: "interestPaid",
        collateralUsd: "collateral",
        overpaymentOwedUsd: "overpaymentOwed",
    },
    loanRepayments: {
        amountUsd: "amount",
        principalPortionUsd: "principalPortion",
        interestPortionUsd: "interestPortion",
        remainingBalanceUsd: "remainingBalance",
        excessUsd: "excess",
    },
    loanOffers: { amountUsd: "amount" },
    lendingPayouts: { amountUsd: "amount" },
    lendingOnChainTxs: { amountUsd: "amount" },
};

/**
 * Running totals that only ever change by increment(). If both an old and a
 * new name exist (an older deployment incremented the old name after this
 * document was migrated), the true value is their sum. For every other field
 * the new name wins.
 */
const ADDITIVE = new Set([
    "availableLiquidity", "totalLent", "totalDeposited", "totalInterestEarned", "totalDefaulted", "pendingWithdrawal",
    "principalDeposited", "principalWithdrawn",
]);

export function hasLegacyFields(collection: LegacyCollection, data: FirebaseFirestore.DocumentData | undefined): boolean {
    return !!data && Object.keys(LEGACY_FIELDS[collection]).some((k) => k in data);
}

/** The value a document's new field should hold, given whatever old/new fields it has. */
function mergedValue(data: FirebaseFirestore.DocumentData, oldKey: string, newKey: string): unknown {
    const hasOld = oldKey in data;
    const hasNew = newKey in data;
    if (hasOld && hasNew && ADDITIVE.has(newKey) && typeof data[oldKey] === "number" && typeof data[newKey] === "number") {
        return data[oldKey] + data[newKey];
    }
    return hasNew ? data[newKey] : data[oldKey];
}

/** Read-side: a copy of `data` with old names mapped to new ones and the old ones dropped. */
export function normalizeLegacy<T extends FirebaseFirestore.DocumentData>(collection: LegacyCollection, data: T): T {
    if (!hasLegacyFields(collection, data)) return data;
    const out: FirebaseFirestore.DocumentData = { ...data };
    for (const [oldKey, newKey] of Object.entries(LEGACY_FIELDS[collection])) {
        if (!(oldKey in data)) continue;
        out[newKey] = mergedValue(data, oldKey, newKey);
        delete out[oldKey];
    }
    return out as T;
}

/** The update that migrates one document in place, or null if it has nothing to migrate. */
export function legacyMigrationUpdate(collection: LegacyCollection, data: FirebaseFirestore.DocumentData | undefined): Record<string, unknown> | null {
    if (!data || !hasLegacyFields(collection, data)) return null;
    const update: Record<string, unknown> = {};
    for (const [oldKey, newKey] of Object.entries(LEGACY_FIELDS[collection])) {
        if (!(oldKey in data)) continue;
        update[newKey] = mergedValue(data, oldKey, newKey);
        update[oldKey] = FieldValue.delete();
    }
    return update;
}

/**
 * Write-side: migrate `ref` inside `txn` if its raw data still has old names.
 * Call after the transaction's reads and before its other writes to the same
 * document — Firestore applies a transaction's writes in order.
 */
export function healLegacyInTxn(
    txn: FirebaseFirestore.Transaction,
    ref: FirebaseFirestore.DocumentReference,
    collection: LegacyCollection,
    rawData: FirebaseFirestore.DocumentData | undefined,
): void {
    const update = legacyMigrationUpdate(collection, rawData);
    if (update) txn.update(ref, update);
}
