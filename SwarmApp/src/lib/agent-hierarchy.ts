/**
 * Agent Hierarchy Management
 *
 * Manages parent-child agent relationships, delegation, and organizational trees.
 * Prevents circular dependencies and enforces hierarchy rules.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { logActivity } from "./activity";
import type { Agent } from "./firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AgentNode {
  agent: Agent;
  children: AgentNode[];
  depth: number;
}

export interface DelegationRecord {
  id: string;
  orgId: string;
  parentAgentId: string;
  parentAgentName: string;
  childAgentId: string;
  childAgentName: string;
  taskId?: string;
  taskTitle?: string;
  reason?: string;
  delegatedAt: Date | null;
  completedAt?: Date | null;
  status: "pending" | "in_progress" | "completed" | "failed";
}

// ═══════════════════════════════════════════════════════════════
// Hierarchy Management
// ═══════════════════════════════════════════════════════════════

/**
 * Add a child agent to a parent agent
 */
export async function addChildAgent(
  orgId: string,
  parentAgentId: string,
  childAgentId: string
): Promise<void> {
  if (parentAgentId === childAgentId) {
    throw new Error("An agent cannot be its own child");
  }

  // Check if adding this child would create a circular dependency
  const wouldCreateCycle = await checkCircularDependency(
    orgId,
    parentAgentId,
    childAgentId
  );
  if (wouldCreateCycle) {
    throw new Error(
      "Adding this child would create a circular dependency in the hierarchy"
    );
  }

  // Get both agents
  const parentDoc = await adminDb().collection("agents").doc(parentAgentId).get();
  const childDoc = await adminDb().collection("agents").doc(childAgentId).get();

  if (!parentDoc.exists || !childDoc.exists) {
    throw new Error("Parent or child agent not found");
  }

  const parent = parentDoc.data() as Agent;
  const child = childDoc.data() as Agent;

  if (parent.orgId !== orgId || child.orgId !== orgId) {
    throw new Error("Agents must belong to the same organization");
  }

  // Check if child already has a parent
  if (child.parentAgentId && child.parentAgentId !== parentAgentId) {
    throw new Error(
      `Child agent already has a parent (${child.parentAgentId})`
    );
  }

  // Calculate new hierarchy level for child
  const newHierarchyLevel = parent.hierarchyLevel + 1;

  // Update parent
  await adminDb().collection("agents").doc(parentAgentId).update({
    childAgentIds: FieldValue.arrayUnion(childAgentId),
  });

  // Update child
  await adminDb().collection("agents").doc(childAgentId).update({
    parentAgentId,
    hierarchyLevel: newHierarchyLevel,
  });

  // Log activity
  await logActivity({
    orgId,
    eventType: "agent_hierarchy_child_added" as any,
    actorType: "agent",
    actorId: parentAgentId,
    actorName: parent.name,
    targetType: "agent",
    targetId: childAgentId,
    targetName: child.name,
    description: `${parent.name} added ${child.name} as a child agent at level ${newHierarchyLevel}`,
    metadata: {
      hierarchyLevel: newHierarchyLevel,
    },
  });
}

/**
 * Remove a child agent from a parent agent
 */
export async function removeChildAgent(
  orgId: string,
  parentAgentId: string,
  childAgentId: string
): Promise<void> {
  const parentDoc = await adminDb().collection("agents").doc(parentAgentId).get();
  const childDoc = await adminDb().collection("agents").doc(childAgentId).get();

  if (!parentDoc.exists || !childDoc.exists) {
    throw new Error("Parent or child agent not found");
  }

  const parent = parentDoc.data() as Agent;
  const child = childDoc.data() as Agent;

  if (parent.orgId !== orgId || child.orgId !== orgId) {
    throw new Error("Agents must belong to the same organization");
  }

  // Update parent
  await adminDb().collection("agents").doc(parentAgentId).update({
    childAgentIds: FieldValue.arrayRemove(childAgentId),
  });

  // Update child (reset to root level)
  await adminDb().collection("agents").doc(childAgentId).update({
    parentAgentId: null,
    hierarchyLevel: 0,
  });

  // Log activity
  await logActivity({
    orgId,
    eventType: "agent_hierarchy_child_removed" as any,
    actorType: "agent",
    actorId: parentAgentId,
    actorName: parent.name,
    targetType: "agent",
    targetId: childAgentId,
    targetName: child.name,
    description: `${parent.name} removed ${child.name} as a child agent`,
    metadata: {},
  });
}

/**
 * Check if adding a child would create a circular dependency
 * Checks both ancestors (parent chain) and descendants (child chain)
 */
export async function checkCircularDependency(
  orgId: string,
  parentAgentId: string,
  childAgentId: string
): Promise<boolean> {
  // If child is an ancestor of parent, it would create a cycle
  const ancestors = await getAncestors(orgId, parentAgentId);
  if (ancestors.some((a) => a.id === childAgentId)) {
    return true;
  }

  // If parent is a descendant of child, it would also create a cycle
  const descendants = await getDescendants(orgId, childAgentId);
  if (descendants.some((d) => d.id === parentAgentId)) {
    return true;
  }

  return false;
}

/**
 * Get all ancestor agents (parent, grandparent, etc.)
 */
export async function getAncestors(
  orgId: string,
  agentId: string
): Promise<Agent[]> {
  const ancestors: Agent[] = [];
  let currentId = agentId;

  while (currentId) {
    const agentDoc = await adminDb().collection("agents").doc(currentId).get();
    if (!agentDoc.exists) break;

    const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
    if (agent.orgId !== orgId) break;
    if (!agent.parentAgentId) break;

    // Get parent
    const parentDoc = await adminDb().collection("agents").doc(agent.parentAgentId).get();
    if (!parentDoc.exists) break;

    const parent = { id: parentDoc.id, ...parentDoc.data() } as Agent;
    ancestors.push(parent);
    currentId = parent.parentAgentId || "";
  }

  return ancestors;
}

/**
 * Get all descendant agents (children, grandchildren, etc.)
 * Optimized: Fetches all agents once, builds tree in memory
 */
export async function getDescendants(
  orgId: string,
  agentId: string
): Promise<Agent[]> {
  // Fetch all agents for the organization at once
  const snapshot = await adminDb().collection("agents").where("orgId", "==", orgId).get();

  const agentMap = new Map<string, Agent>();
  snapshot.docs.forEach((doc) => {
    agentMap.set(doc.id, { id: doc.id, ...doc.data() } as Agent);
  });

  // Build descendants list using BFS with in-memory data
  const descendants: Agent[] = [];
  const queue: string[] = [agentId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const agent = agentMap.get(currentId);
    if (!agent) continue;

    if (agent.childAgentIds && agent.childAgentIds.length > 0) {
      for (const childId of agent.childAgentIds) {
        const child = agentMap.get(childId);
        if (child && !visited.has(childId)) {
          descendants.push(child);
          queue.push(childId);
        }
      }
    }
  }

  return descendants;
}

/**
 * Build a hierarchical tree structure for an agent and its descendants
 */
export async function getAgentTree(
  orgId: string,
  rootAgentId: string
): Promise<AgentNode> {
  const agentDoc = await adminDb().collection("agents").doc(rootAgentId).get();
  if (!agentDoc.exists) {
    throw new Error("Agent not found");
  }

  const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
  if (agent.orgId !== orgId) {
    throw new Error("Agent does not belong to this organization");
  }

  return buildTreeNode(agent, 0);
}

async function buildTreeNode(agent: Agent, depth: number): Promise<AgentNode> {
  const children: AgentNode[] = [];

  if (agent.childAgentIds && agent.childAgentIds.length > 0) {
    for (const childId of agent.childAgentIds) {
      const childDoc = await adminDb().collection("agents").doc(childId).get();
      if (childDoc.exists) {
        const child = { id: childDoc.id, ...childDoc.data() } as Agent;
        const childNode = await buildTreeNode(child, depth + 1);
        children.push(childNode);
      }
    }
  }

  return {
    agent,
    children,
    depth,
  };
}

/**
 * Get all root agents (agents with no parent)
 */
export async function getRootAgents(orgId: string): Promise<Agent[]> {
  const snapshot = await adminDb()
    .collection("agents")
    .where("orgId", "==", orgId)
    .where("hierarchyLevel", "==", 0)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Agent));
}

// ═══════════════════════════════════════════════════════════════
// Task Delegation
// ═══════════════════════════════════════════════════════════════

/**
 * Delegate a task from parent to child agent
 */
export async function delegateTask(
  orgId: string,
  parentAgentId: string,
  childAgentId: string,
  taskId?: string,
  reason?: string
): Promise<string> {
  const parentDoc = await adminDb().collection("agents").doc(parentAgentId).get();
  const childDoc = await adminDb().collection("agents").doc(childAgentId).get();

  if (!parentDoc.exists || !childDoc.exists) {
    throw new Error("Parent or child agent not found");
  }

  const parent = { id: parentDoc.id, ...parentDoc.data() } as Agent;
  const child = { id: childDoc.id, ...childDoc.data() } as Agent;

  if (parent.orgId !== orgId || child.orgId !== orgId) {
    throw new Error("Agents must belong to the same organization");
  }

  if (!parent.canDelegate) {
    throw new Error("Parent agent does not have delegation permission");
  }

  // Verify parent-child relationship
  if (
    !parent.childAgentIds ||
    !parent.childAgentIds.includes(childAgentId)
  ) {
    throw new Error("Child agent is not in parent's children list");
  }

  // Get task info if provided
  let taskTitle: string | undefined;
  if (taskId) {
    const taskDoc = await adminDb().collection("kanbanTasks").doc(taskId).get();
    if (taskDoc.exists) {
      taskTitle = taskDoc.data()?.title;
    }
  }

  // Create delegation record
  const delegationRef = adminDb().collection("delegations").doc();
  const delegationData = {
    orgId,
    parentAgentId,
    parentAgentName: parent.name,
    childAgentId,
    childAgentName: child.name,
    taskId: taskId || null,
    taskTitle: taskTitle || null,
    reason: reason || null,
    delegatedAt: FieldValue.serverTimestamp(),
    status: "pending",
  };

  await delegationRef.set(delegationData);

  // Log activity
  await logActivity({
    orgId,
    eventType: "agent_hierarchy_task_delegated" as any,
    actorType: "agent",
    actorId: parentAgentId,
    actorName: parent.name,
    targetType: "agent",
    targetId: childAgentId,
    targetName: child.name,
    description: `${parent.name} delegated task "${taskTitle || "Untitled"}" to ${child.name}${reason ? `: ${reason}` : ""}`,
    metadata: {
      taskId: taskId || null,
      taskTitle: taskTitle || null,
      reason: reason || null,
    },
  });

  return delegationRef.id;
}

/**
 * Get delegation history for an agent
 */
export async function getDelegations(
  orgId: string,
  agentId?: string,
  status?: DelegationRecord["status"]
): Promise<DelegationRecord[]> {
  const base = adminDb().collection("delegations").where("orgId", "==", orgId);

  if (agentId) {
    // Get delegations where agent is parent OR child
    const asParent = base.where("parentAgentId", "==", agentId);
    const asChild = base.where("childAgentId", "==", agentId);

    const [parentSnap, childSnap] = await Promise.all([
      asParent.get(),
      asChild.get(),
    ]);

    const allDocs = [...parentSnap.docs, ...childSnap.docs];
    const uniqueDocs = Array.from(
      new Map(allDocs.map((d) => [d.id, d])).values()
    );

    let delegations = uniqueDocs.map(
      (doc) =>
        ({
          id: doc.id,
          ...doc.data(),
          delegatedAt: doc.data().delegatedAt?.toDate() || null,
          completedAt: doc.data().completedAt?.toDate() || null,
        } as DelegationRecord)
    );

    if (status) {
      delegations = delegations.filter((d) => d.status === status);
    }

    return delegations;
  }

  const finalQuery = status ? base.where("status", "==", status) : base;

  const snapshot = await finalQuery.get();
  return snapshot.docs.map(
    (doc) =>
      ({
        id: doc.id,
        ...doc.data(),
        delegatedAt: doc.data().delegatedAt?.toDate() || null,
        completedAt: doc.data().completedAt?.toDate() || null,
      } as DelegationRecord)
  );
}

/**
 * Update delegation status
 */
export async function updateDelegationStatus(
  delegationId: string,
  status: DelegationRecord["status"]
): Promise<void> {
  const updates: Record<string, unknown> = { status };

  if (status === "completed" || status === "failed") {
    updates.completedAt = FieldValue.serverTimestamp();
  }

  await adminDb().collection("delegations").doc(delegationId).update(updates);
}
