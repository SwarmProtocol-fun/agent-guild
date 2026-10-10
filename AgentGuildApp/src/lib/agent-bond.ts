/**
 * Anti-sybil bond — a refundable USDC deposit per ASN (agent-standing.ts
 * agentBondUsd). An agent can't leave the provisional tier without one, a
 * loan default or fraud penalty slashes it (dropping the agent back to
 * provisional), and retiring a clean ASN refunds it through the lending
 * payout queue. Every new identity costs real money that a bad actor loses.
 *
 * The bond goes to the lending USDC treasury and is verified on-chain with
 * the same read-only verifier and replay guard as lending deposits — no
 * signing key is held here.
 */

import { adminDb } from "@/lib/firebase-admin";
import { verifyUsdcTransfer, claimUsdcTransferInTxn, treasuryAddress, type VerifyTransferInput } from "@/lib/solana/lending-verify";
import { createPayoutInTxn } from "@/lib/lending/payouts";
import { agentBondUsd, toMillis, type AgentBond } from "@/lib/agent-standing";

const AGENTS = "agents";
const LOANS = "loans";
/** A bond must sit this long before it can be refunded — covers a loan's default window. */
export const BOND_MIN_HOLD_DAYS = 30;
const OPEN_LOAN_STATUSES = ["pending_collateral", "pending", "pending_disbursement", "active", "liquidating", "defaulted"];

/** Pure: why this bond can't be refunded right now, or null if it can. */
export function bondRefundBlocker(
    agent: { bond?: AgentBond | null; riskFlags?: string[]; retiredAt?: unknown },
    openLoanCount: number,
    nowMs: number = Date.now(),
): string | null {
    const bond = agent.bond;
    if (!bond || bond.status !== "posted") return bond?.status === "slashed" ? "This bond was slashed" : "No posted bond to refund";
    if (agent.retiredAt != null) return "Agent is already retired";
    const heldDays = (nowMs - (toMillis(bond.postedAt) ?? nowMs)) / 86_400_000;
    if (heldDays < BOND_MIN_HOLD_DAYS) return `Bonds are held at least ${BOND_MIN_HOLD_DAYS} days (${Math.floor(heldDays)} so far)`;
    if (openLoanCount > 0) return "Close or repay this agent's open loans first";
    if ((agent.riskFlags ?? []).length > 0) return "Open risk flags must be resolved before the bond is refunded";
    return null;
}

export async function postBond(agentId: string, input: { txSig: string; fromWallet: string }): Promise<AgentBond> {
    const amountUsd = agentBondUsd();
    if (amountUsd <= 0) throw new Error("Agent bonds are disabled");
    const agentRef = adminDb().collection(AGENTS).doc(agentId);

    const pre = await agentRef.get();
    if (!pre.exists) throw new Error("Agent not found");
    const current = pre.data()!.bond as AgentBond | undefined;
    if (current?.status === "posted" || current?.status === "refund_pending") throw new Error("This agent already has a bond");
    if (pre.data()!.retiredAt != null) throw new Error("Agent is retired");

    const transfer: VerifyTransferInput = {
        txSig: input.txSig.trim(),
        expectedFromWallet: input.fromWallet,
        expectedToWallet: treasuryAddress(),
        expectedAmount: amountUsd,
        purpose: "agent_bond",
        refId: agentId,
    };
    await verifyUsdcTransfer(transfer);

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(agentRef);
        const latest = snap.data()?.bond as AgentBond | undefined;
        if (latest?.status === "posted" || latest?.status === "refund_pending") throw new Error("This agent already has a bond");
        claimUsdcTransferInTxn(txn, transfer);
        const bond: AgentBond = {
            status: "posted",
            amountUsd,
            postedByWallet: input.fromWallet,
            txSig: transfer.txSig,
            postedAt: Date.now(),
        };
        txn.update(agentRef, { bond });
        return bond;
    });
}

/** Forfeit a posted bond. No-op (false) when there's nothing to slash. Never throws. */
export async function slashBond(agentId: string, reason: string): Promise<boolean> {
    try {
        const agentRef = adminDb().collection(AGENTS).doc(agentId);
        return await adminDb().runTransaction(async (txn) => {
            const snap = await txn.get(agentRef);
            const bond = snap.data()?.bond as AgentBond | undefined;
            if (!bond || bond.status !== "posted") return false;
            txn.update(agentRef, {
                "bond.status": "slashed",
                "bond.slashedAt": Date.now(),
                "bond.slashReason": reason.slice(0, 200),
            });
            return true;
        });
    } catch (err) {
        console.error(`[agent-bond] slash failed for ${agentId}:`, err);
        return false;
    }
}

/**
 * Retire the ASN and queue its bond back to whoever posted it. Retirement is
 * the price of the refund: the identity stops counting toward the owner's
 * quota and can't reconnect, so a bond can't be recycled across live agents.
 */
export async function requestBondRefund(agentId: string): Promise<{ payoutId: string | null; bond: AgentBond }> {
    const agentRef = adminDb().collection(AGENTS).doc(agentId);
    const openLoans = await adminDb().collection(LOANS)
        .where("borrowerAgentId", "==", agentId)
        .where("status", "in", OPEN_LOAN_STATUSES)
        .get();

    return adminDb().runTransaction(async (txn) => {
        const snap = await txn.get(agentRef);
        if (!snap.exists) throw new Error("Agent not found");
        const data = snap.data()!;
        const blocker = bondRefundBlocker(data, openLoans.size);
        if (blocker) throw new Error(blocker);
        const bond = data.bond as AgentBond;

        const payoutId = createPayoutInTxn(txn, {
            kind: "bond_refund",
            fromWallet: treasuryAddress(),
            toWallet: bond.postedByWallet,
            amount: bond.amountUsd,
            agentId,
            reason: `Anti-sybil bond refund for retired agent ${data.name || agentId} (${data.asn || "no ASN"})`,
        });
        const now = Date.now();
        txn.update(agentRef, {
            "bond.status": "refund_pending",
            "bond.refundRequestedAt": now,
            ...(payoutId ? { "bond.refundPayoutId": payoutId } : {}),
            retiredAt: now,
            status: "offline",
        });
        return { payoutId, bond: { ...bond, status: "refund_pending" as const, refundRequestedAt: now } };
    });
}
