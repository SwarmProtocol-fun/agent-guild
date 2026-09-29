/**
 * GET /api/admin/risk/scan/[runId]
 *
 * Poll scan run status and results.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getScanRun, getSignalsByScanRun } from "@/lib/fraud-detection";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { runId } = await params;

  try {
    const scanRun = await getScanRun(runId);
    if (!scanRun) {
      return Response.json({ error: "Scan run not found" }, { status: 404 });
    }

    // Optionally include signals if requested
    const includeSignals = req.nextUrl.searchParams.get("signals") === "true";
    let signals;
    if (includeSignals && scanRun.status === "completed") {
      signals = await getSignalsByScanRun(runId);
    }

    return Response.json({
      ok: true,
      scanRun,
      signals: signals || undefined,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch scan run",
    }, { status: 500 });
  }
}
