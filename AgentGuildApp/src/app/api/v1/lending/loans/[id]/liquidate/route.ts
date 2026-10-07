/**
 * POST /api/v1/lending/loans/[id]/liquidate
 * Platform admin only. Starts liquidating an active collateral-market loan
 * now (the sweep does this automatically once its loan-to-value reaches the
 * market's threshold): the collateral is seized for sale and interest stops.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { startLiquidation } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    try {
        const loan = await startLiquidation(id, "admin");
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/liquidate] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to start liquidation" }, { status: 400 });
    }
}
