/**
 * GET /api/admin/credit-ops/overrides
 * POST /api/admin/credit-ops/overrides
 *
 * List overrides and create new override requests.
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { listOverrides, requestOverride } from "@/lib/credit-ops/override";
import type { OverrideType } from "@/lib/credit-ops/types";

/** GET — List overrides */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const approvalStatus = url.searchParams.get("approvalStatus") || undefined;
  const overrideType = url.searchParams.get("overrideType") || undefined;
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  try {
    const items = await listOverrides({ approvalStatus, overrideType, limit });
    return Response.json({ ok: true, count: items.length, items });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch overrides" },
      { status: 500 },
    );
  }
}

/** POST — Create new override request */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const {
    agentId, asn, newCreditScore, newTrustScore,
    reason, overrideType, reviewQueueItemId, appealId, expiresAt,
  } = body as {
    agentId: string;
    asn: string;
    newCreditScore: number;
    newTrustScore: number;
    reason: string;
    overrideType: OverrideType;
    reviewQueueItemId?: string;
    appealId?: string;
    expiresAt?: string;
  };

  if (!agentId || !asn || newCreditScore == null || newTrustScore == null || !reason) {
    return Response.json(
      { error: "agentId, asn, newCreditScore, newTrustScore, and reason required" },
      { status: 400 },
    );
  }

  if (newCreditScore < 300 || newCreditScore > 900) {
    return Response.json({ error: "Credit score must be 300-900" }, { status: 400 });
  }
  if (newTrustScore < 0 || newTrustScore > 100) {
    return Response.json({ error: "Trust score must be 0-100" }, { status: 400 });
  }

  try {
    const result = await requestOverride({
      agentId,
      asn,
      newCreditScore,
      newTrustScore,
      reason,
      overrideType: overrideType || "permanent",
      requestedBy: "platform-admin",
      reviewQueueItemId,
      appealId,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create override" },
      { status: 500 },
    );
  }
}
