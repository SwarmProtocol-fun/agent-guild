/**
 * GET /api/v1/directory?q=&capabilities=&minReputation=&limit=&offset=
 *
 * Public agent directory: every agent whose privacy settings make its profile
 * public, as a Passport (identity, skills, reputation where allowed) plus the
 * endpoints it publishes (MCP / A2A / website). Same visibility gate as
 * /v1/agents/discover — buildAgentPassport returns null for anything private.
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { buildAgentPassport, type AgentPassport } from "@/lib/agent-passport";
import { pickEndpoints, type PublicEndpoints } from "@/lib/agent-endpoints";

const MAX_DOCS = 500;

export interface DirectoryEntry extends AgentPassport {
  endpoints: PublicEndpoints;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim().toLowerCase();
  const capabilities = (sp.get("capabilities") || "").split(",").map((c) => c.trim()).filter(Boolean);
  const minReputation = sp.get("minReputation") ? parseInt(sp.get("minReputation")!, 10) : null;
  const limit = Math.min(parseInt(sp.get("limit") || "24", 10) || 24, 100);
  const offset = Math.max(parseInt(sp.get("offset") || "0", 10) || 0, 0);

  try {
    const snap = await adminDb().collection("agents").where("privacyLevel", "==", "public").limit(MAX_DOCS).get();
    const endpointsById = new Map(snap.docs.map((d) => [d.id, pickEndpoints(d.data().publicEndpoints)]));
    const passports = await Promise.all(snap.docs.map((d) => buildAgentPassport(d.id, { walletBalances: false })));

    let results: DirectoryEntry[] = passports
      .filter((p): p is AgentPassport => p !== null)
      .map((p) => ({ ...p, endpoints: endpointsById.get(p.agentId) || {} }));

    if (q) {
      results = results.filter((p) =>
        [p.name, p.type, p.bio || "", ...p.reportedSkills.map((s) => s.name), ...p.capabilities.flatMap((c) => [c.key, c.name])]
          .join(" ").toLowerCase().includes(q));
    }
    if (capabilities.length) {
      results = results.filter((p) => {
        const held = new Set([...p.capabilities.map((c) => c.key), ...p.reportedSkills.map((s) => s.id)]);
        return capabilities.every((c) => held.has(c));
      });
    }
    if (minReputation != null) {
      results = results.filter((p) => p.reputation != null && p.reputation.creditScore >= minReputation);
    }

    // Reachable and reputable first: online, then published endpoints, then score.
    const rank = (p: DirectoryEntry) =>
      (p.status === "online" ? 2000 : 0) + (Object.keys(p.endpoints).length ? 1000 : 0) + (p.reputation?.creditScore ?? 0);
    results.sort((a, b) => rank(b) - rank(a));

    return Response.json(
      { agents: results.slice(offset, offset + limit), total: results.length, limit, offset, hasMore: offset + limit < results.length },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (err) {
    console.error("directory error:", err);
    return Response.json({ error: "Failed to load directory" }, { status: 500 });
  }
}
