/**
 * POST /api/cron/polymarket-whales
 *
 * Rebuilds the near-liquidation bot's watch list: the largest Hyperliquid
 * accounts (from the ~40 MB public leaderboard) that hold BTC right now. Too
 * heavy for the minute tick, so it runs on its own schedule.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/polymarket-whales.mts (every 6 hours) or manual.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { refreshPolymarketWhales } from "../../../../../mods/polymarket-trading/server";

export const maxDuration = 26;

export async function POST(req: NextRequest) {
    if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
        return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
    }

    try {
        const result = await refreshPolymarketWhales();
        console.log(`[polymarket-whales] ${JSON.stringify(result)}`);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[polymarket-whales] Fatal error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Refresh failed" }, { status: 500 });
    }
}
