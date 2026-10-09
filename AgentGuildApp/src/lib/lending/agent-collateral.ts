/**
 * Post a loan's collateral straight from the borrowing agent's own custodial
 * wallet — one click, instead of sending from a personal wallet and pasting
 * a signature.
 *
 * The server signs exactly `loan.collateral` of the collateral asset from the
 * agent's wallet to the lending treasury, then runs the same on-chain
 * verification as a manual post (postLoanCollateral). The collateral comes
 * back to that same wallet when the loan is repaid. The claim/broadcast/settle
 * rules (money moves at most once per claim; only a definitive answer ends a
 * broadcast send) live in agent-wallet-send.ts.
 */

import { adminDb } from "@/lib/firebase-admin";
import { assetInfo, collateralAssetOf, type LendingAsset } from "./assets";
import { treasuryFor } from "./verify";
import { addLoanCollateral, getLoan, postLoanCollateral } from "./lending-service";
import {
    AgentSendError, agentWalletOptions, claimAndBroadcast, settleAgentSend, shortfallFor, waitThenSettle,
    type AgentSendField, type AgentSendResult, type AgentWalletOption, type Credit,
} from "./agent-wallet-send";
import type { AgentWalletSend, Loan } from "./types";

export type { AgentWalletSend as AgentCollateralSend };
export { AgentSendError as AgentCollateralError, shortfallFor };
export type AgentCollateralWallet = AgentWalletOption;
export type AgentCollateralResult = AgentSendResult;

const LOANS = "loans";
const FIELD: AgentSendField = "agentCollateralSend";

export interface AgentCollateralQuote {
    asset: LendingAsset;
    symbol: string;
    chain: "solana" | "ethereum";
    amount: number;
    treasury: string;
    wallets: AgentWalletOption[];
    send: AgentWalletSend | null;
}

function requireCollateralLoan(loan: Loan | null): Loan {
    if (!loan) throw new AgentSendError("Loan not found", 404);
    if (!(loan.collateral > 0)) throw new AgentSendError("This loan doesn't require collateral");
    return loan;
}

/** What posting from the agent's wallet would take: the amount, the agent's wallets on that chain and whether each can cover it. */
export async function quoteAgentCollateral(loanId: string): Promise<AgentCollateralQuote> {
    const loan = requireCollateralLoan(await getLoan(loanId));
    const asset = collateralAssetOf(loan);
    return {
        asset, symbol: assetInfo(asset).symbol, chain: assetInfo(asset).chain, amount: loan.collateral,
        treasury: treasuryFor(asset), wallets: await agentWalletOptions(loan.borrowerAgentId, asset, loan.collateral),
        send: loan.agentCollateralSend ?? null,
    };
}

const collateralCredit = (loanId: string): Credit => ({
    run: (send) => postLoanCollateral(loanId, send.wallet, send.txSig!),
    returned: (message) => /no longer awaiting collateral/i.test(message),
    alreadyCredited: (loan, send) => loan.collateralTxSig === send.txSig,
    postedMessage: "Collateral posted",
});

/**
 * Verifies an already-broadcast agent-wallet send and posts it as the loan's
 * collateral. Safe to call any number of times; never sends anything.
 */
export function finishAgentCollateral(loanId: string): Promise<AgentSendResult> {
    return settleAgentSend(loanId, FIELD, collateralCredit(loanId), getLoan);
}

/**
 * Sends the loan's collateral from one of the agent's custodial wallets and
 * posts it. If a transfer is already in flight for this loan, this only
 * re-checks it.
 */
export async function postCollateralFromAgentWallet(loanId: string, requestedBy: string, walletId?: string): Promise<AgentSendResult> {
    const loan = requireCollateralLoan(await getLoan(loanId));
    const asset = collateralAssetOf(loan);
    const sent = await claimAndBroadcast({
        loan, field: FIELD, asset, amount: loan.collateral, recipient: treasuryFor(asset), requestedBy, walletId,
        action: "lending.collateral_from_agent_wallet",
        guard: (current) => current.status !== "pending_collateral" || (current.collateralStatus && current.collateralStatus !== "awaiting")
            ? "This loan isn't awaiting collateral"
            : null,
    });
    if (sent.resume) return finishAgentCollateral(loanId);
    return waitThenSettle(sent.broadcast, () => finishAgentCollateral(loanId));
}

/** Loan ids with a broadcast-but-unsettled send in `field`, whatever the loan's status. */
export async function loansWithSentSend(field: AgentSendField): Promise<string[]> {
    const snap = await adminDb().collection(LOANS).where(`${field}.status`, "==", "sent").get();
    return snap.docs.map((d) => d.id);
}

/** Sweep step: settle every loan whose agent-wallet collateral was broadcast but not yet settled. */
export async function finishPendingAgentCollateral(): Promise<{ posted: string[]; errors: string[] }> {
    return settleAll(FIELD, finishAgentCollateral);
}

export async function settleAll(field: AgentSendField, finish: (loanId: string) => Promise<AgentSendResult>): Promise<{ posted: string[]; errors: string[] }> {
    const posted: string[] = [];
    const errors: string[] = [];
    for (const id of await loansWithSentSend(field)) {
        try {
            const r = await finish(id);
            if (r.status === "posted") posted.push(id);
            else if (r.status === "failed") errors.push(`${id}: ${r.message}`);
        } catch (err) {
            errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { posted, errors };
}

// ── Top-ups: add collateral to an active collateral-market loan ─────────────

const TOP_UP: AgentSendField = "agentTopUpSend";

export interface AgentTopUpQuote {
    asset: LendingAsset;
    symbol: string;
    chain: "solana" | "ethereum";
    /** Top-ups must come from the wallet that posted the collateral. */
    postedBy: string | null;
    wallets: AgentWalletOption[];
    send: AgentWalletSend | null;
}

function requireMarketLoan(loan: Loan | null): Loan {
    if (!loan) throw new AgentSendError("Loan not found", 404);
    if (!loan.collateralAsset) throw new AgentSendError("Only collateral-market loans take extra collateral");
    return loan;
}

export async function quoteAgentTopUp(loanId: string, amount: number): Promise<AgentTopUpQuote> {
    const loan = requireMarketLoan(await getLoan(loanId));
    const asset = loan.collateralAsset!;
    const postedBy = loan.collateralPostedByWallet ?? null;
    return {
        asset, symbol: assetInfo(asset).symbol, chain: assetInfo(asset).chain, postedBy,
        wallets: postedBy ? await agentWalletOptions(loan.borrowerAgentId, asset, amount, postedBy) : [],
        send: loan.agentTopUpSend ?? null,
    };
}

export function finishAgentTopUp(loanId: string): Promise<AgentSendResult> {
    return settleAgentSend(loanId, TOP_UP, {
        run: (send) => addLoanCollateral(loanId, send.wallet, send.amount, send.txSig!),
        returned: (message) => /return has been queued/i.test(message),
        alreadyCredited: (loan, send) => !!loan.collateralTopUps?.some((t) => t.txSig === send.txSig),
        postedMessage: "Collateral added",
    }, getLoan);
}

export async function topUpFromAgentWallet(loanId: string, amount: number, requestedBy: string): Promise<AgentSendResult> {
    const loan = requireMarketLoan(await getLoan(loanId));
    if (!loan.collateralPostedByWallet) throw new AgentSendError("This loan's collateral hasn't been posted yet");
    const asset = loan.collateralAsset!;
    const sent = await claimAndBroadcast({
        loan, field: TOP_UP, asset, amount, recipient: treasuryFor(asset), requestedBy,
        onlyAddress: loan.collateralPostedByWallet,
        action: "lending.collateral_top_up_from_agent_wallet",
        guard: (current) => current.status !== "active" ? "Only an active loan takes extra collateral" : null,
    });
    if (sent.resume) return finishAgentTopUp(loanId);
    return waitThenSettle(sent.broadcast, () => finishAgentTopUp(loanId));
}

export function finishPendingAgentTopUps(): Promise<{ posted: string[]; errors: string[] }> {
    return settleAll(TOP_UP, finishAgentTopUp);
}
