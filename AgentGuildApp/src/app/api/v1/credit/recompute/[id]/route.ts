/**
 * POST /api/v1/credit/recompute/:id
 *
 * Force recompute an agent's credit score by replaying all HCS events.
 * Updates Firestore with the recomputed score.
 *
 * Auth: platform admin only (expensive operation, modifies score).
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { recomputeScore } from "@/lib/credit-service";
import { invalidateCache } from "@/lib/credit-cache";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    // Auth: platform admin only
    const auth = requirePlatformAdmin(request);
    if (!auth.ok) return forbidden(auth.error);

    try {
        const result = await recomputeScore(id);

        // Invalidate cache after recompute
        invalidateCache(`credit:${id}`);

        return Response.json({
            success: true,
            ...result,
            message: `Recomputed credit for ${id}: ${result.previousCreditScore} -> ${result.newCreditScore} (${result.eventsProcessed} events)`,
        });
    } catch (error) {
        console.error("[credit/recompute/:id] Error:", error);

        const message = error instanceof Error ? error.message : "Unknown error";
        const status = message === "Agent not found" || message.includes("ASN") ? 404 : 500;

        return Response.json(
            { error: "Failed to recompute credit score", details: message },
            { status },
        );
    }
}
