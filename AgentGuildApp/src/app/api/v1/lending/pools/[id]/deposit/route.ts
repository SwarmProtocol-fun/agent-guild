/**
 * POST /api/v1/lending/pools/[id]/deposit
 * Body: { amountUsd: number, txSig: string }
 * Requires x-wallet-address header. The caller must have already sent
 * `amountUsd` USDC on-chain from their own wallet to the lending treasury
 * (GET /api/v1/lending/treasury) — this verifies that transfer before
 * minting pool shares at the current share price.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { confirmPoolDeposit } from "@/lib/lending/lending-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { amountUsd?: number; txSig?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const amountUsd = Number(body.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return NextResponse.json({ error: "amountUsd must be a positive number" }, { status: 400 });
    }
    if (!body.txSig || typeof body.txSig !== "string") {
        return NextResponse.json({ error: "txSig is required — send the USDC on-chain first" }, { status: 400 });
    }

    try {
        const result = await confirmPoolDeposit(id, wallet, amountUsd, body.txSig);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[lending/pools/deposit] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Deposit failed" }, { status: 400 });
    }
}
