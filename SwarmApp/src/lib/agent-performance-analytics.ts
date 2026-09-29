/**
 * Agent / Swarm Performance Analytics — platform-wide job, workflow,
 * task-assignment, and delegation success rates, plus agent health.
 *
 * Follows the fetch-then-reduce pattern from platform-analytics.ts:
 * one windowed Firestore read per collection, all rate/bucket math done
 * in memory (Firestore has no server-side GROUP BY).
 *
 * Server-only (Firebase Admin SDK) — never import into client code.
 */

import { adminDb } from "./firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { getAgentCallStats, type AgentCallStats } from "./agent-call-log";

// ── Types ──

export interface AgentHealthCounts {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  paused: number;
}

export interface OutcomeCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** In-flight (queued/claimed/running/pending) */
  active: number;
  /** completed / (completed + failed [+ timeout]), 0 when no terminal outcomes yet */
  successRate: number;
}

export interface DailyThroughputPoint {
  date: string; // MM-DD
  jobs: number;
  workflows: number;
  assignments: number;
}

export interface TopAgent {
  agentId: string;
  name: string;
  orgId: string;
  tasksCompleted: number;
}

export interface AgentPerformanceOverview {
  periodDays: number;
  agents: AgentHealthCounts;
  jobs: OutcomeCounts;
  workflows: OutcomeCounts;
  taskAssignments: OutcomeCounts;
  delegations: OutcomeCounts;
  dailyThroughput: DailyThroughputPoint[];
  topAgents: TopAgent[];
  /** Every agent-authenticated API call through the platform (v1 routes + gateway workers). */
  apiCalls: AgentCallStats;
}

// ── Helpers ──

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  if (typeof val === "object" && val !== null && "seconds" in val) {
    return new Date((val as { seconds: number }).seconds * 1000);
  }
  return null;
}

function dateKey(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Query a collection for docs where `tsField >= cutoff`, ordered by the same
 * field (no composite index needed). Falls back to a full scan + in-memory
 * filter if the range query throws (e.g. missing index), matching the
 * defensive pattern used in the marketplace revenue route.
 */
async function fetchWindowed(
  collection: string,
  tsField: string,
  cutoff: Date,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const db = adminDb();
  const cutoffTs = Timestamp.fromDate(cutoff);
  try {
    const snap = await db
      .collection(collection)
      .where(tsField, ">=", cutoffTs)
      .orderBy(tsField, "desc")
      .get();
    return snap.docs;
  } catch {
    const snap = await db.collection(collection).get();
    return snap.docs.filter((d) => {
      const ts = toDate(d.data()[tsField]);
      return ts !== null && ts >= cutoff;
    });
  }
}

// ── Main aggregation ──

export async function getAgentPerformanceOverview(
  periodDays = 30,
): Promise<AgentPerformanceOverview> {
  const db = adminDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const [
    agentsSnap,
    heartbeatsSnap,
    pausedAgg,
    jobDocs,
    workflowDocs,
    assignmentDocs,
    delegationDocs,
    topAgentsSnap,
    apiCalls,
  ] = await Promise.all([
    db.collection("agents").count().get(),
    db.collection("agentHeartbeats").get(),
    db.collection("agents").where("status", "==", "paused").count().get(),
    fetchWindowed("gatewayTaskQueue", "createdAt", cutoff),
    fetchWindowed("workflowRuns", "createdAt", cutoff),
    fetchWindowed("taskAssignments", "createdAt", cutoff),
    fetchWindowed("delegations", "delegatedAt", cutoff),
    db.collection("agents").orderBy("tasksCompleted", "desc").limit(10).get().catch(() => null),
    getAgentCallStats(periodDays),
  ]);

  // ── Agent health (from live heartbeat staleness, not the stored field) ──
  const HB_ONLINE_MS = 5 * 60 * 1000;
  const HB_DEGRADED_MS = 15 * 60 * 1000;
  let online = 0;
  let degraded = 0;
  let offline = 0;
  const nowMs = now.getTime();
  for (const doc of heartbeatsSnap.docs) {
    const lastSeen = toDate(doc.data().lastSeen);
    const elapsed = lastSeen ? nowMs - lastSeen.getTime() : Infinity;
    if (elapsed < HB_ONLINE_MS) online++;
    else if (elapsed < HB_DEGRADED_MS) degraded++;
    else offline++;
  }

  const agents: AgentHealthCounts = {
    total: agentsSnap.data().count,
    online,
    degraded,
    offline,
    paused: pausedAgg.data().count,
  };

  // ── Daily throughput bucket (last N days) ──
  const dailyMap = new Map<string, DailyThroughputPoint>();
  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap.set(dateKey(d), { date: dateKey(d).slice(5), jobs: 0, workflows: 0, assignments: 0 });
  }
  function bumpDaily(kind: "jobs" | "workflows" | "assignments", ts: Date | null) {
    if (!ts) return;
    const point = dailyMap.get(dateKey(ts));
    if (point) point[kind]++;
  }

  // ── Jobs (gatewayTaskQueue) ──
  let jobsCompleted = 0, jobsFailed = 0, jobsCancelled = 0, jobsActive = 0, jobsTimeout = 0;
  for (const doc of jobDocs) {
    const data = doc.data();
    const status = data.status as string;
    if (status === "completed") {
      jobsCompleted++;
      bumpDaily("jobs", toDate(data.completedAt) || toDate(data.createdAt));
    } else if (status === "failed") jobsFailed++;
    else if (status === "timeout") jobsTimeout++;
    else if (status === "cancelled") jobsCancelled++;
    else jobsActive++; // queued, claimed, running
  }
  const jobTerminal = jobsCompleted + jobsFailed + jobsTimeout;
  const jobs: OutcomeCounts = {
    total: jobDocs.length,
    completed: jobsCompleted,
    failed: jobsFailed + jobsTimeout,
    cancelled: jobsCancelled,
    active: jobsActive,
    successRate: jobTerminal > 0 ? Math.round((jobsCompleted / jobTerminal) * 100) : 0,
  };

  // ── Workflows (workflowRuns) ──
  let wfCompleted = 0, wfFailed = 0, wfCancelled = 0, wfActive = 0;
  for (const doc of workflowDocs) {
    const data = doc.data();
    const status = data.status as string;
    if (status === "completed") {
      wfCompleted++;
      bumpDaily("workflows", toDate(data.completedAt) || toDate(data.createdAt));
    } else if (status === "failed") wfFailed++;
    else if (status === "cancelled") wfCancelled++;
    else wfActive++; // pending, running, paused
  }
  const wfTerminal = wfCompleted + wfFailed;
  const workflows: OutcomeCounts = {
    total: workflowDocs.length,
    completed: wfCompleted,
    failed: wfFailed,
    cancelled: wfCancelled,
    active: wfActive,
    successRate: wfTerminal > 0 ? Math.round((wfCompleted / wfTerminal) * 100) : 0,
  };

  // ── Task assignments ──
  let asCompleted = 0, asRejected = 0, asOverdue = 0, asCancelled = 0, asActive = 0;
  for (const doc of assignmentDocs) {
    const data = doc.data();
    const status = data.status as string;
    if (status === "completed") {
      asCompleted++;
      bumpDaily("assignments", toDate(data.completedAt) || toDate(data.createdAt));
    } else if (status === "rejected") asRejected++;
    else if (status === "overdue") asOverdue++;
    else if (status === "cancelled") asCancelled++;
    else asActive++; // pending, accepted, in_progress
  }
  const asTerminal = asCompleted + asRejected + asOverdue + asCancelled;
  const taskAssignments: OutcomeCounts = {
    total: assignmentDocs.length,
    completed: asCompleted,
    failed: asRejected + asOverdue,
    cancelled: asCancelled,
    active: asActive,
    successRate: asTerminal > 0 ? Math.round((asCompleted / asTerminal) * 100) : 0,
  };

  // ── Delegations ──
  let delCompleted = 0, delFailed = 0, delActive = 0;
  for (const doc of delegationDocs) {
    const data = doc.data();
    const status = data.status as string;
    if (status === "completed") delCompleted++;
    else if (status === "failed") delFailed++;
    else delActive++; // pending, in_progress
  }
  const delTerminal = delCompleted + delFailed;
  const delegations: OutcomeCounts = {
    total: delegationDocs.length,
    completed: delCompleted,
    failed: delFailed,
    cancelled: 0,
    active: delActive,
    successRate: delTerminal > 0 ? Math.round((delCompleted / delTerminal) * 100) : 0,
  };

  // ── Top agents by tasks completed ──
  const topAgents: TopAgent[] = topAgentsSnap
    ? topAgentsSnap.docs.map((d) => {
        const data = d.data();
        return {
          agentId: d.id,
          name: (data.name as string) || d.id,
          orgId: (data.orgId as string) || "",
          tasksCompleted: (data.tasksCompleted as number) || 0,
        };
      })
    : [];

  return {
    periodDays,
    agents,
    jobs,
    workflows,
    taskAssignments,
    delegations,
    dailyThroughput: Array.from(dailyMap.values()),
    topAgents,
    apiCalls,
  };
}
