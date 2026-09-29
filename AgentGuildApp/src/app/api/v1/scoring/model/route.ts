/**
 * GET  /api/v1/scoring/model — Get the active scoring model
 * POST /api/v1/scoring/model — Create a new model version (platform admin only)
 *
 * Model management for the Dynamic Scoring Engine.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { validateSession } from "@/lib/session";
import {
    getActiveScoringModel,
    saveScoringModel,
    SUB_SCORE_KINDS,
    type ScoringModel,
} from "@/lib/scoring-engine";

export async function GET() {
    const session = await validateSession();
    if (!session?.sub) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const model = await getActiveScoringModel();
        return Response.json({ ok: true, model });
    } catch (err) {
        console.error("Failed to get scoring model:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    // Only platform admins can create new scoring models
    const auth = requirePlatformAdmin(request);
    if (!auth.ok) return forbidden(auth.error);

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const version = body.version as string | undefined;
    const label = body.label as string | undefined;
    const weights = body.weights as Record<string, number> | undefined;
    const decayHalfLifeDays = body.decayHalfLifeDays as Record<string, number> | undefined;
    const confidenceThresholds = body.confidenceThresholds as Record<string, number> | undefined;
    const confidenceMinSpanDays = body.confidenceMinSpanDays as number | undefined;

    if (!version || !label) {
        return Response.json({ error: "version and label are required" }, { status: 400 });
    }
    if (!weights || !decayHalfLifeDays || !confidenceThresholds) {
        return Response.json(
            { error: "weights, decayHalfLifeDays, and confidenceThresholds are required" },
            { status: 400 },
        );
    }

    // Validate all sub-score kinds are present
    for (const kind of SUB_SCORE_KINDS) {
        if (typeof weights[kind] !== "number") {
            return Response.json({ error: `Missing weight for ${kind}` }, { status: 400 });
        }
        if (typeof decayHalfLifeDays[kind] !== "number" || decayHalfLifeDays[kind] <= 0) {
            return Response.json({ error: `Invalid decayHalfLifeDays for ${kind}` }, { status: 400 });
        }
        if (typeof confidenceThresholds[kind] !== "number" || confidenceThresholds[kind] <= 0) {
            return Response.json({ error: `Invalid confidenceThreshold for ${kind}` }, { status: 400 });
        }
    }

    const model: ScoringModel = {
        version,
        label,
        weights: weights as ScoringModel["weights"],
        decayHalfLifeDays: decayHalfLifeDays as ScoringModel["decayHalfLifeDays"],
        confidenceThresholds: confidenceThresholds as ScoringModel["confidenceThresholds"],
        confidenceMinSpanDays: confidenceMinSpanDays || 30,
        active: true,
        createdAt: null,
    };

    try {
        await saveScoringModel(model);
        return Response.json({ ok: true, model });
    } catch (err) {
        console.error("Failed to save scoring model:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
    }
}
