/**
 * GET /api/v1/credit/agents/:id/history
 *
 * Get paginated credit event history for an agent.
 *
 * Query params:
 *   limit     — max events to return (default 100, max 500)
 *   offset    — pagination offset (default 0)
 *   eventType — filter by event type (task_complete, task_fail, etc.)
 *
 * Auth: platform admin or authenticated agent (agents can read own history).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { getCreditHistory } from "@/lib/credit-service";
import type { ScoreEvent } from "@/lib/credit-types";
import { rateLimit } from "@/app/api/v1/rate-limit";

const VALID_EVENT_TYPES = new Set([
    "task_complete", "task_fail", "skill_report", "penalty", "bonus", "checkpoint",
]);

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    // Rate limit
    const limited = await rateLimit(id);
    if (limited) return limited;

    // Auth
    const auth = await requirePlatformAdminOrAgent(request, `GET:/v1/credit/agents/${id}/history`);
    if (!auth.ok) return unauthorized(auth.error);

    if (auth.agent && auth.agent.agentId !== id) {
        return Response.json(
            { error: "Agents can only read their own credit history" },
            { status: 403 },
        );
    }

    // Parse query params
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 500);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10) || 0, 0);
    const eventTypeParam = searchParams.get("eventType");

    let eventType: ScoreEvent["type"] | undefined;
    if (eventTypeParam) {
        if (!VALID_EVENT_TYPES.has(eventTypeParam)) {
            return Response.json(
                { error: `Invalid eventType. Valid types: ${Array.from(VALID_EVENT_TYPES).join(", ")}` },
                { status: 400 },
            );
        }
        eventType = eventTypeParam as ScoreEvent["type"];
    }

    try {
        const result = await getCreditHistory(id, { limit, offset, eventType });
        if (!result) {
            return Response.json({ error: "Agent not found" }, { status: 404 });
        }

        return Response.json(result);
    } catch (error) {
        console.error("[credit/agents/:id/history] Error:", error);
        return Response.json(
            { error: "Failed to fetch credit history", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
