/**
 * POST /api/v1/lending/loans/[id]/default
 * Platform admin only. Closes an overdue active loan as "defaulted": held
 * collateral is applied to the balance and the rest is written off against
 * the pool (see markLoanDefaulted). A collateral-market loan is moved to
 * "liquidating" instead. The hourly sweep does the same after the grace period.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { markLoanDefaulted } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    try {
        const loan = await markLoanDefaulted(id);
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/default] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to mark loan defaulted" }, { status: 400 });
    }
}
