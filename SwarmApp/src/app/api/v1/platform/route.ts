/**
 * GET /api/v1/platform — Full platform data snapshot for connected agents.
 *
 * Gives an agent visibility into the entire org: agents, tasks, jobs, projects, channels.
 * Supports both Ed25519 signature auth and API key auth.
 *
 * Query params (Ed25519):
 *   agent  — agent Firestore ID
 *   sig    — base64 Ed25519 signature of "GET:/v1/platform:<timestamp>"
 *   ts     — timestamp in ms
 *
 * Query params (API key):
 *   agentId — agent Firestore ID
 *   apiKey  — agent API key
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../verify";
import { logAgentCall } from "@/lib/agent-call-log";
import { rateLimit } from "../rate-limit";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../webhooks/auth";
import { getPlatformSnapshot } from "@/lib/firestore-admin";

export async function GET(req: NextRequest) {
    const url = req.nextUrl;

    const limited = await rateLimit(url.searchParams.get("agent") || url.searchParams.get("agentId") || "anon");
    if (limited) return limited;

    // Try Ed25519 auth first
    const agent = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    if (agent && sig && ts) {
        const tsNum = parseInt(ts, 10);
        if (!isTimestampFresh(tsNum)) {
            return unauthorized("Stale timestamp");
        }

        const message = `GET:/v1/platform:${ts}`;
        const verified = await verifyAgentRequest(agent, message, sig);
        if (!verified) return unauthorized();
        logAgentCall({
            agentId: verified.agentId,
            orgId: verified.orgId,
            authMethod: "ed25519",
            method: "GET",
            endpoint: "/v1/platform",
        });

        const snapshot = await getPlatformSnapshot(verified.orgId);
        return Response.json({ ok: true, ...snapshot });
    }

    // Fallback: API key auth
    const agentId = url.searchParams.get("agentId");
    const apiKey = url.searchParams.get("apiKey");
    const auth = await authenticateAgent(agentId, apiKey);
    if (!auth) return webhookUnauthorized();
    logAgentCall({
        agentId: auth.agentId,
        orgId: auth.orgId,
        authMethod: "apikey",
        method: "GET",
        endpoint: "/v1/platform",
    });

    const snapshot = await getPlatformSnapshot(auth.orgId);
    return Response.json({ ok: true, ...snapshot });
}
