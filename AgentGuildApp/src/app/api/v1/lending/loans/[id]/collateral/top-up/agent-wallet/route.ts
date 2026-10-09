/**
 * Add collateral to an active collateral-market loan from the borrowing
 * agent's own wallet — the one that posted the original collateral.
 *
 * GET  ?amount= — that wallet's balance and whether it can cover `amount`.
 * POST { amount, check? } — send `amount` to the treasury and add it to the
 *      loan. `check: true` only re-verifies a transfer already sent.
 *
 * Members of the borrowing org only.
 */
import { NextRequest, NextResponse } from "next/server";
import { finishAgentTopUp, quoteAgentTopUp, topUpFromAgentWallet } from "@/lib/lending/agent-collateral";
import { agentSendErrorResponse, authorizeLoanMember, positiveAmount } from "@/lib/lending/agent-wallet-route";

type Ctx = { params: Promise<{ id: string }> };
const TAG = "lending/collateral/top-up/agent-wallet";

export async function GET(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorizeLoanMember(req, id);
    if ("error" in auth) return auth.error;
    try {
        return NextResponse.json(await quoteAgentTopUp(id, positiveAmount(req.nextUrl.searchParams.get("amount")) ?? 0));
    } catch (err) {
        return agentSendErrorResponse(err, TAG, "Failed to read the agent's wallet");
    }
}

export async function POST(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorizeLoanMember(req, id);
    if ("error" in auth) return auth.error;
    const body = (await req.json().catch(() => ({}))) as { amount?: unknown; check?: unknown };
    try {
        if (body.check === true) {
            const result = await finishAgentTopUp(id);
            return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
        }
        const amount = positiveAmount(body.amount);
        if (amount === null) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
        const result = await topUpFromAgentWallet(id, amount, auth.wallet);
        return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
    } catch (err) {
        return agentSendErrorResponse(err, TAG, "Failed to add collateral from the agent's wallet");
    }
}
