/**
 * POST /api/cron/lending-sweep
 *
 * Lending housekeeping (see lib/lending/sweep.ts): defaults loans past their
 * due date + grace period, expires trust loans that never posted collateral,
 * and reconciles each pool's interest accrual. Idempotent — safe to run as
 * often as you like; hourly is plenty.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/lending-sweep.mts (hourly) or manual
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { sweepLending } from "@/lib/lending/sweep";

export async function POST(req: NextRequest) {
    if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
        return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
    }

    try {
        const result = await sweepLending();
        console.log(
            `[lending-sweep] defaulted=${result.defaulted.length} liquidating=${result.liquidating.length} expired=${result.expired.length} ` +
            `pools=${result.poolsReconciled.length} errors=${result.errors.length}`,
        );
        return NextResponse.json(result, { status: result.errors.length > 0 ? 207 : 200 });
    } catch (error) {
        console.error("[lending-sweep] Fatal error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Sweep failed" }, { status: 500 });
    }
}
