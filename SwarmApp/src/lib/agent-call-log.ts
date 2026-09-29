/**
 * Agent Call Log — comprehensive, low-footprint record of every
 * agent-authenticated request through the platform.
 *
 * Rather than instrument every /v1/* route individually, this hooks into
 * the two shared auth primitives every agent-authenticated route already
 * funnels through: verifyAgentRequest() (Ed25519) in src/app/api/v1/verify.ts
 * and authenticateAgent() (API key) in src/app/api/webhooks/auth.ts, plus
 * requireGatewayAuth() in src/lib/auth-guard.ts for gateway workers. A
 * single successful auth = one logged call, agnostic of which of the ~20
 * routes it hit.
 *
 * Ed25519 callers sign a message of the form "{METHOD}:{path}:...", so the
 * endpoint can be recovered for free; API-key callers have no such message,
 * so their calls are logged without an endpoint (still counted).
 *
 * Fire-and-forget — logAgentCall() is never awaited by its callers, so a
 * slow/failed write never adds latency or errors to the actual API request.
 *
 * Server-only (Firebase Admin SDK) — never import into client code.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

const COLLECTION = "agentCallLog";

export type AgentAuthMethod = "ed25519" | "apikey" | "gateway";

export interface AgentCallLogInput {
  agentId: string;
  orgId: string;
  authMethod: AgentAuthMethod;
  method?: string;
  endpoint?: string;
}

/** Fire-and-forget. Never throws, never blocks the caller. */
export function logAgentCall(input: AgentCallLogInput): void {
  adminDb()
    .collection(COLLECTION)
    .add({ ...input, timestamp: FieldValue.serverTimestamp() })
    .catch(() => {});
}

// ── Aggregation for the admin dashboard ──

export interface AgentCallStats {
  periodDays: number;
  total: number;
  byAuthMethod: Record<string, number>;
  dailyVolume: { date: string; count: number }[];
  topAgents: { agentId: string; orgId: string; count: number }[];
  topEndpoints: { endpoint: string; count: number }[];
}

export async function getAgentCallStats(periodDays = 30): Promise<AgentCallStats> {
  const db = adminDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const cutoffTs = Timestamp.fromDate(cutoff);

  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await db.collection(COLLECTION).where("timestamp", ">=", cutoffTs).get();
    docs = snap.docs;
  } catch {
    const snap = await db.collection(COLLECTION).get();
    docs = snap.docs.filter((d) => {
      const ts = d.data().timestamp;
      const date = ts instanceof Timestamp ? ts.toDate() : null;
      return date !== null && date >= cutoff;
    });
  }

  const byAuthMethod: Record<string, number> = {};
  const agentCounts = new Map<string, { orgId: string; count: number }>();
  const endpointCounts = new Map<string, number>();
  const dailyMap = new Map<string, number>();
  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap.set(d.toISOString().split("T")[0], 0);
  }

  for (const doc of docs) {
    const data = doc.data();
    const authMethod = (data.authMethod as string) || "unknown";
    byAuthMethod[authMethod] = (byAuthMethod[authMethod] || 0) + 1;

    const agentId = data.agentId as string | undefined;
    if (agentId) {
      const existing = agentCounts.get(agentId) || { orgId: (data.orgId as string) || "", count: 0 };
      existing.count++;
      agentCounts.set(agentId, existing);
    }

    const endpoint = data.endpoint as string | undefined;
    if (endpoint) {
      endpointCounts.set(endpoint, (endpointCounts.get(endpoint) || 0) + 1);
    }

    const ts = data.timestamp;
    const date = ts instanceof Timestamp ? ts.toDate() : null;
    if (date) {
      const key = date.toISOString().split("T")[0];
      if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) || 0) + 1);
    }
  }

  const topAgents = Array.from(agentCounts.entries())
    .map(([agentId, v]) => ({ agentId, orgId: v.orgId, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topEndpoints = Array.from(endpointCounts.entries())
    .map(([endpoint, count]) => ({ endpoint, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    periodDays,
    total: docs.length,
    byAuthMethod,
    dailyVolume: Array.from(dailyMap.entries()).map(([date, count]) => ({
      date: date.slice(5),
      count,
    })),
    topAgents,
    topEndpoints,
  };
}
