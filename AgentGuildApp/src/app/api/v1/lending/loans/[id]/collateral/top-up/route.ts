/**
 * POST /api/v1/lending/loans/[id]/collateral/top-up
 * Body: { amount: number, txSig: string }
 * A member of the borrowing org adds collateral to an active collateral-market
 * loan, lowering its loan-to-value. They must already have sent `amount` of
 * the collateral asset to the treasury from the wallet that posted the
 * original collateral; this verifies it and adds it to the loan. It's
 * returned with the rest of the collateral when the loan is repaid.
 */
import { NextRequest, NextResponse } from "next/server";
import { addLoanCollateral } from "@/lib/lending/lending-service";
import { authorizeLoanMember, positiveAmount } from "@/lib/lending/agent-wallet-route";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { amount?: unknown; txSig?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const amount = positiveAmount(body.amount);
    if (amount === null) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the collateral to the treasury first" }, { status: 400 });
    }

    const auth = await authorizeLoanMember(req, id);
    if ("error" in auth) return auth.error;

    try {
        return NextResponse.json({ loan: await addLoanCollateral(id, auth.wallet, amount, body.txSig) });
    } catch (error) {
        console.error("[lending/loans/collateral/top-up] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to add collateral" }, { status: 400 });
    }
}
