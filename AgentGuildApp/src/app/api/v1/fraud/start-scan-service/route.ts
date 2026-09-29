/**
 * POST /api/v1/fraud/start-scan-service
 *
 * Start or stop the background fraud scan service.
 * Platform admin only.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import {
  startFraudScanService,
  stopFraudScanService,
  isFraudScanServiceRunning,
} from "@/lib/fraud-scan-service";

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine
  }

  const action = (body.action as string) || "start";
  const intervalHours = (body.intervalHours as number) || 6;

  if (action === "stop") {
    stopFraudScanService();
    return Response.json({
      ok: true,
      action: "stopped",
      running: false,
    });
  }

  if (action === "status") {
    return Response.json({
      ok: true,
      running: isFraudScanServiceRunning(),
    });
  }

  // Default: start
  const intervalMs = intervalHours * 60 * 60 * 1000;
  startFraudScanService(intervalMs);

  return Response.json({
    ok: true,
    action: "started",
    running: true,
    intervalHours,
  });
}
