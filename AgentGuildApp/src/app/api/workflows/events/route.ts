/**
 * POST /api/workflows/events — Fire an event through the trigger system
 *
 * Auth: internal service secret OR org member
 *
 * Body: {
 *   orgId: string,
 *   eventName: string,
 *   eventData: Record<string, unknown>,
 *   eventId: string
 * }
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { fireEvent, type TriggerEventName } from "@/lib/workflow/triggers";

const VALID_EVENTS = new Set<TriggerEventName>([
  "agent:connect",
  "agent:disconnect",
  "task:complete",
  "task:fail",
  "message:received",
  "assignment:created",
  "assignment:completed",
  "assignment:rejected",
  "workflow:completed",
  "workflow:failed",
  "cron:tick",
  "webhook:received",
  "custom",
]);

export async function POST(req: NextRequest) {
  // Auth: internal service secret OR wallet session
  const internalSecret = req.headers.get("x-internal-secret");
  const isInternal = internalSecret && internalSecret === process.env.INTERNAL_SERVICE_SECRET;

  if (!isInternal) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
  }

  let body: {
    orgId: string;
    eventName: TriggerEventName;
    eventData?: Record<string, unknown>;
    eventId?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.orgId || !body.eventName) {
    return Response.json({ error: "orgId and eventName are required" }, { status: 400 });
  }

  if (!VALID_EVENTS.has(body.eventName)) {
    return Response.json(
      { error: `eventName must be one of: ${[...VALID_EVENTS].join(", ")}` },
      { status: 400 },
    );
  }

  // If not internal, verify org membership
  if (!isInternal) {
    const orgAuth = await requireOrgMember(req, body.orgId);
    if (!orgAuth.ok) {
      return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
    }
  }

  try {
    const eventId = body.eventId || `${body.eventName}:${Date.now()}`;
    const startedRuns = await fireEvent(
      body.orgId,
      body.eventName,
      body.eventData || {},
      eventId,
    );

    return Response.json({
      ok: true,
      triggeredRuns: startedRuns.length,
      runIds: startedRuns,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fire event" },
      { status: 500 },
    );
  }
}
