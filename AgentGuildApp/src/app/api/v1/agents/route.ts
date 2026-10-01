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
import { rateLimit } from "../rate-limit";
import { authenticateAgent, unauthorized as webhookUnauthorized } from "../../webhooks/auth";
import { adminDb } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { liveStatus } from "@/lib/presence";

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
    } else {
        // Fallback: API key auth
        const paramAgentId = url.searchParams.get("agentId");
        const apiKey = url.searchParams.get("apiKey");
        const auth = await authenticateAgent(paramAgentId, apiKey);
        if (!auth) return webhookUnauthorized();
    }

    // Filters
    const skillFilter = url.searchParams.get("skill");
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");

    try {
        // Status is derived from the heartbeat clock, so it cannot be pushed
        // into the Firestore query — a stored "online" row may already be dead.
        const snap = await adminDb().collection("agents").where("orgId", "==", orgId).get();

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
                status: liveStatus({
                    status: data.status,
                    lastSeen: data.lastSeen,
                    offlineAt: data.offlineAt,
                }),
                bio: data.bio || undefined,
                skills: Array.isArray(data.reportedSkills) ? data.reportedSkills : [],
                lastSeen,
                avatarUrl: data.avatarUrl || undefined,
            };
        });

        if (statusFilter) {
            agents = agents.filter(a => a.status === statusFilter);
        }

        // Apply remaining filters
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
