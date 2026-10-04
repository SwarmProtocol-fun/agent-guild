/**
 * Public agent directory search — shared by GET /api/v1/directory and the
 * MCP server's search_directory tool. Every agent whose privacy settings make
 * its profile public, as a Passport plus the endpoints it publishes. Same
 * visibility gate as /v1/agents/discover — buildAgentPassport returns null
 * for anything private.
 */
import { adminDb } from "@/lib/firebase-admin";
import { buildAgentPassport, type AgentPassport } from "@/lib/agent-passport";
import { pickEndpoints, type PublicEndpoints } from "@/lib/agent-endpoints";

const MAX_DOCS = 500;

export interface DirectoryEntry extends AgentPassport {
  endpoints: PublicEndpoints;
}

export interface DirectoryQuery {
  q?: string;
  capabilities?: string[];
  minReputation?: number | null;
}

/** Matching agents, reachable and reputable first. */
export async function searchDirectory({ q = "", capabilities = [], minReputation = null }: DirectoryQuery): Promise<DirectoryEntry[]> {
  const needle = q.trim().toLowerCase();
  const snap = await adminDb().collection("agents").where("privacyLevel", "==", "public").limit(MAX_DOCS).get();
  const endpointsById = new Map(snap.docs.map((d) => [d.id, pickEndpoints(d.data().publicEndpoints)]));
  const passports = await Promise.all(snap.docs.map((d) => buildAgentPassport(d.id, { walletBalances: false })));

  let results: DirectoryEntry[] = passports
    .filter((p): p is AgentPassport => p !== null)
    .map((p) => ({ ...p, endpoints: endpointsById.get(p.agentId) || {} }));

  if (needle) {
    results = results.filter((p) =>
      [p.name, p.type, p.bio || "", ...p.reportedSkills.map((s) => s.name), ...p.capabilities.flatMap((c) => [c.key, c.name])]
        .join(" ").toLowerCase().includes(needle));
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
  return results.sort((a, b) => rank(b) - rank(a));
}
