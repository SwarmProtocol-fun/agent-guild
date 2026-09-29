/**
 * POST /api/v1/scoring/compute
 *
 * Trigger a full score recomputation for an agent.
 * Uses the Dynamic Scoring Engine to compute 5 sub-scores + composite.
 *
 * Body: { agentId }
 * Auth: Session (any authenticated user can trigger recompute for their agents)
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { validateSession } from "@/lib/session";
import {
    computeAgentScore,
    persistScoreSnapshot,
    syncCompositeToAgent,
    drainEventBuffer,
} from "@/lib/scoring-engine";

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
    if (!agentId) {
        return Response.json({ error: "agentId is required" }, { status: 400 });
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
        const snapshot = await computeAgentScore(agentId, asn);
        const snapshotId = await persistScoreSnapshot(snapshot);
        await syncCompositeToAgent(snapshot);
        drainEventBuffer(asn);

        return Response.json({
            ok: true,
            id: snapshotId,
            compositeScore: snapshot.compositeScore,
            trustScore: snapshot.trustScore,
            band: snapshot.band,
            confidence: snapshot.confidence,
            modelVersion: snapshot.modelVersion,
            delta: snapshot.delta,
            subScores: snapshot.subScores,
        });
    } catch (err) {
        console.error("Score computation failed:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
}
