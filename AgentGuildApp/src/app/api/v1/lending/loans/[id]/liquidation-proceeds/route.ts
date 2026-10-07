/**
 * POST /api/v1/lending/loans/[id]/liquidation-proceeds
 * Body: { amount: number, txSig: string }
 * Platform admin only. After selling a liquidating loan's seized collateral,
 * send the proceeds (in the loan's asset) to the treasury and record them
 * here: the transfer is verified on-chain (any sender — an exchange
 * withdrawal or a swap inside the treasury), then applied to principal and
 * interest; a shortfall is written off, a surplus is queued to the borrower.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { settleLiquidation } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    let body: { amount?: number; txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the proceeds to the treasury first" }, { status: 400 });
    }

    try {
        const loan = await settleLiquidation(id, amount, body.txSig);
        return NextResponse.json({ loan });
    } catch (error) {
        console.error("[lending/loans/liquidation-proceeds] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to record liquidation proceeds" }, { status: 400 });
    }
}
