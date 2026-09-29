/**
 * Workflow Engine — DAG Executor.
 *
 * Server-orchestrated, Firestore-durable execution engine.
 *
 * Execution model:
 *   1. Client creates a run → all nodes start as "pending"
 *   2. Client polls `advanceRun(runId)` repeatedly
 *   3. Each poll: compute ready set → execute ONE ready node → persist → return
 *   4. Run completes when all nodes are terminal (completed/failed/skipped)
 *
 * Fits within Netlify's 10s serverless timeout — one node per poll.
 */

import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowNode,
  WorkflowEdge,
  NodeRunState,
  NodeRunStatus,
  NodeExecutionResult,
  RunStatus,
  WorkflowNodeType,
  QAGate,
} from "./types";
import {
  getWorkflowDefinition,
  getWorkflowRun,
  updateWorkflowRun,
  createWorkflowRun,
  addStepLog,
} from "./store";
import { getNodeHandler } from "./nodes";
import { evaluateGate } from "./packs";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default per-node timeout if none specified (5 minutes) */
const DEFAULT_NODE_TIMEOUT_MS = 5 * 60 * 1000;
/** Default global run timeout (30 minutes) */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

// ── DAG utilities ────────────────────────────────────────────────────────────

/** Compute topological order of nodes. Throws if cycle detected. */
export function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adj.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adj.get(current) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error("Workflow contains a cycle — not a valid DAG");
  }

  return sorted;
}

/** Get IDs of parent nodes (nodes with edges pointing to this node) */
function getParents(nodeId: string, edges: WorkflowEdge[]): string[] {
  return edges.filter((e) => e.to === nodeId).map((e) => e.from);
}

/** Check if a node status is terminal */
function isTerminal(status: NodeRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

/** Compute which nodes are ready to execute */
function computeReadySet(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  nodeStates: Record<string, NodeRunState>,
): string[] {
  const ready: string[] = [];

  for (const node of nodes) {
    const state = nodeStates[node.id];
    if (!state || state.status !== "pending") continue;

    const parents = getParents(node.id, edges);

    // Node is ready if ALL parents are completed (or there are no parents)
    const allParentsCompleted = parents.every((pid) => {
      const ps = nodeStates[pid];
      return ps && ps.status === "completed";
    });

    // If any parent failed/cancelled, skip this node
    const anyParentFailed = parents.some((pid) => {
      const ps = nodeStates[pid];
      return ps && (ps.status === "failed" || ps.status === "cancelled");
    });

    if (anyParentFailed) {
      // Mark as skipped (cascade failure)
      ready.push(node.id); // Will be handled specially
    } else if (allParentsCompleted) {
      ready.push(node.id);
    }
  }

  return ready;
}

/** Merge outputs from upstream nodes into inputs for a node */
function collectInputs(
  nodeId: string,
  edges: WorkflowEdge[],
  nodeStates: Record<string, NodeRunState>,
): Record<string, unknown> {
  const parents = getParents(nodeId, edges);
  const inputs: Record<string, unknown> = {};

  for (const parentId of parents) {
    const parentState = nodeStates[parentId];
    if (parentState?.output !== undefined) {
      inputs[parentId] = parentState.output;
    }
  }

  return inputs;
}

/** Calculate overall progress */
function calculateProgress(
  nodeStates: Record<string, NodeRunState>,
  totalNodes: number,
): number {
  if (totalNodes === 0) return 100;
  const completed = Object.values(nodeStates).filter((s) =>
    isTerminal(s.status),
  ).length;
  return Math.round((completed / totalNodes) * 100);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new workflow run from a definition.
 * Initializes all nodes as "pending", marks trigger nodes as "ready".
 */
export async function startRun(
  workflowId: string,
  triggeredBy: string,
  triggerInput?: Record<string, unknown>,
): Promise<string> {
  const def = await getWorkflowDefinition(workflowId);
  if (!def) throw new Error("Workflow definition not found");
  if (!def.enabled) throw new Error("Workflow is disabled");

  // Validate DAG
  topologicalSort(def.nodes, def.edges);

  // Initialize node states
  const nodeStates: Record<string, NodeRunState> = {};
  for (const node of def.nodes) {
    const parents = getParents(node.id, def.edges);
    nodeStates[node.id] = {
      nodeId: node.id,
      status: parents.length === 0 ? "ready" : "pending",
      retriesUsed: 0,
    };
  }

  // Create run
  const runId = await createWorkflowRun({
    workflowId,
    workflowVersion: def.version,
    orgId: def.orgId,
    status: "running",
    nodeStates,
    triggerInput,
    progress: 0,
    triggeredBy,
  });

  return runId;
}

/** Fire-and-forget step log — never crashes execution */
function log(
  runId: string,
  nodeId: string,
  nodeLabel: string,
  nodeType: WorkflowNodeType,
  level: "info" | "warn" | "error" | "debug",
  message: string,
  metadata?: Record<string, unknown>,
): void {
  void addStepLog({
    runId,
    nodeId,
    nodeLabel,
    nodeType,
    level,
    message,
    metadata,
    timestamp: Date.now(),
  }).catch(() => {});
}

/**
 * Advance a workflow run by one step.
 *
 * Picks ONE ready node, executes it, persists the result, and
 * recomputes the ready set. Returns the updated run.
 *
 * Call this in a polling loop until run.status is terminal.
 */
export async function advanceRun(
  runId: string,
): Promise<WorkflowRun> {
  const run = await getWorkflowRun(runId);
  if (!run) throw new Error("Run not found");

  // Terminal states — nothing to do
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  if (run.status === "paused") {
    return run;
  }

  // Load definition
  const def = await getWorkflowDefinition(run.workflowId);
  if (!def) throw new Error("Workflow definition not found");

  // ── Global run timeout check ──────────────────────────────────────────────
  const runCreatedMs =
    typeof run.createdAt === "number"
      ? run.createdAt
      : (run.createdAt as { toMillis?: () => number })?.toMillis?.() ?? Date.now();
  if (Date.now() - runCreatedMs > DEFAULT_RUN_TIMEOUT_MS) {
    await cancelRun(runId);
    return (await getWorkflowRun(runId))!;
  }

  const nodeMap = new Map(def.nodes.map((n) => [n.id, n]));
  const nodeStates = { ...run.nodeStates };

  // ── Timeout enforcement for stale "running" nodes ─────────────────────────
  for (const [nodeId, state] of Object.entries(nodeStates)) {
    if (state.status === "running" && state.startedAt) {
      const node = nodeMap.get(nodeId);
      const nodeTimeout =
        (node?.config as { timeoutMs?: number })?.timeoutMs || DEFAULT_NODE_TIMEOUT_MS;

      // Check for delay nodes that have elapsed
      const output = state.output as { _delayUntil?: number } | undefined;
      if (node?.type === "delay" && output?._delayUntil) {
        if (Date.now() >= output._delayUntil) {
          nodeStates[nodeId] = {
            ...state,
            status: "completed",
            completedAt: Date.now(),
          };
          log(runId, nodeId, node.label, node.type, "info", "Delay elapsed — node completed");
          continue;
        }
      }

      // Timeout check
      if (Date.now() - state.startedAt > nodeTimeout) {
        const timeoutSec = Math.round(nodeTimeout / 1000);
        nodeStates[nodeId] = {
          ...state,
          status: "failed",
          error: `Node timed out after ${timeoutSec}s`,
          completedAt: Date.now(),
        };
        log(
          runId, nodeId, node?.label || nodeId, node?.type || "transform",
          "error", `Node timed out after ${timeoutSec}s`,
        );
      }
    }
  }

  // Compute ready set
  const readyIds = computeReadySet(def.nodes, def.edges, nodeStates);

  if (readyIds.length === 0) {
    // Check if all nodes are terminal
    const allTerminal = def.nodes.every((n) => isTerminal(nodeStates[n.id]?.status));
    if (allTerminal) {
      // Collect outputs from output nodes
      const outputs: Record<string, unknown> = {};
      for (const node of def.nodes) {
        if (node.type === "output" && nodeStates[node.id]?.output !== undefined) {
          outputs[node.id] = nodeStates[node.id].output;
        }
      }

      // Check if any node failed
      const anyFailed = Object.values(nodeStates).some((s) => s.status === "failed");

      await updateWorkflowRun(runId, {
        status: anyFailed ? "failed" : "completed",
        nodeStates,
        outputs,
        progress: 100,
        completedAt: Date.now(),
      });

      return (await getWorkflowRun(runId))!;
    }

    // Some nodes still running — nothing ready yet, wait
    return run;
  }

  // Pick the first ready node (topological order priority)
  const topoOrder = topologicalSort(def.nodes, def.edges);
  const nextId = topoOrder.find((id) => readyIds.includes(id));
  if (!nextId) return run;

  const node = nodeMap.get(nextId);
  if (!node) return run;

  const parents = getParents(nextId, def.edges);

  // Check for cascade failure/skip
  const anyParentFailed = parents.some((pid) => {
    const ps = nodeStates[pid];
    return ps && (ps.status === "failed" || ps.status === "cancelled");
  });

  if (anyParentFailed) {
    // Skip this node and cascade
    nodeStates[nextId] = {
      ...nodeStates[nextId],
      status: "skipped",
      completedAt: Date.now(),
    };
    log(runId, nextId, node.label, node.type, "info", "Node skipped — upstream dependency failed");
  } else {
    // Execute the node
    const inputs = collectInputs(nextId, def.edges, nodeStates);

    // Include trigger input for root nodes
    if (parents.length === 0 && run.triggerInput) {
      Object.assign(inputs, { _trigger: run.triggerInput });
    }

    // Mark as running
    nodeStates[nextId] = {
      ...nodeStates[nextId],
      status: "running",
      inputs,
      startedAt: Date.now(),
    };
    log(runId, nextId, node.label, node.type, "info", "Node started", {
      inputKeys: Object.keys(inputs),
    });

    try {
      const handler = getNodeHandler(node.type);
      const result: NodeExecutionResult = await handler.execute(node, inputs, run);

      nodeStates[nextId] = {
        ...nodeStates[nextId],
        status: result.status,
        output: result.output,
        error: result.error,
        externalRef: result.externalRef,
        completedAt: isTerminal(result.status) ? Date.now() : undefined,
      };

      if (result.status === "completed") {
        log(runId, nextId, node.label, node.type, "info", "Node completed", {
          hasOutput: result.output !== undefined,
        });

        // ── QA Gate evaluation ──────────────────────────────────────────
        if (def.qaGates?.length) {
          const gate = def.qaGates.find((g) => g.afterNodeId === nextId);
          if (gate && result.output && typeof result.output === "object") {
            const { passed, failures } = evaluateGate(
              gate as Parameters<typeof evaluateGate>[0],
              result.output as Record<string, unknown>,
            );

            if (!passed) {
              for (const rule of failures) {
                log(runId, nextId, node.label, node.type, "warn",
                  `QA gate: "${rule.name}" failed on field "${rule.field}"`,
                  { operator: rule.operator, expected: rule.value, onFail: rule.onFail },
                );

                if (rule.onFail === "block") {
                  nodeStates[nextId] = {
                    ...nodeStates[nextId],
                    status: "failed",
                    error: `QA gate blocked: ${rule.name}`,
                    completedAt: Date.now(),
                  };
                } else if (
                  rule.onFail === "retry" &&
                  nodeStates[nextId].retriesUsed < (rule.maxRetries ?? 1)
                ) {
                  nodeStates[nextId] = {
                    ...nodeStates[nextId],
                    status: "ready",
                    retriesUsed: nodeStates[nextId].retriesUsed + 1,
                    error: undefined,
                    output: undefined,
                  };
                }
                // "warn" — log only, no status change
                // "route_to" — future: mark target node as ready
              }
            }
          }
        }
      }

      // Handle retry on failure
      if (result.status === "failed" && node.retries && nodeStates[nextId].retriesUsed < node.retries) {
        const attempt = nodeStates[nextId].retriesUsed + 1;
        nodeStates[nextId] = {
          ...nodeStates[nextId],
          status: "ready", // Re-queue for retry
          retriesUsed: attempt,
          error: undefined,
        };
        log(runId, nextId, node.label, node.type, "warn",
          `Node retrying (attempt ${attempt}/${node.retries})`,
          { previousError: result.error },
        );
      } else if (result.status === "failed") {
        log(runId, nextId, node.label, node.type, "error", `Node failed: ${result.error}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      nodeStates[nextId] = {
        ...nodeStates[nextId],
        status: "failed",
        error: errorMsg,
        completedAt: Date.now(),
      };

      // Retry logic
      if (node.retries && nodeStates[nextId].retriesUsed < node.retries) {
        const attempt = nodeStates[nextId].retriesUsed + 1;
        nodeStates[nextId] = {
          ...nodeStates[nextId],
          status: "ready",
          retriesUsed: attempt,
          error: undefined,
        };
        log(runId, nextId, node.label, node.type, "warn",
          `Node retrying (attempt ${attempt}/${node.retries})`,
          { previousError: errorMsg },
        );
      } else {
        log(runId, nextId, node.label, node.type, "error", `Node failed: ${errorMsg}`);
      }
    }
  }

  // Recompute overall status
  const allTerminal = def.nodes.every((n) => isTerminal(nodeStates[n.id]?.status));
  const anyRunning = Object.values(nodeStates).some((s) => s.status === "running");

  let newStatus: RunStatus = run.status;
  if (allTerminal) {
    const anyFailed = Object.values(nodeStates).some((s) => s.status === "failed");
    newStatus = anyFailed ? "failed" : "completed";
  } else if (anyRunning) {
    newStatus = "running";
  }

  const progress = calculateProgress(nodeStates, def.nodes.length);

  // Collect outputs if completed
  const outputs: Record<string, unknown> = {};
  if (newStatus === "completed" || newStatus === "failed") {
    for (const n of def.nodes) {
      if (n.type === "output" && nodeStates[n.id]?.output !== undefined) {
        outputs[n.id] = nodeStates[n.id].output;
      }
    }
  }

  await updateWorkflowRun(runId, {
    status: newStatus,
    nodeStates,
    progress,
    ...(newStatus === "completed" || newStatus === "failed"
      ? { outputs, completedAt: Date.now() }
      : {}),
  });

  return (await getWorkflowRun(runId))!;
}

/**
 * Cancel a running workflow.
 */
export async function cancelRun(runId: string): Promise<void> {
  const run = await getWorkflowRun(runId);
  if (!run) throw new Error("Run not found");
  if (run.status === "completed" || run.status === "cancelled") return;

  const nodeStates = { ...run.nodeStates };
  for (const [id, state] of Object.entries(nodeStates)) {
    if (!isTerminal(state.status)) {
      nodeStates[id] = { ...state, status: "cancelled", completedAt: Date.now() };
    }
  }

  await updateWorkflowRun(runId, {
    status: "cancelled",
    nodeStates,
    progress: calculateProgress(nodeStates, Object.keys(nodeStates).length),
    completedAt: Date.now(),
  });
}

/**
 * Pause a running workflow (resumes on next advanceRun call after unpausing).
 */
export async function pauseRun(runId: string): Promise<void> {
  await updateWorkflowRun(runId, { status: "paused" });
}

/**
 * Resume a paused workflow.
 */
export async function resumeRun(runId: string): Promise<void> {
  const run = await getWorkflowRun(runId);
  if (!run) throw new Error("Run not found");
  if (run.status !== "paused") return;
  await updateWorkflowRun(runId, { status: "running" });
}

/**
 * Validate a workflow definition.
 * Returns errors if the DAG is invalid.
 */
export function validateWorkflow(
  def: Pick<WorkflowDefinition, "nodes" | "edges">,
): string[] {
  const errors: string[] = [];

  if (def.nodes.length === 0) {
    errors.push("Workflow must have at least one node");
    return errors;
  }

  // Check for cycles
  try {
    topologicalSort(def.nodes, def.edges);
  } catch {
    errors.push("Workflow contains a cycle — must be a DAG");
  }

  // Check for orphan nodes (no edges)
  const connectedIds = new Set<string>();
  for (const edge of def.edges) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }
  if (def.nodes.length > 1) {
    for (const node of def.nodes) {
      if (!connectedIds.has(node.id)) {
        errors.push(`Node "${node.label}" (${node.id}) is disconnected`);
      }
    }
  }

  // Check for trigger nodes
  const triggers = def.nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) {
    errors.push("Workflow must have at least one trigger node");
  }

  // Check for dangling edges
  const nodeIds = new Set(def.nodes.map((n) => n.id));
  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge references non-existent source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge references non-existent target node: ${edge.to}`);
    }
  }

  return errors;
}

// ── Rerun from step ─────────────────────────────────────────────────────────

/** BFS forward through edges to collect the target node + all transitive downstream dependents */
function getDownstream(
  startId: string,
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) adj.get(edge.from)?.push(edge.to);

  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const child of adj.get(current) || []) {
      queue.push(child);
    }
  }
  return visited;
}

/**
 * Create a new run that replays from a specific node.
 *
 * Copies completed node states from the original run up to (but not including)
 * the target node and its downstream dependents, which reset to pending/ready.
 */
export async function rerunFromStep(
  originalRunId: string,
  fromNodeId: string,
  triggeredBy: string,
): Promise<string> {
  const originalRun = await getWorkflowRun(originalRunId);
  if (!originalRun) throw new Error("Original run not found");

  const def = await getWorkflowDefinition(originalRun.workflowId);
  if (!def) throw new Error("Workflow definition not found");

  if (!def.nodes.some((n) => n.id === fromNodeId)) {
    throw new Error(`Node ${fromNodeId} not found in workflow`);
  }

  const downstream = getDownstream(fromNodeId, def.edges, def.nodes);

  const nodeStates: Record<string, NodeRunState> = {};
  for (const node of def.nodes) {
    if (downstream.has(node.id)) {
      // Reset — mark as ready if all parents are outside the downstream set
      const parents = getParents(node.id, def.edges);
      const allParentsUpstream = parents.every((pid) => !downstream.has(pid));
      nodeStates[node.id] = {
        nodeId: node.id,
        status: allParentsUpstream ? "ready" : "pending",
        retriesUsed: 0,
      };
    } else {
      // Preserve from original run
      nodeStates[node.id] = { ...originalRun.nodeStates[node.id] };
    }
  }

  const runId = await createWorkflowRun({
    workflowId: originalRun.workflowId,
    workflowVersion: def.version,
    orgId: originalRun.orgId,
    status: "running",
    nodeStates,
    triggerInput: originalRun.triggerInput,
    progress: 0,
    triggeredBy,
  });

  return runId;
}
