/**
 * Lending payouts — every money movement the ledger owes but can't execute
 * itself: collateral returns, seized collateral owed to a solo lender,
 * overpayment refunds, and refunds for transfers that landed after the thing
 * they were meant for had moved on (a deposit over the beta cap, a duplicate
 * solo funding, a repayment to a closed loan).
 *
 * Payouts are created inside the same Firestore transaction as the ledger
 * change that owes them, so an obligation is never recorded without its
 * cause or vice versa. Whoever controls `fromWallet` sends the USDC and
 * confirms with the signature — verified on-chain like every other lending
 * transfer before the payout is marked paid.
 *
 * Collection: lendingPayouts.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyUsdcTransfer, claimUsdcTransferInTxn, treasuryAddress, type VerifyTransferInput } from "@/lib/solana/lending-verify";
import type { LendingPayout, Loan } from "./types";

const PAYOUTS = "lendingPayouts";
const LOANS = "loans";
const REPAYMENTS = "loanRepayments";

const nowSec = () => Math.floor(Date.now() / 1000);

export type NewPayout = Omit<LendingPayout, "id" | "status" | "createdAt" | "paidAt" | "txSig">;

/** Queue a payout as part of the caller's transaction. Returns its id. Skips dust (< 1 cent). */
export function createPayoutInTxn(txn: FirebaseFirestore.Transaction, payout: NewPayout): string | null {
    if (!(payout.amountUsd >= 0.01)) return null;
    const ref = adminDb().collection(PAYOUTS).doc();
    const doc: Omit<LendingPayout, "id"> = {
        ...payout,
        amountUsd: Math.round(payout.amountUsd * 1_000_000) / 1_000_000,
        status: "pending",
        createdAt: nowSec(),
    };
    txn.set(ref, Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));
    return ref.id;
}

function toPayout(id: string, data: FirebaseFirestore.DocumentData): LendingPayout {
    return { id, ...data } as LendingPayout;
}

export async function getPayout(payoutId: string): Promise<LendingPayout | null> {
    const snap = await adminDb().collection(PAYOUTS).doc(payoutId).get();
    return snap.exists ? toPayout(snap.id, snap.data()!) : null;
}

/** Every pending payout (platform-admin queue). */
export async function listPendingPayouts(): Promise<LendingPayout[]> {
    const snap = await adminDb().collection(PAYOUTS).where("status", "==", "pending").orderBy("createdAt", "asc").get();
    return snap.docs.map((d) => toPayout(d.id, d.data()));
}

/** Payouts a wallet is owed or owes, newest first. */
export async function listPayoutsForWallet(wallet: string): Promise<{ owedToYou: LendingPayout[]; owedByYou: LendingPayout[] }> {
    const [to, from] = await Promise.all([
        adminDb().collection(PAYOUTS).where("toWallet", "==", wallet).orderBy("createdAt", "desc").limit(50).get(),
        adminDb().collection(PAYOUTS).where("fromWallet", "==", wallet).orderBy("createdAt", "desc").limit(50).get(),
    ]);
    return {
        owedToYou: to.docs.map((d) => toPayout(d.id, d.data())),
        owedByYou: from.docs.map((d) => toPayout(d.id, d.data())),
    };
}

/** Treasury payouts can only be confirmed by a platform admin; any other payout by its sender (or an admin). */
export function canConfirmPayout(payout: LendingPayout, callerWallet: string | null, isAdmin: boolean): boolean {
    if (isAdmin) return true;
    let treasury: string | null = null;
    try {
        treasury = treasuryAddress();
    } catch {
        treasury = null;
    }
    if (payout.fromWallet === treasury) return false;
    return !!callerWallet && callerWallet === payout.fromWallet;
}

/**
 * Verify the payout's transfer happened on-chain, then mark it paid and
 * apply its side effect on the loan/repayment it settles — all in one
 * transaction with the signature claim.
 */
export async function confirmPayout(payoutId: string, txSig: string): Promise<LendingPayout> {
    const payoutRef = adminDb().collection(PAYOUTS).doc(payoutId);
    const existing = await getPayout(payoutId);
    if (!existing) throw new Error("Payout not found");
    if (existing.status !== "pending") throw new Error("Payout is already paid");

    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: existing.fromWallet,
        expectedToWallet: existing.toWallet,
        expectedAmountUsd: existing.amountUsd,
        purpose: `payout_${existing.kind}`,
        refId: payoutId,
    };
    await verifyUsdcTransfer(transfer);

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(payoutRef);
        if (!snap.exists) throw new Error("Payout not found");
        const payout = toPayout(snap.id, snap.data()!);
        if (payout.status !== "pending") throw new Error("Payout is already paid");

        const loanRef = payout.loanId ? adminDb().collection(LOANS).doc(payout.loanId) : null;
        const loanSnap = loanRef ? await txn.get(loanRef) : null;
        const loan = loanSnap?.exists ? (loanSnap.data() as Loan) : null;

        claimUsdcTransferInTxn(txn, transfer);

        const paidAt = nowSec();
        txn.update(payoutRef, { status: "paid", txSig, paidAt });

        if (loanRef && loan) {
            if (payout.kind === "collateral_return" && loan.collateralStatus === "return_pending") {
                txn.update(loanRef, { collateralStatus: "returned" });
            }
            if (payout.kind === "overpayment_refund" && payout.repaymentId) {
                txn.update(loanRef, { overpaymentOwedUsd: FieldValue.increment(-payout.amountUsd) });
            }
        }
        if (payout.kind === "overpayment_refund" && payout.repaymentId) {
            txn.update(adminDb().collection(REPAYMENTS).doc(payout.repaymentId), { refundStatus: "refunded" });
        }

        return { ...payout, status: "paid" as const, txSig, paidAt };
    });
}
