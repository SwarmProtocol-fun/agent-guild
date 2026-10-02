/**
 * POST /api/cron/vault-rotation
 *
 * Runs due secret rotations (see lib/vault/rotation.ts): webhook policies
 * fetch and seal a new value, remind policies get flagged overdue.
 * Idempotent — hourly is plenty.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: netlify/functions/vault-rotation.mts (hourly) or manual
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { sweepRotations } from "@/lib/vault/rotation";

export async function POST(req: NextRequest) {
  if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
    return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
  }
  try {
    const result = await sweepRotations();
    console.log(`[vault-rotation] rotated=${result.rotated.length} failed=${result.failed.length} reminded=${result.reminded.length}`);
    return NextResponse.json(result, { status: result.failed.length > 0 ? 207 : 200 });
  } catch (error) {
    console.error("[vault-rotation] Fatal error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sweep failed" }, { status: 500 });
  }
}
