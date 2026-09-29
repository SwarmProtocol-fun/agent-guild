/**
 * GET /api/v1/agents
 *
 * Agent discovery endpoint. Returns agents filtered by org, skill, type, or status.
 * Supports both Ed25519 signature auth and API key auth.
 *
 * Query params:
 *   org      — (required) organization ID
 *   skill    — filter by skill ID (e.g. "web-search")
 *   type     — filter by agent type (e.g. "Research")
 *   status   — filter by status ("online" | "offline" | "busy")
 *   agent    — agent ID for Ed25519 auth
 *   sig      — Ed25519 signature
 *   ts       — timestamp (ms)
 *   agentId  — agent ID for API key auth
 *   apiKey   — API key for fallback auth
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh, unauthorized } from "../verify";
import { logAgentCall } from "@/lib/agent-call-log";
import { rateLimit } from "../rate-limit";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../webhooks/auth";
import { adminDb } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

interface AgentResult {
    id: string;
    name: string;
    type: string;
    status: string;
    bio?: string;
    skills: { id: string; name: string; type: string; version?: string }[];
    lastSeen: string | null;
    avatarUrl?: string;
}

export async function GET(req: NextRequest) {
    const url = req.nextUrl;
    const orgId = url.searchParams.get("org");

    if (!orgId) {
        return Response.json({ error: "org parameter is required" }, { status: 400 });
    }

    const limited = await rateLimit(url.searchParams.get("agent") || url.searchParams.get("agentId") || "anon");
    if (limited) return limited;

    // Authenticate — try Ed25519 first
    const agent = url.searchParams.get("agent");
    const sig = url.searchParams.get("sig");
    const ts = url.searchParams.get("ts");

    if (agent && sig && ts) {
        const tsNum = parseInt(ts, 10);
        if (!isTimestampFresh(tsNum)) {
            return unauthorized("Stale timestamp");
        }
        const message = `GET:/v1/agents:${ts}`;
        const verified = await verifyAgentRequest(agent, message, sig);
        if (!verified) return unauthorized();
        // Verify agent belongs to the requested org
        if (verified.orgId !== orgId) {
            return unauthorized("Agent does not belong to this organization");
        }
        logAgentCall({
            agentId: verified.agentId,
            orgId: verified.orgId,
            authMethod: "ed25519",
            method: "GET",
            endpoint: "/v1/agents",
        });
    } else {
        // Fallback: API key auth
        const paramAgentId = url.searchParams.get("agentId");
        const apiKey = url.searchParams.get("apiKey");
        const auth = await authenticateAgent(paramAgentId, apiKey);
        if (!auth) return webhookUnauthorized();
        logAgentCall({
            agentId: auth.agentId,
            orgId: auth.orgId,
            authMethod: "apikey",
            method: "GET",
            endpoint: "/v1/agents",
        });
    }

    // Filters
    const skillFilter = url.searchParams.get("skill");
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");

    try {
        // Push the exact-match status filter into Firestore so busy orgs with many
        // agents don't pull the full roster just to return a handful of "online" ones.
        // (type/skill stay client-side — they're matched case-insensitively/by substring.)
        let query = adminDb().collection("agents").where("orgId", "==", orgId);
        if (statusFilter) query = query.where("status", "==", statusFilter);
        const snap = await query.get();

        let agents: AgentResult[] = snap.docs.map(d => {
            const data = d.data();
            const lastSeenRaw = data.lastSeen;
            let lastSeen: string | null = null;
            if (lastSeenRaw instanceof Timestamp) {
                lastSeen = lastSeenRaw.toDate().toISOString();
            }

            return {
                id: d.id,
                name: data.name || "Unknown",
                type: data.type || "agent",
                status: data.status || "offline",
                bio: data.bio || undefined,
                skills: Array.isArray(data.reportedSkills) ? data.reportedSkills : [],
                lastSeen,
                avatarUrl: data.avatarUrl || undefined,
            };
        });

        // Apply remaining filters (status is already applied at the Firestore level above)
        if (typeFilter) {
            agents = agents.filter(a => a.type.toLowerCase() === typeFilter.toLowerCase());
        }
        if (skillFilter) {
            agents = agents.filter(a =>
                a.skills.some(s => s.id === skillFilter || s.name.toLowerCase().includes(skillFilter.toLowerCase()))
            );
        }

        return Response.json({
            org: orgId,
            count: agents.length,
            agents,
        });
    } catch (err) {
        console.error("v1/agents error:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
