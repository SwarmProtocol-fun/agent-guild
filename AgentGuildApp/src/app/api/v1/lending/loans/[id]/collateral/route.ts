/**
 * POST /api/v1/lending/loans/[id]/collateral
 * Body: { txSig: string }
 * A member of the borrowing org posts a trust loan's collateral. They must
 * have already sent exactly `loan.collateral` USDC from their own wallet
 * to the lending treasury (GET /api/v1/lending/treasury); this verifies it
 * on-chain, marks the collateral held, and moves the loan on to funding.
 * The collateral is returned to the same wallet once the loan is repaid.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getLoan, postLoanCollateral } from "@/lib/lending/lending-service";
import { tryAutoDisburse } from "@/lib/lending/auto-disburse";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    let body: { txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the collateral to the treasury first" }, { status: 400 });
    }

    const loan = await getLoan(id);
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });

    const orgAuth = await requireOrgMember(req, loan.borrowerOrgId);
    if (!orgAuth.ok) return orgAuth.status === 401 ? unauthorized(orgAuth.error) : forbidden(orgAuth.error);

    try {
        const updated = await postLoanCollateral(id, orgAuth.walletAddress!, body.txSig);
        return NextResponse.json(await tryAutoDisburse(updated));
    } catch (error) {
        console.error("[lending/loans/collateral] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to post collateral" }, { status: 400 });
    }
}
