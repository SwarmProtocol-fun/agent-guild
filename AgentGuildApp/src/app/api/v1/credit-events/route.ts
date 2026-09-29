/**
 * GET /api/v1/credit-events
 *
 * Query credit events with filters.
 *
 * Auth: Platform admin or session-authenticated user.
 *
 * Query params: agentId, asn, orgId, eventType, provenance,
 *               fromTimestamp, toTimestamp, limit, order
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { validateSession } from "@/lib/session";
import { queryCreditEvents } from "@/lib/credit-events/store";
import type { CreditEventType, EventProvenance } from "@/lib/credit-events/types";

export async function GET(request: NextRequest) {
  // Auth: platform admin or session-authenticated user
  const adminAuth = requirePlatformAdmin(request);

  if (!adminAuth.ok) {
    const session = await validateSession();
    if (!session?.sub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);

  const params = {
    agentId: searchParams.get("agentId") || undefined,
    asn: searchParams.get("asn") || undefined,
    orgId: searchParams.get("orgId") || undefined,
    eventType: (searchParams.get("eventType") || undefined) as CreditEventType | undefined,
    provenance: (searchParams.get("provenance") || undefined) as EventProvenance | undefined,
    fromTimestamp: searchParams.get("fromTimestamp")
      ? parseInt(searchParams.get("fromTimestamp")!, 10)
      : undefined,
    toTimestamp: searchParams.get("toTimestamp")
      ? parseInt(searchParams.get("toTimestamp")!, 10)
      : undefined,
    limit: searchParams.get("limit")
      ? Math.min(parseInt(searchParams.get("limit")!, 10), 500)
      : 100,
    orderDirection: (searchParams.get("order") || "desc") as "asc" | "desc",
  };

  // Require at least one filter to prevent full-collection scans
  if (!params.agentId && !params.asn && !params.orgId && !params.eventType) {
    return Response.json(
      { error: "At least one filter required: agentId, asn, orgId, or eventType" },
      { status: 400 },
    );
  }

  try {
    const events = await queryCreditEvents(params);

    return Response.json({
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        agentId: e.agentId,
        asn: e.asn,
        orgId: e.orgId,
        creditDelta: e.creditDelta,
        trustDelta: e.trustDelta,
        provenance: e.provenance,
        severity: e.severity,
        source: e.source,
        timestamp: e.timestamp,
        description: e.description,
        metadata: e.metadata,
        hcsTxId: e.hcsTxId,
      })),
    });
  } catch (err) {
    console.error("Query credit events error:", err);
    return Response.json(
      { error: "Failed to query credit events" },
      { status: 500 },
    );
  }
}
