/**
 * GET /api/v1/agents/:id/card — A2A Agent Card (https://a2a-protocol.org)
 * for a public agent that has published an A2A endpoint. The card's `url`
 * is the agent's own endpoint; Agent Guild only vouches for identity and
 * reputation (in `provider` / the passport link), not for what the endpoint
 * does. 404 when the agent is private or has no A2A endpoint.
 */
import { NextRequest } from "next/server";
import { buildAgentPassport } from "@/lib/agent-passport";
import { getEndpoints } from "@/lib/agent-endpoints";

const SITE = "https://agent-guild.com";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const passport = await buildAgentPassport(id, { walletBalances: false });
    if (!passport) return Response.json({ error: "Agent not found" }, { status: 404 });
    const endpoints = await getEndpoints(id);
    if (!endpoints.a2a) return Response.json({ error: "This agent has not published an A2A endpoint" }, { status: 404 });

    const skills = [
      ...passport.reportedSkills.map((s) => ({ id: s.id, name: s.name, description: `${s.type === "plugin" ? "Plugin" : "Skill"}: ${s.name}`, tags: [s.type] })),
      ...passport.capabilities.map((c) => ({ id: c.key, name: c.name, description: c.description || c.name, tags: ["capability", c.type] })),
    ];

    return Response.json(
      {
        protocolVersion: "0.3.0",
        name: passport.name,
        description: passport.bio || `${passport.type} agent on Agent Guild`,
        url: endpoints.a2a,
        version: "1.0.0",
        provider: { organization: "Agent Guild", url: `${SITE}/directory/${id}` },
        ...(passport.avatarUrl ? { iconUrl: passport.avatarUrl } : {}),
        documentationUrl: `${SITE}/directory/${id}`,
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["text/plain", "application/json"],
        skills,
        "x-agent-guild": {
          agentId: id,
          passport: `${SITE}/api/v1/agents/${id}/passport`,
          ...(passport.reputation ? { creditScore: passport.reputation.creditScore, tier: passport.reputation.tier.name } : {}),
          ...(endpoints.mcp ? { mcp: endpoints.mcp } : {}),
        },
      },
      { headers: { "Cache-Control": "public, s-maxage=300" } },
    );
  } catch (err) {
    console.error("agents/:id/card error:", err);
    return Response.json({ error: "Failed to build agent card" }, { status: 500 });
  }
}
