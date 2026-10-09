/**
 * POST /api/cron/job-review-sweep — Remind, then auto-approve, deliveries nobody reviewed
 *
 * Auth: internal service secret (the hourly Netlify function
 * netlify/functions/job-review-sweep.mts) or a platform admin.
 * See lib/jobs-admin.ts::sweepReviews.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireInternalService, requirePlatformAdmin } from "@/lib/auth-guard";
import { sweepReviews } from "@/lib/jobs-admin";

export async function POST(req: NextRequest) {
  if (!requirePlatformAdmin(req).ok && !requireInternalService(req).ok) {
    return NextResponse.json({ error: "Platform admin or internal service secret required" }, { status: 403 });
  }
  try {
    const result = await sweepReviews();
    console.log(
      `[job-review-sweep] checked=${result.checked} autoApproved=${result.autoApproved.length} reminded=${result.reminded.length} ` +
      `clockStarted=${result.clockStarted.length} overdue=${result.flaggedOverdue.length} errors=${result.errors.length}`,
    );
    return NextResponse.json(result, { status: result.errors.length > 0 ? 207 : 200 });
  } catch (error) {
    console.error("[job-review-sweep] Fatal error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sweep failed" }, { status: 500 });
  }
}
