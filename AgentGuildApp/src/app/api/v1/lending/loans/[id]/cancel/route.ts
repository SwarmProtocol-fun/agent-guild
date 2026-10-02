/**
 * POST /api/v1/lending/loans/[id]/cancel
 * Cancels a loan that was never funded, releasing any pool liquidity it
 * reserved and queueing posted collateral back to the borrower. Borrowing org
 * members can cancel while the loan is still awaiting collateral; once it's
 * open to lenders or awaiting a treasury disbursement, only a platform admin
 * can (someone may already be sending funds).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, requirePlatformAdmin, unauthorized, forbidden } from "@/lib/auth-guard";
import { cancelLoan, getLoan } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const loan = await getLoan(id);
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) {
        const orgAuth = await requireOrgMember(req, loan.borrowerOrgId);
        if (!orgAuth.ok) return orgAuth.status === 401 ? unauthorized(orgAuth.error) : forbidden(orgAuth.error);
    }

    try {
        const cancelled = await cancelLoan(id, {
            byAdmin: admin.ok,
            reason: admin.ok ? "Cancelled by platform admin" : "Cancelled by borrower",
        });
        return NextResponse.json({ loan: cancelled });
    } catch (error) {
        console.error("[lending/loans/cancel] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to cancel loan" }, { status: 400 });
    }
}
