/**
 * POST /api/v1/usage
 *
 * Ingest a token usage record from an agent runtime.
 * Writes to the usageRecords Firestore collection, which drives
 * the /usage dashboard (cost by model, cost by agent, daily chart).
 *
 * Auth: Ed25519 (agent, sig, ts query params) or API key (agentId, apiKey).
 *
 * Body:
 *   orgId      — (required) organization ID
 *   model      — (required) model identifier, e.g. "claude-sonnet-4-6"
 *   tokensIn   — (required) prompt/input token count
 *   tokensOut  — (required) completion/output token count
 *   costUsd    — (optional) override cost estimate; auto-calculated from MODEL_PRICING if omitted
 *   sessionId  — (optional) compute session or task ID for cross-referencing
 *   agentName  — (optional) display name (stored alongside agentId)
 *
 * Returns: { ok: true, id: string, costUsd: number }
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../verify";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../webhooks/auth";
import { estimateCost } from "@/lib/usage";
import { logUsage } from "@/lib/firestore-admin";

export async function POST(req: NextRequest) {
    const url = req.nextUrl;

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Authenticate — Ed25519 first
    const agent = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    let resolvedAgentId: string | null = null;
    let resolvedOrgId: string | null = typeof body.orgId === "string" ? body.orgId : null;

    if (agent && sig && ts) {
        const tsNum = parseInt(ts, 10);
        if (!isTimestampFresh(tsNum)) return unauthorized("Stale timestamp");

        const message = `POST:/v1/usage:${ts}`;
        const verified = await verifyAgentRequest(agent, message, sig);
        if (!verified) return unauthorized();

        resolvedAgentId = verified.agentId || null;
        resolvedOrgId = resolvedOrgId || verified.orgId || null;
    } else {
        const paramAgentId = url.searchParams.get("agentId");
        const apiKey = url.searchParams.get("apiKey");
        const auth = await authenticateAgent(paramAgentId, apiKey);
        if (!auth) return webhookUnauthorized();
        resolvedAgentId = auth.agentId || null;
        resolvedOrgId = resolvedOrgId || auth.orgId || null;
    }

    if (!resolvedAgentId) {
        return Response.json({ error: "Could not resolve agentId" }, { status: 400 });
    }
    if (!resolvedOrgId) {
        return Response.json({ error: "orgId is required" }, { status: 400 });
    }

    // Validate required fields
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    const tokensIn = typeof body.tokensIn === "number" && body.tokensIn >= 0 ? Math.floor(body.tokensIn) : null;
    const tokensOut = typeof body.tokensOut === "number" && body.tokensOut >= 0 ? Math.floor(body.tokensOut) : null;

    if (!model) return Response.json({ error: "model is required" }, { status: 400 });
    if (tokensIn === null) return Response.json({ error: "tokensIn must be a non-negative number" }, { status: 400 });
    if (tokensOut === null) return Response.json({ error: "tokensOut must be a non-negative number" }, { status: 400 });

    const costUsd = typeof body.costUsd === "number" && body.costUsd >= 0
        ? body.costUsd
        : estimateCost(model, tokensIn, tokensOut);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const agentName = typeof body.agentName === "string" ? body.agentName : undefined;

    try {
        const id = await logUsage({
            orgId: resolvedOrgId,
            agentId: resolvedAgentId,
            agentName,
            model,
            tokensIn,
            tokensOut,
            costUsd,
            sessionId,
        });

        return Response.json({ ok: true, id, costUsd });
    } catch (err) {
        console.error("usage ingest error:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
