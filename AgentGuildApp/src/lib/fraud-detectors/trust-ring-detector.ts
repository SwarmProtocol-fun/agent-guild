/**
 * Trust Ring / Collusion Detector
 *
 * Detects small groups of agents that interact almost exclusively with
 * each other — forming a closed "trust ring" for mutual score inflation.
 *
 * Algorithm:
 * 1. Build undirected interaction graph from assignments + validations
 * 2. Find connected components of size ≤ maxSize
 * 3. Compute insularity = internal / total interactions per component
 * 4. Flag clusters where insularity > threshold AND sufficient volume
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

interface UndirectedGraph {
  adjacency: Map<string, Map<string, number>>; // nodeId → { neighborId → interaction count }
}

export async function detectTrustRings(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  const graph: UndirectedGraph = { adjacency: new Map() };

  function addEdge(a: string, b: string) {
    if (a === b) return;
    if (!graph.adjacency.has(a)) graph.adjacency.set(a, new Map());
    if (!graph.adjacency.has(b)) graph.adjacency.set(b, new Map());
    graph.adjacency.get(a)!.set(b, (graph.adjacency.get(a)!.get(b) || 0) + 1);
    graph.adjacency.get(b)!.set(a, (graph.adjacency.get(b)!.get(a) || 0) + 1);
  }

  // Build graph from task assignments
  const assignmentsSnap = await adminDb().collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  for (const d of assignmentsSnap.docs) {
    const data = d.data();
    const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
    if (createdAt < windowStart) continue;

    const fromId = data.fromAgentId;
    const toId = data.toAgentId;
    if (fromId && toId) addEdge(fromId, toId);
  }

  // Add validation stakes
  try {
    const stakesSnap = await adminDb().collection("validationStakes").get();
    for (const d of stakesSnap.docs) {
      const data = d.data();
      const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
      if (createdAt < windowStart) continue;

      const validatorId = data.validatorAgentId;
      // Need to resolve worker by ASN
      if (validatorId) {
        // Use validatorAgentId and any task-linked agent
        const taskId = data.taskId;
        if (taskId) {
          // We'll track validator-task relationships
          addEdge(validatorId, `task:${taskId}`);
        }
      }
    }
  } catch {
    // Non-critical
  }

  // Find connected components using BFS
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const nodeId of graph.adjacency.keys()) {
    if (visited.has(nodeId)) continue;
    if (nodeId.startsWith("task:")) continue; // Skip task pseudo-nodes

    const component: string[] = [];
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      if (!current.startsWith("task:")) {
        component.push(current);
      }

      const neighbors = graph.adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors.keys()) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }

    if (component.length >= 2 && component.length <= config.trustRingMaxSize) {
      components.push(component);
    }
  }

  // Evaluate each small component for insularity
  for (const component of components) {
    const componentSet = new Set(component);
    let internalInteractions = 0;
    let externalInteractions = 0;

    for (const nodeId of component) {
      const neighbors = graph.adjacency.get(nodeId);
      if (!neighbors) continue;

      for (const [neighborId, count] of neighbors) {
        if (neighborId.startsWith("task:")) continue;
        if (componentSet.has(neighborId)) {
          internalInteractions += count;
        } else {
          externalInteractions += count;
        }
      }
    }

    // Divide by 2 since we count edges from both sides
    internalInteractions = Math.floor(internalInteractions / 2);
    const totalInteractions = internalInteractions + externalInteractions;

    if (totalInteractions === 0) continue;
    if (internalInteractions < 10) continue; // Need minimum volume

    const insularity = internalInteractions / totalInteractions;

    if (insularity < config.trustRingInsularity) continue;

    // Determine severity
    const severity = insularity > 0.95 ? "critical" as const
      : insularity > 0.9 ? "high" as const
        : "medium" as const;

    const confidence = Math.min(1, insularity * (internalInteractions / 20));

    // Get details for all agents in the ring
    for (const agentId of component) {
      let agentAsn = "";
      try {
        const agentDoc = await adminDb().collection("agents").doc(agentId).get();
        if (agentDoc.exists) {
          agentAsn = agentDoc.data()!.asn || "";
        }
      } catch {
        // continue
      }

      signals.push({
        agentId,
        asn: agentAsn,
        orgId,
        signalType: "trust_ring",
        severity,
        confidence,
        evidence: {
          counterpartyIds: component.filter((id) => id !== agentId),
          windowStart: Math.floor(windowStart / 1000),
          windowEnd: Math.floor(windowEnd / 1000),
          metric: insularity,
          threshold: config.trustRingInsularity,
          description: `Trust ring of ${component.length} agents: ${internalInteractions} internal interactions, insularity ${(insularity * 100).toFixed(0)}% (${externalInteractions} external)`,
        },
        scanRunId,
        status: "active",
      });
    }
  }

  return signals;
}
