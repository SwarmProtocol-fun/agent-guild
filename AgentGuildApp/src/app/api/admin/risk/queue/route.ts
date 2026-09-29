/**
 * GET /api/admin/risk/queue
 *
 * List pending fraud review cases with filtering and pagination.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listFraudReviewCases, type FraudReviewCase } from "@/lib/fraud-detection";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const url = req.nextUrl;
    const status = url.searchParams.get("status") as FraudReviewCase["status"] | null;
    const severity = url.searchParams.get("severity") as "medium" | "high" | "critical" | null;
    const agentId = url.searchParams.get("agentId") || undefined;
    const max = parseInt(url.searchParams.get("limit") || "50", 10);

    const cases = await listFraudReviewCases({
      status: status || undefined,
      severity: severity || undefined,
      agentId,
      max: Math.min(max, 200),
    });

    return Response.json({
      ok: true,
      cases,
      total: cases.length,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch review queue",
    }, { status: 500 });
  }
}
