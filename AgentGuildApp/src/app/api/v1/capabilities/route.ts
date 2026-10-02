/**
 * GET /api/v1/capabilities
 *
 * Unsigned: list all capabilities. Public catalog endpoint.
 * Query params: modId, type
 *
 * Signed (?agent=&sig=&ts=, message "GET:/v1/capabilities:<ts>", or
 * ?agentId=&apiKey=): list what the calling agent can use right now —
 * enabled org installs, expired subscriptions dropped, legacy per-agent
 * assignments included. This is how a running agent process learns that a
 * mod was installed. Never returns a secret or a wallet.
 */
import { NextRequest } from "next/server";
import { CAPABILITY_REGISTRY, MOD_REGISTRY } from "@/lib/skills";
import { getAgentCapabilities } from "@/lib/firestore-admin";
import { requireAgentAuth } from "@/lib/auth-guard";
import { rateLimit } from "../rate-limit";

export async function GET(req: NextRequest) {
    const url = req.nextUrl;
    const agentParam = url.searchParams.get("agent") || url.searchParams.get("agentId");
    if (agentParam) return agentCapabilities(req, agentParam);

    const modId = url.searchParams.get("modId");
    const type = url.searchParams.get("type");

    let capabilities = [...CAPABILITY_REGISTRY];

    if (modId) {
        capabilities = capabilities.filter((c) => c.modId === modId);
    }
    if (type) {
        capabilities = capabilities.filter((c) => c.type === type);
    }

    return Response.json({ count: capabilities.length, capabilities });
}

async function agentCapabilities(req: NextRequest, agentParam: string) {
    const limited = await rateLimit(agentParam);
    if (limited) return limited;

    const auth = await requireAgentAuth(req, "GET:/v1/capabilities");
    if (!auth.ok || !auth.agent) {
        return Response.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }
    if (!auth.agent.orgId) {
        return Response.json({ error: "Agent has no organization" }, { status: 403 });
    }

    try {
        const resolved = await getAgentCapabilities(auth.agent.agentId, auth.agent.orgId);
        const capabilities = resolved.map((c) => {
            const mod = MOD_REGISTRY.find((m) => m.id === c.modId);
            return {
                key: c.key,
                name: c.name,
                modId: c.modId,
                slug: mod?.slug ?? c.modId.replace(/^mod-/, ""),
                requiredKeys: mod?.requiredKeys ?? [],
            };
        });
        return Response.json({ agentId: auth.agent.agentId, count: capabilities.length, capabilities });
    } catch (err) {
        console.error("GET /v1/capabilities error:", err);
        return Response.json({ error: "Failed to resolve capabilities" }, { status: 500 });
    }
}
