/**
 * POST /api/v1/scoring/simulate
 *
 * Simulation sandbox: run hypothetical events through the scoring engine
 * without persisting any changes. Returns before/after comparison.
 *
 * Body: { agentId, hypotheticalEvents: ScoreEvent[], modelVersion?: string }
 * Auth: Session required.
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { validateSession } from "@/lib/session";
import { simulateScoreChange } from "@/lib/scoring-engine";
import type { ScoreEvent } from "@/lib/credit-types";

export async function POST(request: NextRequest) {
    const session = await validateSession();
    if (!session?.sub) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const agentId = body.agentId as string | undefined;
    const hypotheticalEvents = body.hypotheticalEvents as ScoreEvent[] | undefined;
    const modelVersion = body.modelVersion as string | undefined;

    if (!agentId) {
        return Response.json({ error: "agentId is required" }, { status: 400 });
    }
    if (!hypotheticalEvents || !Array.isArray(hypotheticalEvents) || hypotheticalEvents.length === 0) {
        return Response.json({ error: "hypotheticalEvents array is required (non-empty)" }, { status: 400 });
    }
    if (hypotheticalEvents.length > 100) {
        return Response.json({ error: "Maximum 100 hypothetical events per simulation" }, { status: 400 });
    }

    // Validate event structure
    for (const event of hypotheticalEvents) {
        if (!event.type || !event.asn || typeof event.creditDelta !== "number") {
            return Response.json({ error: "Each event must have type, asn, and creditDelta" }, { status: 400 });
        }
    }

    // Load agent to get ASN
    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentData = agentSnap.data()!;
    const asn = agentData.asn as string | undefined;
    if (!asn) {
        return Response.json({ error: "Agent has no ASN assigned" }, { status: 400 });
    }

    try {
        const result = await simulateScoreChange(agentId, asn, hypotheticalEvents, modelVersion);

        return Response.json({
            ok: true,
            simulation: {
                before: {
                    compositeScore: result.before.compositeScore,
                    band: result.before.band,
                    confidence: result.before.confidence,
                },
                after: {
                    compositeScore: result.after.compositeScore,
                    band: result.after.band,
                    confidence: result.after.confidence,
                },
                delta: result.delta,
                subScoreDeltas: result.subScoreDeltas,
                modelVersion: result.after.modelVersion,
            },
        });
    } catch (err) {
        console.error("Score simulation failed:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
}
