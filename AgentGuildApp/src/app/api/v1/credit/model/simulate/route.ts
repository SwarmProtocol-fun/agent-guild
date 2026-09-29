/**
 * POST /api/v1/credit/model/simulate
 *
 * Simulate score changes given hypothetical events.
 * Read-only — does NOT modify any state.
 *
 * Body: {
 *   agentId: string,
 *   events: Array<{ type, creditDelta, trustDelta }>
 * }
 *
 * Auth: platform admin or authenticated agent (agents can simulate own).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdminOrAgent, unauthorized } from "@/lib/auth-guard";
import { simulateScore } from "@/lib/credit-service";
import type { ScoreEvent } from "@/lib/credit-types";
import { rateLimit } from "@/app/api/v1/rate-limit";
// [agent-guild-core] Hedera type removed — install agent-guild-hedera mod

const VALID_EVENT_TYPES = new Set([
    "task_complete", "task_fail", "skill_report", "penalty", "bonus", "checkpoint",
]);

export async function POST(request: NextRequest) {
    // Rate limit
    const limited = await rateLimit("simulate");
    if (limited) return limited;

    // Auth
    const auth = await requirePlatformAdminOrAgent(request, "POST:/v1/credit/model/simulate");
    if (!auth.ok) return unauthorized(auth.error);

    // Parse body
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    if (!agentId) {
        return Response.json({ error: "agentId is required" }, { status: 400 });
    }

    // If agent-authed, verify they can only simulate their own score
    if (auth.agent && auth.agent.agentId !== agentId) {
        return Response.json(
            { error: "Agents can only simulate their own credit score" },
            { status: 403 },
        );
    }

    // Validate events array
    const events = body.events as Array<{ type: string; creditDelta: number; trustDelta: number }> | undefined;
    if (!Array.isArray(events) || events.length === 0) {
        return Response.json({ error: "events must be a non-empty array" }, { status: 400 });
    }

    if (events.length > 100) {
        return Response.json({ error: "events array must not exceed 100 entries" }, { status: 400 });
    }

    // Validate each event
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e.type || !VALID_EVENT_TYPES.has(e.type)) {
            return Response.json(
                { error: `events[${i}].type must be one of: ${Array.from(VALID_EVENT_TYPES).join(", ")}` },
                { status: 400 },
            );
        }
        if (typeof e.creditDelta !== "number") {
            return Response.json({ error: `events[${i}].creditDelta must be a number` }, { status: 400 });
        }
        if (typeof e.trustDelta !== "number") {
            return Response.json({ error: `events[${i}].trustDelta must be a number` }, { status: 400 });
        }
    }

    try {
        const result = await simulateScore(
            agentId,
            events.map(e => ({
                type: e.type as ScoreEvent["type"],
                creditDelta: e.creditDelta,
                trustDelta: e.trustDelta,
            })),
        );

        return Response.json(result);
    } catch (error) {
        console.error("[credit/model/simulate] Error:", error);

        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message === "Agent not found" ? 404 : 500;

        return Response.json(
            { error: "Failed to simulate credit score", details: message },
            { status },
        );
    }
}
