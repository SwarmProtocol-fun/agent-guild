/**
 * Repay a loan straight from the borrowing agent's custodial wallet — one
 * click instead of sending from a personal wallet and pasting a signature.
 * The server sends the amount in the loan's asset to whoever is owed (the
 * treasury for pool loans, the lender for solo loans) and applies it with the
 * same verification as a manual repayment (repayLoan). One repayment can be
 * in flight per loan; see agent-wallet-send.ts for the send rules.
 */

import { assetInfo, assetOf, type LendingAsset } from "./assets";
import { treasuryFor } from "./verify";
import { getLoan, listRepaymentsForLoan, repayLoan } from "./lending-service";
import {
    AgentSendError, agentWalletOptions, claimAndBroadcast, settleAgentSend, waitThenSettle,
    type AgentSendField, type AgentSendResult, type AgentWalletOption,
} from "./agent-wallet-send";
import { settleAll } from "./agent-collateral";
import type { AgentWalletSend, Loan } from "./types";

const FIELD: AgentSendField = "agentRepaySend";

export interface AgentRepayQuote {
    asset: LendingAsset;
    symbol: string;
    chain: "solana" | "ethereum";
    recipient: string;
    wallets: AgentWalletOption[];
    send: AgentWalletSend | null;
}

function recipientFor(loan: Loan): string {
    const recipient = loan.source === "pool" ? treasuryFor(assetOf(loan)) : loan.lenderWalletAddress;
    if (!recipient) throw new AgentSendError("No lender wallet on file to repay");
    return recipient;
}

function requireActive(loan: Loan | null): Loan {
    if (!loan) throw new AgentSendError("Loan not found", 404);
    if (loan.status !== "active") throw new AgentSendError(`Only an active loan can be repaid (status: ${loan.status})`);
    return loan;
}

export async function quoteAgentRepay(loanId: string, amount: number): Promise<AgentRepayQuote> {
    const loan = await getLoan(loanId);
    if (!loan) throw new AgentSendError("Loan not found", 404);
    const asset = assetOf(loan);
    return {
        asset, symbol: assetInfo(asset).symbol, chain: assetInfo(asset).chain,
        recipient: loan.status === "active" ? recipientFor(loan) : "",
        wallets: await agentWalletOptions(loan.borrowerAgentId, asset, amount),
        send: loan.agentRepaySend ?? null,
    };
}

export function finishAgentRepay(loanId: string): Promise<AgentSendResult> {
    return settleAgentSend(loanId, FIELD, {
        run: async (send) => (await repayLoan(loanId, send.amount, send.wallet, send.txSig!)).loan,
        // repayLoan queues a full refund when the loan closed before the money landed.
        returned: (message) => /full refund has been queued/i.test(message),
        alreadyCredited: async (_loan, send) => !!send.txSig && (await listRepaymentsForLoan(loanId)).some((r) => r.txSig === send.txSig),
        postedMessage: "Payment applied",
    }, getLoan);
}

export async function repayFromAgentWallet(loanId: string, amount: number, requestedBy: string, walletId?: string): Promise<AgentSendResult> {
    const loan = requireActive(await getLoan(loanId));
    const sent = await claimAndBroadcast({
        loan, field: FIELD, asset: assetOf(loan), amount, recipient: recipientFor(loan), requestedBy, walletId,
        action: "lending.repay_from_agent_wallet",
        guard: (current) => current.status !== "active" ? `Only an active loan can be repaid (status: ${current.status})` : null,
    });
    if (sent.resume) return finishAgentRepay(loanId);
    return waitThenSettle(sent.broadcast, () => finishAgentRepay(loanId));
}

export function finishPendingAgentRepays(): Promise<{ posted: string[]; errors: string[] }> {
    return settleAll(FIELD, finishAgentRepay);
}
