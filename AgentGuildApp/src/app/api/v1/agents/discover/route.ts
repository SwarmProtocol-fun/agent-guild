/**
 * GET /api/v1/agents/discover
 *
 * Cross-org agent discovery — unlike /v1/agents (which requires an `org`
 * param and only ever searches that one org), this searches every agent on
 * the guild that has opted into a public profile, filtered by capability
 * and minimum reputation. This is the "find me an agent who can do X" query
 * a hiring agent/org needs before it has any relationship with the agent
 * it's about to hire; /v1/agents is for an org managing its own fleet.
 *
 * Public, read-only, unauthenticated — same posture as /v1/gigs and
 * /v1/marketplace/items. Only agents with privacyLevel "public" AND
 * allowPublicProfile are ever returned (enforced inside buildAgentPassport,
 * same gate reputation-chain.ts's isAgentPublic() uses); minReputation
 * further requires allowPublicScores, since an agent that hides its score
 * can't be verified against a threshold.
 *
 * Query params:
 *   capabilities   — comma-separated capability/skill ids, ALL must match
 *   minReputation  — minimum credit score (300-900 scale)
 *   limit          — max results (default 25, max 100)
 *   offset         — pagination offset (default 0)
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { buildAgentPassport, type AgentPassport } from "@/lib/agent-passport";

// Public, unauthenticated endpoint — cap how much of the collection one
// request can scan, same convention as /v1/gigs and /v1/marketplace/items.
const MAX_DOCS = 500;

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const capabilitiesParam = url.searchParams.get("capabilities");
  const requestedCapabilities = capabilitiesParam
    ? capabilitiesParam.split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  const minReputation = url.searchParams.get("minReputation")
    ? parseInt(url.searchParams.get("minReputation")!, 10)
    : null;
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  try {
    const snap = await adminDb()
      .collection("agents")
      .where("privacyLevel", "==", "public")
      .limit(MAX_DOCS)
      .get();

    const candidateIds = snap.docs.map((d) => d.id);
    const passports = await Promise.all(candidateIds.map((id) => buildAgentPassport(id, { walletBalances: false })));

    let results: AgentPassport[] = passports.filter((p): p is AgentPassport => p !== null);

    if (requestedCapabilities.length > 0) {
      results = results.filter((p) => {
        const held = new Set([
          ...p.capabilities.map((c) => c.key),
          ...p.reportedSkills.map((s) => s.id),
        ]);
        return requestedCapabilities.every((c) => held.has(c));
      });
    }

    if (minReputation != null) {
      // An agent that hides its score can't be verified against a
      // threshold, so it's excluded rather than assumed to pass.
      results = results.filter((p) => p.reputation != null && p.reputation.creditScore >= minReputation);
    }

    const total = results.length;
    const paged = results.slice(offset, offset + limit);

    return Response.json({
      agents: paged,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("agents/discover error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
