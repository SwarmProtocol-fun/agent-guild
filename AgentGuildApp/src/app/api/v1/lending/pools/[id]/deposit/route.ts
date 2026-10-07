/**
 * POST /api/v1/lending/pools/[id]/deposit
 * Body: { amountUsd: number, txSig: string, asset?: "usdc" | "sol" | "eth" }
 * Requires x-wallet-address header. The caller must have already sent
 * `amountUsd` of the pool's asset (USDC, SOL or ETH — despite the field name)
 * on-chain from their own wallet to that asset's treasury
 * (GET /api/v1/lending/treasury) — this verifies that transfer before
 * minting pool shares at the current share price. `asset` is optional; if
 * given it must match the pool's.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized } from "@/lib/auth-guard";
import { confirmPoolDeposit, getPool } from "@/lib/lending/lending-service";
import { assetOf } from "@/lib/lending/assets";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { amountUsd?: number; txSig?: string; asset?: string };
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
        return NextResponse.json({ error: "txSig is required — send the funds on-chain first" }, { status: 400 });
    }
    if (body.asset !== undefined) {
        const pool = await getPool(id);
        if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
        if (body.asset !== assetOf(pool)) {
            return NextResponse.json({ error: `This pool takes ${assetOf(pool).toUpperCase()}, not ${String(body.asset).toUpperCase()}` }, { status: 400 });
        }
    }

    try {
        const result = await confirmPoolDeposit(id, wallet, amountUsd, body.txSig);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[lending/pools/deposit] error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Deposit failed" }, { status: 400 });
    }
}
