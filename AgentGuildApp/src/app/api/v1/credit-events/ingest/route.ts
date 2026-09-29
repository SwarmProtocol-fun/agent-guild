/**
 * POST /api/v1/credit-events/ingest
 *
 * Ingest one or more credit events into the canonical creditEvents collection.
 *
 * Auth: Internal service secret OR platform admin.
 *
 * Body (single): { event: CreditEventInput }
 * Body (batch):  { events: CreditEventInput[], forwardToHCS?: boolean }
 */

import { NextRequest } from "next/server";
import { requireInternalService, requirePlatformAdmin } from "@/lib/auth-guard";
import { ingestCreditEvent, ingestCreditEventBatch } from "@/lib/credit-events/ingest";
import type { CreditEventInput } from "@/lib/credit-events/types";

export async function POST(request: NextRequest) {
  // Auth: internal service OR platform admin
  const serviceAuth = requireInternalService(request);
  const adminAuth = requirePlatformAdmin(request);

  if (!serviceAuth.ok && !adminAuth.ok) {
    return Response.json(
      { error: "Internal service or platform admin credentials required" },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const forwardToHCS = body.forwardToHCS === true;

  // Single event ingestion
  if (body.event && typeof body.event === "object") {
    const result = await ingestCreditEvent(
      body.event as CreditEventInput,
      { forwardToHCS },
    );

    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    return Response.json({
      success: true,
      eventId: result.eventId || null,
      deduplicated: result.deduplicated || false,
    });
  }

  // Batch event ingestion
  if (Array.isArray(body.events)) {
    if (body.events.length > 500) {
      return Response.json(
        { error: "Batch size cannot exceed 500 events" },
        { status: 400 },
      );
    }

    const result = await ingestCreditEventBatch(
      body.events as CreditEventInput[],
      { forwardToHCS },
    );

    return Response.json({
      success: true,
      total: result.total,
      ingested: result.ingested,
      deduplicated: result.deduplicated,
      errors: result.errors,
      eventIds: result.eventIds,
    });
  }

  return Response.json(
    { error: "Request body must contain 'event' or 'events' field" },
    { status: 400 },
  );
}
