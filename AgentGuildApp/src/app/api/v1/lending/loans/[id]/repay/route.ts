/**
 * POST /api/v1/lending/loans/[id]/repay
 * Body: { amount: number, txSig: string }
 * Only a member of the borrowing org can repay, and must have already sent
 * `amount` USDC on-chain from their own wallet to the lender (the treasury
 * for pool loans, the solo lender's wallet for solo loans). Verifies that
 * transfer, then accrues interest to now and applies the payment (interest
 * first, then principal), closing the loan out as repaid if the payment
 * clears the balance. A late partial payment keeps the loan active; anything
 * sent beyond the balance is recorded as owed back to the borrower.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getLoan, repayLoan } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    let body: { amount?: number; /** @deprecated use `amount` */ amountUsd?: number; txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const amount = Number(body.amount ?? body.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the USDC on-chain first" }, { status: 400 });
    }

    const loan = await getLoan(id);
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });

    const orgAuth = await requireOrgMember(req, loan.borrowerOrgId);
    if (!orgAuth.ok) return orgAuth.status === 401 ? unauthorized(orgAuth.error) : forbidden(orgAuth.error);

    try {
        const result = await repayLoan(id, amount, orgAuth.walletAddress!, body.txSig);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[lending/loans/repay] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Repayment failed" }, { status: 400 });
    }
}
