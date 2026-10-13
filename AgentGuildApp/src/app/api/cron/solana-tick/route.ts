/**
 * POST /api/cron/solana-tick
 *
 * One minute of the Solana mod working for agents that aren't running:
 * fills standing paper orders whose price trigger fired, fires price and
 * address-activity watches, and confirms Solana Pay requests on-chain.
 * Results land in each agent's alerts. A Firestore lock makes overlapping
 * calls (this scheduler plus the hub tick) a no-op.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/solana-tick.mts (every minute) or manual.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { runSolanaTick } from "../../../../../mods/solana-settlement/server";

export const maxDuration = 26;

export async function POST(req: NextRequest) {
    if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
        return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
    }

    try {
        const result = await runSolanaTick();
        console.log(`[solana-tick] ${JSON.stringify(result)}`);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[solana-tick] Fatal error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Tick failed" }, { status: 500 });
    }
}
