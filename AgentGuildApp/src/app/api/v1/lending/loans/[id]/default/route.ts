/**
 * POST /api/v1/lending/loans/[id]/default
 * Platform admin only. Force-closes an overdue active loan into "defaulted",
 * writes off the remaining principal against the pool (collateral is not
 * actually collected, so nothing is recovered), and applies the credit score
 * penalty. There is no cron sweep for overdue loans in this codebase — this is
 * the only way a loan becomes defaulted.
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
