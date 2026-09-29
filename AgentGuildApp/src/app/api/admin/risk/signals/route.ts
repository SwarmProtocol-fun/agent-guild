/**
 * GET /api/admin/risk/signals
 *
 * List raw risk signals with filtering by type, severity, status, agent.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import {
  getSignals,
  type RiskSignalType,
  type SignalSeverity,
  type SignalStatus,
} from "@/lib/fraud-detection";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const url = req.nextUrl;
    const agentId = url.searchParams.get("agentId") || undefined;
    const signalType = url.searchParams.get("type") as RiskSignalType | null;
    const severity = url.searchParams.get("severity") as SignalSeverity | null;
    const status = url.searchParams.get("status") as SignalStatus | null;
    const max = parseInt(url.searchParams.get("limit") || "100", 10);

    const signals = await getSignals({
      agentId,
      signalType: signalType || undefined,
      severity: severity || undefined,
      status: status || undefined,
      max: Math.min(max, 500),
    });

    return Response.json({
      ok: true,
      signals,
      total: signals.length,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch signals",
    }, { status: 500 });
  }
}
