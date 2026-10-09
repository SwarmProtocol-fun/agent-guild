/**
 * Repay a loan from the borrowing agent's own wallet.
 *
 * GET  ?amount= — the agent's wallets in the loan's asset, with balances and
 *      whether each can cover `amount`, and who gets paid.
 * POST { amount, walletId?, check? } — send `amount` from that wallet (or the
 *      first that can cover it) to the treasury (pool loans) or the lender
 *      (solo loans) and apply it. `check: true` only re-verifies a transfer
 *      already sent. One repayment can be in flight per loan.
 *
 * Members of the borrowing org only, the same rule as repaying by hand.
 */
import { NextRequest, NextResponse } from "next/server";
import { finishAgentRepay, quoteAgentRepay, repayFromAgentWallet } from "@/lib/lending/agent-repay";
import { agentSendErrorResponse, authorizeLoanMember, positiveAmount } from "@/lib/lending/agent-wallet-route";

type Ctx = { params: Promise<{ id: string }> };
const TAG = "lending/repay/agent-wallet";

export async function GET(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorizeLoanMember(req, id);
    if ("error" in auth) return auth.error;
    try {
        return NextResponse.json(await quoteAgentRepay(id, positiveAmount(req.nextUrl.searchParams.get("amount")) ?? 0));
    } catch (err) {
        return agentSendErrorResponse(err, TAG, "Failed to read the agent's wallets");
    }
}

export async function POST(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorizeLoanMember(req, id);
    if ("error" in auth) return auth.error;
    const body = (await req.json().catch(() => ({}))) as { amount?: unknown; walletId?: unknown; check?: unknown };
    try {
        if (body.check === true) {
            const result = await finishAgentRepay(id);
            return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
        }
        const amount = positiveAmount(body.amount);
        if (amount === null) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
        const result = await repayFromAgentWallet(id, amount, auth.wallet, typeof body.walletId === "string" ? body.walletId : undefined);
        return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
    } catch (err) {
        return agentSendErrorResponse(err, TAG, "Failed to repay from the agent's wallet");
    }
}
