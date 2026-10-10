/**
 * Automatic disbursement — small pool loans pay out to the borrowing agent
 * without waiting for an admin.
 *
 * The pool's money stays in the multisig treasury. A separate, server-held
 * payout wallet (one per chain) holds a float the treasury tops up; when a
 * pool loan reaches "pending_disbursement" and its principal is at or under
 * LENDING_AUTO_DISBURSE_MAX_USD, the server sends the principal from that
 * wallet to the borrower and activates the loan with the same on-chain
 * verification an admin confirmation uses. Anything it can't pay — over the
 * per-loan limit, over the day's limit, payout wallet short, lending paused
 * — simply stays in the admin queue; the sweep retries it every run, so a
 * topped-up payout wallet picks the backlog up on its own.
 *
 * The send follows agent-wallet-send.ts's rules (claimed on the loan before
 * broadcast, only a definitive answer ends a broadcast send), with one
 * stricter rule: a claim whose request died before recording a signature is
 * never re-sent automatically — it may have gone out, and this is the
 * platform's money. It surfaces in the sweep's errors for an admin.
 *
 *   LENDING_AUTO_DISBURSE_MAX_USD     per-loan ceiling in USD; unset or 0 = off (every loan goes to an admin)
 *   LENDING_AUTO_DISBURSE_DAILY_USD   total paid automatically per UTC day (default 10 × the per-loan ceiling)
 *   LENDING_PAYOUT_SOLANA_SECRET_KEY  payout wallet for the USDC and SOL pools (base58, or a JSON byte array)
 *   LENDING_PAYOUT_ETH_PRIVATE_KEY    payout wallet for the ETH pool (0x-prefixed hex)
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { auditQuietly } from "@/lib/vault/store";
import { assetOf, type LendingAsset } from "./assets";
import { lendingLimits } from "./config";
import { confirmLoanDisbursement, getLoan } from "./lending-service";
import {
    broadcastEthFrom, broadcastSolanaFrom, readBalances, setSend, settleAgentSend, shortfallFor, waitThenSettle,
    type AgentSendResult, type Broadcast, type Credit,
} from "./agent-wallet-send";
import { loansWithSentSend } from "./agent-collateral";
import type { AgentWalletSend, Loan } from "./types";

const LOANS = "loans";
/** One doc per UTC day: { usd } paid automatically that day. */
const DAILY = "lendingAutoDisburse";
const FIELD = "autoDisburseSend" as const;
const STALE_SENDING_MS = 5 * 60_000;
const PAYOUT_WALLET_ID = "platform-payout";

export interface AutoDisburseConfig {
    /** Per-loan ceiling in USD; null = automatic payouts are off. */
    maxUsd: number | null;
    dailyUsd: number;
}

export function autoDisburseConfig(): AutoDisburseConfig {
    const max = Number(process.env.LENDING_AUTO_DISBURSE_MAX_USD);
    const maxUsd = Number.isFinite(max) && max > 0 ? max : null;
    const daily = Number(process.env.LENDING_AUTO_DISBURSE_DAILY_USD);
    return { maxUsd, dailyUsd: Number.isFinite(daily) && daily > 0 ? daily : (maxUsd ?? 0) * 10 };
}

function solanaPayoutKeypair(): Keypair | null {
    const raw = process.env.LENDING_PAYOUT_SOLANA_SECRET_KEY?.trim();
    if (!raw) return null;
    try {
        return Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
    } catch {
        console.error("[lending/auto-disburse] LENDING_PAYOUT_SOLANA_SECRET_KEY is not a valid Solana secret key");
        return null;
    }
}

function ethPayoutKey(): `0x${string}` | null {
    const raw = process.env.LENDING_PAYOUT_ETH_PRIVATE_KEY?.trim();
    if (!raw) return null;
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
    return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

/** The payout wallet's address for `asset`'s chain, or null when none is configured. */
export function payoutWalletAddress(asset: LendingAsset): string | null {
    if (asset === "eth") {
        const key = ethPayoutKey();
        return key ? privateKeyToAccount(key).address : null;
    }
    return solanaPayoutKeypair()?.publicKey.toBase58() ?? null;
}

/** The loan's principal in USD. Unknown for a non-USDC loan without a recorded USD value, which is never paid automatically. */
export function loanUsdValue(loan: Loan): number | null {
    return assetOf(loan) === "usdc" ? loan.principal : (loan.principalUsdValue ?? null);
}

/**
 * A failed payout may be retried only when nothing can have moved: it never
 * broadcast (or the network dropped it), or the chain says it failed. A send
 * that landed but didn't verify (wrong amount, wrong recipient) is left to an admin.
 */
function retryable(send: AgentWalletSend): boolean {
    return !send.txSig || /failed on-chain|reverted on-chain/i.test(send.error ?? "");
}

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export type AutoDisburseResult = AgentSendResult | { status: "skipped"; reason: string };

class Skip extends Error {}

const disburseCredit = (loanId: string): Credit => ({
    run: (send) => confirmLoanDisbursement(loanId, send.txSig!, { fromWallet: send.wallet }),
    // Someone else activated or closed the loan while this payout was in flight — an admin must reconcile.
    returned: (message) => /not awaiting disbursement/i.test(message),
    alreadyCredited: (loan, send) => loan.disbursementTxSig === send.txSig,
    postedMessage: "Loan paid out to the agent",
});

/** Verify an already-broadcast payout and activate the loan. Never sends anything. */
export function finishAutoDisburse(loanId: string): Promise<AgentSendResult> {
    return settleAgentSend(loanId, FIELD, disburseCredit(loanId), getLoan);
}

/**
 * Pay a pool loan out from the platform payout wallet if it qualifies.
 * Returns "skipped" with the reason when it stays in the admin queue.
 * With `wait`, waits briefly for Solana finality and activates the loan in
 * the same call; otherwise the next check (or sweep) does.
 */
export async function autoDisburseLoan(loanId: string, opts: { wait?: boolean } = {}): Promise<AutoDisburseResult> {
    const loan = await getLoan(loanId);
    if (!loan) return { status: "skipped", reason: "Loan not found" };
    if (loan.status !== "pending_disbursement" || loan.source !== "pool") return { status: "skipped", reason: `Loan is ${loan.status}` };
    if (!loan.borrowerWalletAddress) return { status: "skipped", reason: "Borrower has no wallet address on file" };

    const prior = loan[FIELD];
    if (prior?.status === "sent") return finishAutoDisburse(loanId);
    if (prior?.status === "sending") {
        return { status: "skipped", reason: Date.now() - prior.startedAt < STALE_SENDING_MS
            ? "A payout is already in progress"
            : "A payout started but never recorded its transaction — check the payout wallet's history before paying by hand" };
    }
    if (prior?.status === "returned") return { status: "skipped", reason: prior.error ?? "An earlier payout needs an admin to reconcile" };
    if (prior?.status === "failed" && !retryable(prior)) {
        return { status: "skipped", reason: `An earlier payout needs an admin to reconcile: ${prior.error ?? "verification failed"}` };
    }

    const config = autoDisburseConfig();
    if (config.maxUsd == null) return { status: "skipped", reason: "Automatic payouts are off" };
    if (lendingLimits().paused) return { status: "skipped", reason: "Lending is paused" };
    const usd = loanUsdValue(loan);
    if (usd == null) return { status: "skipped", reason: "Loan has no recorded USD value" };
    if (usd > config.maxUsd) return { status: "skipped", reason: `Over the $${config.maxUsd.toLocaleString()} automatic payout limit` };

    const asset = assetOf(loan);
    const from = payoutWalletAddress(asset);
    if (!from) return { status: "skipped", reason: `No ${asset === "eth" ? "Ethereum" : "Solana"} payout wallet is configured` };
    const { balance, feeBalance } = await readBalances(from, asset);
    const short = shortfallFor(asset, loan.principal, balance, feeBalance);
    if (short) return { status: "skipped", reason: `Payout wallet: ${short}` };

    const recipient = loan.borrowerWalletAddress;
    const loanRef = adminDb().collection(LOANS).doc(loanId);
    const dayRef = adminDb().collection(DAILY).doc(utcDay());
    try {
        await adminDb().runTransaction(async (txn) => {
            const [snap, day] = await Promise.all([txn.get(loanRef), txn.get(dayRef)]);
            if (!snap.exists) throw new Skip("Loan not found");
            const current = snap.data() as Loan;
            if (current.status !== "pending_disbursement") throw new Skip(`Loan is ${current.status}`);
            const send = current[FIELD];
            if (send && !(send.status === "failed" && retryable(send))) throw new Skip("A payout is already in progress");
            const usedToday = Number(day.exists ? day.data()?.usd : 0) || 0;
            if (usedToday + usd > config.dailyUsd) throw new Skip(`Today's automatic payout limit ($${config.dailyUsd.toLocaleString()}) is used up`);
            const claim: AgentWalletSend = {
                walletId: PAYOUT_WALLET_ID, wallet: from, asset, amount: loan.principal, recipient, txSig: null,
                status: "sending", startedAt: Date.now(), requestedBy: "auto-disburse", error: null,
            };
            txn.update(loanRef, { [FIELD]: claim });
            txn.set(dayRef, { usd: FieldValue.increment(usd) }, { merge: true });
        });
    } catch (err) {
        if (err instanceof Skip) return { status: "skipped", reason: err.message };
        throw err;
    }

    let broadcast: Broadcast;
    try {
        if (asset === "eth") {
            broadcast = await broadcastEthFrom(ethPayoutKey()!, loan.principal, recipient);
        } else {
            broadcast = await broadcastSolanaFrom(solanaPayoutKeypair()!, asset, loan.principal, recipient);
        }
    } catch (err) {
        // Nothing was broadcast, so nothing moved: release the claim and the day's allowance.
        const message = err instanceof Error ? err.message : String(err);
        await setSend(loanId, FIELD, { status: "failed", error: message.slice(0, 500) });
        await dayRef.set({ usd: FieldValue.increment(-usd) }, { merge: true });
        return { status: "failed", txSig: null, loan, message: `Automatic payout failed: ${message}` };
    }
    await setSend(loanId, FIELD, { status: "sent", txSig: broadcast.sig, sentAt: Date.now() });
    auditQuietly({
        orgId: loan.borrowerOrgId, action: "lending.auto_disburse", actorType: "user", actorId: "auto-disburse", target: loanId,
        detail: { agentId: loan.borrowerAgentId, wallet: from, asset, amount: loan.principal, usd, recipient, txSig: broadcast.sig },
    });
    return opts.wait ? waitThenSettle(broadcast, () => finishAutoDisburse(loanId)) : finishAutoDisburse(loanId);
}

/**
 * Best-effort hook for request handlers: try to pay out a loan that just
 * reached "pending_disbursement". Never throws — a loan it can't pay stays
 * in the admin queue. Returns the loan as it now stands.
 */
export async function tryAutoDisburse(loan: Loan): Promise<{ loan: Loan; autoDisburse: AutoDisburseResult | null }> {
    if (loan.status !== "pending_disbursement") return { loan, autoDisburse: null };
    try {
        const result = await autoDisburseLoan(loan.id, { wait: true });
        return { loan: (await getLoan(loan.id)) ?? loan, autoDisburse: result };
    } catch (err) {
        console.error("[lending/auto-disburse]", loan.id, err);
        return { loan, autoDisburse: { status: "skipped", reason: err instanceof Error ? err.message : String(err) } };
    }
}

/**
 * Sweep step: settle payouts already broadcast, then try every loan still
 * awaiting disbursement. Routine skips (over the limit, wallet short) are not
 * errors; a payout stuck without a recorded transaction is.
 */
export async function autoDisbursePending(): Promise<{ posted: string[]; errors: string[] }> {
    const posted: string[] = [];
    const errors: string[] = [];
    const settled = new Set<string>();
    for (const id of await loansWithSentSend(FIELD)) {
        settled.add(id);
        try {
            const r = await finishAutoDisburse(id);
            if (r.status === "posted") posted.push(id);
            else if (r.status === "failed") errors.push(`${id}: ${r.message}`);
        } catch (err) {
            errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (autoDisburseConfig().maxUsd == null) return { posted, errors };

    const pending = await adminDb().collection(LOANS).where("status", "==", "pending_disbursement").get();
    for (const doc of pending.docs) {
        if (settled.has(doc.id)) continue;
        try {
            const r = await autoDisburseLoan(doc.id);
            if (r.status === "posted") posted.push(doc.id);
            else if (r.status === "failed") errors.push(`${doc.id}: ${r.message}`);
            else if (r.status === "skipped" && /never recorded its transaction|needs an admin/.test(r.reason)) errors.push(`${doc.id}: ${r.reason}`);
        } catch (err) {
            errors.push(`${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { posted, errors };
}
