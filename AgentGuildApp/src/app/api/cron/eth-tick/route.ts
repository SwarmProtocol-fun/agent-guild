/**
 * POST /api/cron/eth-tick
 *
 * One minute of the Ethereum mod working for agents that aren't running:
 * fills standing paper orders whose price trigger fired, fires price,
 * address and contract-event watches, and confirms EIP-681 payment
 * requests on-chain.
 * Results land in each agent's alerts. A Firestore lock makes overlapping
 * calls (this scheduler plus the hub tick) a no-op.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/eth-tick.mts (every minute) or manual.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { runEthTick } from "../../../../../mods/ethereum/server";

export const maxDuration = 26;

export async function POST(req: NextRequest) {
    if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
        return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
    }

    try {
        const result = await runEthTick();
        console.log(`[eth-tick] ${JSON.stringify(result)}`);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[eth-tick] Fatal error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Tick failed" }, { status: 500 });
    }
}
