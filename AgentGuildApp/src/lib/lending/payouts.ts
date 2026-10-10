/**
 * Lending payouts — every money movement the ledger owes but can't execute
 * itself: collateral returns, seized collateral owed to a solo lender,
 * overpayment refunds, and refunds for transfers that landed after the thing
 * they were meant for had moved on (a deposit over the beta cap, a duplicate
 * solo funding, a repayment to a closed loan).
 *
 * Payouts are created inside the same Firestore transaction as the ledger
 * change that owes them, so an obligation is never recorded without its
 * cause or vice versa. Whoever controls `fromWallet` sends the funds and
 * confirms with the signature — verified on-chain like every other lending
 * transfer before the payout is marked paid.
 *
 * Collection: lendingPayouts.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyLendingTransfer, claimLendingTransferInTxn, treasuryFor, normalizeTxSig, type VerifyTransferInput } from "./verify";
import { assetOf, assetInfo, roundAmount } from "./assets";
import type { LendingPayout, Loan } from "./types";
import { normalizeLegacy, healLegacyInTxn } from "./legacy-fields";

const PAYOUTS = "lendingPayouts";
const LOANS = "loans";
const REPAYMENTS = "loanRepayments";

const nowSec = () => Math.floor(Date.now() / 1000);

export type NewPayout = Omit<LendingPayout, "id" | "status" | "createdAt" | "paidAt" | "txSig">;

/** Queue a payout as part of the caller's transaction. Returns its id. Skips dust (see assets.ts). */
export function createPayoutInTxn(txn: FirebaseFirestore.Transaction, payout: NewPayout): string | null {
    const asset = assetOf(payout);
    if (!(payout.amount >= assetInfo(asset).dust)) return null;
    const ref = adminDb().collection(PAYOUTS).doc();
    const doc: Omit<LendingPayout, "id"> = {
        ...payout,
        asset: asset === "usdc" ? undefined : asset,
        amount: roundAmount(asset, payout.amount),
        status: "pending",
        createdAt: nowSec(),
    };
    txn.set(ref, Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));
    return ref.id;
}

function toPayout(id: string, data: FirebaseFirestore.DocumentData): LendingPayout {
    return { id, ...normalizeLegacy("lendingPayouts", data) } as LendingPayout;
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
        treasury = treasuryFor(assetOf(payout));
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

    const asset = assetOf(existing);
    txSig = normalizeTxSig(asset, txSig);
    const transfer: VerifyTransferInput = {
        txSig,
        expectedFromWallet: existing.fromWallet,
        expectedToWallet: existing.toWallet,
        expectedAmount: existing.amount,
        purpose: `payout_${existing.kind}`,
        refId: payoutId,
    };
    await verifyLendingTransfer(asset, transfer);

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(payoutRef);
        if (!snap.exists) throw new Error("Payout not found");
        const payout = toPayout(snap.id, snap.data()!);
        if (payout.status !== "pending") throw new Error("Payout is already paid");

        const loanRef = payout.loanId ? adminDb().collection(LOANS).doc(payout.loanId) : null;
        const loanSnap = loanRef ? await txn.get(loanRef) : null;
        const loan = loanSnap?.exists ? (normalizeLegacy("loans", loanSnap.data()!) as Loan) : null;
        if (loanRef && loanSnap?.exists) healLegacyInTxn(txn, loanRef, "loans", loanSnap.data());

        claimLendingTransferInTxn(asset, txn, transfer);

        const paidAt = nowSec();
        txn.update(payoutRef, { status: "paid", txSig, paidAt });

        if (loanRef && loan) {
            if (payout.kind === "collateral_return" && loan.collateralStatus === "return_pending") {
                txn.update(loanRef, { collateralStatus: "returned" });
            }
            if (payout.kind === "overpayment_refund" && payout.repaymentId) {
                txn.update(loanRef, { overpaymentOwed: FieldValue.increment(-payout.amount) });
            }
        }
        if (payout.kind === "overpayment_refund" && payout.repaymentId) {
            txn.update(adminDb().collection(REPAYMENTS).doc(payout.repaymentId), { refundStatus: "refunded" });
        }
        if (payout.kind === "bond_refund" && payout.agentId) {
            txn.update(adminDb().collection("agents").doc(payout.agentId), { "bond.status": "refunded" });
        }

        return { ...payout, status: "paid" as const, txSig, paidAt };
    });
}
