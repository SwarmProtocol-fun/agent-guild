/**
 * POST /api/v1/lending/pools/withdrawals/[requestId]/confirm
 * Platform admin only. Body: { txSig }.
 * The admin must have already sent the locked-in amount from the treasury
 * (GET /api/v1/lending/treasury) to the lender's wallet by hand. This verifies
 * that transfer on-chain, then burns the shares.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { confirmPoolWithdrawal } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
    const { requestId } = await params;

    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    let body: { txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required" }, { status: 400 });
    }

    try {
        const result = await confirmPoolWithdrawal(requestId, body.txSig);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[lending/pools/withdrawals/confirm] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to confirm withdrawal" }, { status: 400 });
    }
}
