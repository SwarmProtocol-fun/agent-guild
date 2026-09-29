/**
 * POST /api/v1/agents/[id]/heartbeat
 *
 * Agent liveness ping. Updates the agentHeartbeats collection and
 * marks the agent as online. Call every 60–120 seconds from the agent runtime.
 *
 * Auth: Ed25519 (agent, sig, ts query params) or API key (agentId, apiKey).
 *
 * Body (all optional):
 *   orgId      — organization the agent belongs to (required if not in Ed25519 context)
 *   agentName  — display name (persisted on first ping, updated each call)
 *   latencyMs  — round-trip latency to hub in ms
 *   version    — agent runtime version string
 *   uptime     — seconds the runtime process has been alive
 *
 * Returns: { ok: true, status: "online", lastSeen: ISO }
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../../../verify";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../../../webhooks/auth";
import { recordHeartbeat } from "@/lib/heartbeat";

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: pathAgentId } = await params;
    const url = req.nextUrl;

    let body: Record<string, unknown> = {};
    try {
        body = await req.json();
    } catch {
        // body is optional
    }

    const orgId = typeof body.orgId === "string" ? body.orgId : null;

    // Authenticate — Ed25519 first
    const agent = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    let resolvedAgentId: string = pathAgentId;
    let resolvedOrgId: string | null = orgId;

    if (agent && sig && ts) {
        const tsNum = parseInt(ts, 10);
        if (!isTimestampFresh(tsNum)) return unauthorized("Stale timestamp");

        const message = `POST:/v1/agents/${pathAgentId}/heartbeat:${ts}`;
        const verified = await verifyAgentRequest(agent, message, sig);
        if (!verified) return unauthorized();

        resolvedAgentId = verified.agentId || pathAgentId;
        resolvedOrgId = resolvedOrgId || verified.orgId || null;
    } else {
        const paramAgentId = url.searchParams.get("agentId");
        const apiKey = url.searchParams.get("apiKey");
        const auth = await authenticateAgent(paramAgentId, apiKey);
        if (!auth) return webhookUnauthorized();
        resolvedAgentId = auth.agentId || pathAgentId;
        resolvedOrgId = resolvedOrgId || auth.orgId || null;
    }

    if (!resolvedOrgId) {
        return Response.json({ error: "orgId is required" }, { status: 400 });
    }

    const agentName = typeof body.agentName === "string" ? body.agentName : undefined;
    const latencyMs = typeof body.latencyMs === "number" ? body.latencyMs : undefined;
    const version = typeof body.version === "string" ? body.version : undefined;
    const uptime = typeof body.uptime === "number" ? body.uptime : undefined;

    try {
        await recordHeartbeat(resolvedOrgId, resolvedAgentId, { agentName, latencyMs, version, uptime });
        return Response.json({
            ok: true,
            status: "online",
            agentId: resolvedAgentId,
            lastSeen: new Date().toISOString(),
        });
    } catch (err) {
        console.error("heartbeat error:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
