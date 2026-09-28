/**
 * Workflow Engine — Firestore persistence.
 *
 * Collections:
 *   workflowDefinitions — reusable DAG definitions
 *   workflowRuns         — execution instances
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import type {
  WorkflowDefinition,
  WorkflowRun,
  RunStatus,
  NodeRunState,
  StepLog,
} from "./types";

// ── Collections ──────────────────────────────────────────────────────────────

const DEFINITIONS = "workflowDefinitions";
const RUNS = "workflowRuns";
const STEP_LOGS = "workflowStepLogs";

// ── Workflow Definitions ─────────────────────────────────────────────────────

export async function createWorkflowDefinition(
  data: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt" | "version">,
): Promise<string> {
  const ref = await adminDb().collection(DEFINITIONS).add({
    ...data,
    version: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getWorkflowDefinition(
  id: string,
): Promise<WorkflowDefinition | null> {
  const snap = await adminDb().collection(DEFINITIONS).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as WorkflowDefinition;
}

export async function updateWorkflowDefinition(
  id: string,
  data: Partial<
    Pick<
      WorkflowDefinition,
      "name" | "description" | "nodes" | "edges" | "enabled"
    >
  >,
): Promise<void> {
  const ref = adminDb().collection(DEFINITIONS).doc(id);
  const current = await ref.get();
  if (!current.exists) throw new Error("Workflow not found");

  await ref.update({
    ...data,
    version: (current.data()!.version || 0) + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteWorkflowDefinition(id: string): Promise<void> {
  await adminDb().collection(DEFINITIONS).doc(id).delete();
}

export async function getOrgWorkflows(
  orgId: string,
  max = 50,
): Promise<WorkflowDefinition[]> {
  const snap = await adminDb()
    .collection(DEFINITIONS)
    .where("orgId", "==", orgId)
    .orderBy("updatedAt", "desc")
    .limit(max)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkflowDefinition);
}

// ── Workflow Runs ────────────────────────────────────────────────────────────

export async function createWorkflowRun(
  data: Omit<WorkflowRun, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  const ref = await adminDb().collection(RUNS).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getWorkflowRun(
  id: string,
): Promise<WorkflowRun | null> {
  const snap = await adminDb().collection(RUNS).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as WorkflowRun;
}

export async function updateWorkflowRun(
  id: string,
  data: Partial<
    Pick<
      WorkflowRun,
      "status" | "nodeStates" | "outputs" | "progress" | "error" | "completedAt"
    >
  >,
): Promise<void> {
  await adminDb().collection(RUNS).doc(id).update({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function getOrgRuns(
  orgId: string,
  status?: RunStatus,
  max = 50,
): Promise<WorkflowRun[]> {
  let q: Query = adminDb().collection(RUNS).where("orgId", "==", orgId);
  if (status) q = q.where("status", "==", status);
  q = q.orderBy("createdAt", "desc").limit(max);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkflowRun);
}

export async function getWorkflowRuns(
  workflowId: string,
  max = 20,
): Promise<WorkflowRun[]> {
  const snap = await adminDb()
    .collection(RUNS)
    .where("workflowId", "==", workflowId)
    .orderBy("createdAt", "desc")
    .limit(max)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkflowRun);
}

export async function getActiveRuns(orgId: string): Promise<WorkflowRun[]> {
  const snap = await adminDb()
    .collection(RUNS)
    .where("orgId", "==", orgId)
    .where("status", "in", ["pending", "running"])
    .limit(100)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkflowRun);
}

/**
 * Get all running/pending workflow runs globally (cross-org).
 * Used by the autonomous tick handler to advance workflows server-side.
 */
export async function getGlobalActiveRuns(max = 50): Promise<WorkflowRun[]> {
  const snap = await adminDb()
    .collection(RUNS)
    .where("status", "in", ["pending", "running"])
    .orderBy("updatedAt", "asc") // oldest first = fairness
    .limit(max)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkflowRun);
}

/**
 * Count active (running/pending) runs for a specific workflow definition.
 * Used by trigger system to enforce maxConcurrentRuns.
 */
export async function getWorkflowActiveRunCount(workflowId: string): Promise<number> {
  const snap = await adminDb()
    .collection(RUNS)
    .where("workflowId", "==", workflowId)
    .where("status", "in", ["pending", "running"])
    .limit(100)
    .get();
  return snap.size;
}

/** Update a single node's state within a run */
export async function updateNodeState(
  runId: string,
  nodeId: string,
  state: Partial<NodeRunState>,
): Promise<void> {
  const run = await getWorkflowRun(runId);
  if (!run) throw new Error("Run not found");

  const nodeStates = { ...run.nodeStates };
  nodeStates[nodeId] = { ...nodeStates[nodeId], ...state };

  await adminDb().collection(RUNS).doc(runId).update({
    nodeStates,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ── Step Logs ─────────────────────────────────────────────────────────────────

export async function addStepLog(
  log: Omit<StepLog, "id">,
): Promise<string> {
  const ref = await adminDb().collection(STEP_LOGS).add(log);
  return ref.id;
}

export async function getStepLogs(
  runId: string,
  nodeId?: string,
  max = 200,
): Promise<StepLog[]> {
  let q: Query = adminDb().collection(STEP_LOGS).where("runId", "==", runId);
  if (nodeId) q = q.where("nodeId", "==", nodeId);
  q = q.orderBy("timestamp", "asc").limit(max);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StepLog);
}
