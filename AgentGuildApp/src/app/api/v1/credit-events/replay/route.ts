/**
 * POST /api/v1/credit-events/replay
 *
 * Replay credit events within a time range for reprocessing.
 *
 * Auth: Platform admin only.
 *
 * Body: {
 *   fromTimestamp: number (Unix seconds),
 *   toTimestamp: number (Unix seconds),
 *   agentId?: string,
 *   eventType?: CreditEventType,
 *   dryRun?: boolean
 * }
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getEventsForReplay } from "@/lib/credit-events/store";

export async function POST(request: NextRequest) {
  // Auth: platform admin only
  const auth = requirePlatformAdmin(request);
  if (!auth.ok) {
    return Response.json(
      { error: auth.error || "Platform admin access required" },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fromTimestamp = body.fromTimestamp as number | undefined;
  const toTimestamp = body.toTimestamp as number | undefined;

  if (typeof fromTimestamp !== "number" || typeof toTimestamp !== "number") {
    return Response.json(
      { error: "fromTimestamp and toTimestamp are required (Unix seconds)" },
      { status: 400 },
    );
  }

  if (fromTimestamp >= toTimestamp) {
    return Response.json(
      { error: "fromTimestamp must be less than toTimestamp" },
      { status: 400 },
    );
  }

  // Limit replay window to 30 days
  const maxWindow = 30 * 24 * 60 * 60;
  if (toTimestamp - fromTimestamp > maxWindow) {
    return Response.json(
      { error: "Replay window cannot exceed 30 days" },
      { status: 400 },
    );
  }

  const agentId = body.agentId as string | undefined;
  const eventType = body.eventType as string | undefined;
  const dryRun = body.dryRun !== false; // Default true

  try {
    const events = await getEventsForReplay(
      fromTimestamp,
      toTimestamp,
      agentId,
      eventType,
    );

    // Compute aggregate deltas for the replay window
    let totalCreditDelta = 0;
    let totalTrustDelta = 0;
    for (const event of events) {
      totalCreditDelta += event.creditDelta;
      totalTrustDelta += event.trustDelta;
    }

    return Response.json({
      dryRun,
      fromTimestamp,
      toTimestamp,
      eventCount: events.length,
      aggregates: {
        totalCreditDelta,
        totalTrustDelta,
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        agentId: e.agentId,
        creditDelta: e.creditDelta,
        trustDelta: e.trustDelta,
        timestamp: e.timestamp,
        source: e.source,
        description: e.description,
      })),
    });
  } catch (err) {
    console.error("Replay credit events error:", err);
    return Response.json(
      { error: "Failed to replay credit events" },
      { status: 500 },
    );
  }
}
