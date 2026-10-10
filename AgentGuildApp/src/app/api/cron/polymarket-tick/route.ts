/**
 * POST /api/cron/polymarket-tick
 *
 * One minute of the Polymarket mod: fills resting paper orders from the real
 * trade tape, pays out resolved paper positions (winners $1/share), and runs
 * every enabled bot. A Firestore lock makes overlapping calls (this scheduler
 * plus the hub tick) a no-op instead of a double entry.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/polymarket-tick.mts (every minute) or manual.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { runPolymarketTick } from "../../../../../mods/polymarket-trading/server";

export const maxDuration = 26;

export async function POST(req: NextRequest) {
    if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
        return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
    }

    try {
        const result = await runPolymarketTick();
        console.log(`[polymarket-tick] ${JSON.stringify(result)}`);
        return NextResponse.json(result);
    } catch (error) {
        console.error("[polymarket-tick] Fatal error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Tick failed" }, { status: 500 });
    }
}
