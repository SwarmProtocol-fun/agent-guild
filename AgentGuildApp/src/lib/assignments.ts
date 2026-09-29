/**
 * Task Assignment & Accountability System
 *
 * Formal task delegation with accept/reject workflow, deadline enforcement,
 * capacity management, and work mode tracking.
 *
 * Features:
 * - Accept/reject workflow for task assignments
 * - Deadline tracking with overdue alerts
 * - Agent capacity limits (max concurrent assignments)
 * - Work mode tracking (available/busy/offline/paused)
 * - Multi-channel notifications (WebSocket + Agent Hub + persistent docs)
 */

import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  serverTimestamp,
  Timestamp,
  increment,
} from "firebase/firestore";
import { getAgent, type Agent } from "@/lib/firestore";

// ─── TypeScript Interfaces ──────────────────────────────────

export interface TaskAssignment {
  // Identity
  id: string;
  orgId: string;

  // Assignment parties (fromAgentId XOR fromHumanId)
  fromAgentId?: string;
  fromAgentName?: string;
  fromHumanId?: string; // walletAddress if from human
  fromHumanName?: string;
  toAgentId: string;
  toAgentName: string;

  // Task details
  taskId?: string; // Link to kanbanTasks (created on accept)
  taskType: "kanban" | "standalone" | "job";
  title: string;
  description: string;

  // Status tracking
  status: "pending" | "accepted" | "rejected" | "in_progress" | "completed" | "overdue" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";

  // Response tracking
  respondedAt?: Timestamp;
  response?: "accepted" | "rejected";
  rejectionReason?: string;

  // Deadlines
  deadline?: Timestamp;
  deadlineWarning24h?: boolean;
  deadlineWarning1h?: boolean;

  // Completion
  completedAt?: Timestamp;
  completionNotes?: string;

  // Metadata
  channelId?: string; // Post notification here
  requiresAcceptance: boolean; // Auto-accept if false
  notificationsSent: string[]; // ["created", "24h_warning", ...]

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AssignmentNotification {
  id: string;
  orgId: string;
  assignmentId: string;
  agentId: string; // Recipient
  type: "new_assignment" | "deadline_24h" | "deadline_1h" | "overdue" | "accepted" | "rejected" | "completed";
  message: string;
  read: boolean;
  channelId?: string;
  createdAt: Timestamp;
}

export interface AgentWorkMode {
  workMode: "available" | "busy" | "offline" | "paused";
  capacity: number; // Max concurrent (default: 3)
  currentLoad: number; // Active assignments count
  lastStatusUpdate: Timestamp;

  // Preferences
  autoAcceptAssignments: boolean;
  capacityOverflowPolicy: "warn" | "reject" | "queue";

  // Stats
  assignmentsCompleted: number;
  assignmentsRejected: number;
  averageCompletionTimeMs: number;
  overdueCount: number;
}

export interface CreateAssignmentParams {
  orgId: string;
  fromAgentId?: string;
  fromAgentName?: string;
  fromHumanId?: string;
  fromHumanName?: string;
  toAgentId: string;
  toAgentName: string;
  title: string;
  description: string;
  priority?: "low" | "medium" | "high" | "urgent";
  deadline?: Date;
  taskId?: string;
  taskType?: "kanban" | "standalone" | "job";
  requiresAcceptance?: boolean;
  channelId?: string;
}

// ─── Core CRUD Functions ────────────────────────────────────

/**
 * Create a new task assignment.
 * Checks agent capacity and sends notifications.
 */
export async function createAssignment(params: CreateAssignmentParams): Promise<string> {
  const {
    orgId,
    fromAgentId,
    fromAgentName,
    fromHumanId,
    fromHumanName,
    toAgentId,
    toAgentName,
    title,
    description,
    priority = "medium",
    deadline,
    taskId,
    taskType = "standalone",
    requiresAcceptance = true,
    channelId,
  } = params;

  // Validate: must have either fromAgentId or fromHumanId
  if (!fromAgentId && !fromHumanId) {
    throw new Error("Assignment must have either fromAgentId or fromHumanId");
  }

  // Check target agent exists and belongs to same org
  const agent = await getAgent(toAgentId);
  if (!agent) {
    throw new Error(`Agent ${toAgentId} not found`);
  }

  // SECURITY: Prevent cross-organization assignment
  if (agent.orgId !== orgId) {
    throw new Error(`Agent ${toAgentId} not found in organization ${orgId}`);
  }

  const workMode = (agent as any).workMode || "available";
  let capacity = (agent as any).capacity || 3;
  const currentLoad = (agent as any).currentLoad || 0;
  const capacityOverflowPolicy = (agent as any).capacityOverflowPolicy || "warn";
  const autoAcceptAssignments = (agent as any).autoAcceptAssignments || false;

  // ── Credit Policy: derive capacity ceiling from tier ──
  try {
    const { resolveAgentPolicy } = await import("@/lib/auth-guard");
    const { getCreditPolicyConfig, recordPolicyEvent } = await import("@/lib/credit-policy-settings");
    const config = await getCreditPolicyConfig();
    if (config.enforcementEnabled && config.enforceConcurrentLimits) {
      const policyResult = await resolveAgentPolicy(toAgentId);
      if (policyResult.ok && policyResult.policy) {
        const policyCapacity = policyResult.policy.maxConcurrentTasks;
        capacity = Math.min(capacity, policyCapacity);

        if (currentLoad >= capacity) {
          await recordPolicyEvent({
            agentId: toAgentId,
            orgId,
            action: "concurrent_limit_enforced",
            tier: policyResult.tier!,
            details: { currentLoad, capacity, policyCapacity },
          });
        }
      }
    }
  } catch (err) {
    console.warn("[assignments] Credit policy capacity check failed (using agent default):", err);
  }

  // Handle capacity overflow
  if (currentLoad >= capacity) {
    if (capacityOverflowPolicy === "reject") {
      throw new Error(`Agent ${toAgentName} is at capacity (${currentLoad}/${capacity})`);
    } else if (capacityOverflowPolicy === "warn") {
      console.warn(`Agent ${toAgentName} is at capacity (${currentLoad}/${capacity}), but policy is 'warn'`);
    }
    // 'queue' policy allows creation but doesn't auto-accept
  }

  // Create assignment document
  const assignmentData = {
    orgId,
    fromAgentId: fromAgentId || null,
    fromAgentName: fromAgentName || null,
    fromHumanId: fromHumanId || null,
    fromHumanName: fromHumanName || null,
    toAgentId,
    toAgentName,
    taskId: taskId || null,
    taskType,
    title,
    description,
    status: autoAcceptAssignments && requiresAcceptance === false ? "accepted" : "pending",
    priority,
    deadline: deadline ? Timestamp.fromDate(deadline) : null,
    deadlineWarning24h: false,
    deadlineWarning1h: false,
    requiresAcceptance,
    channelId: channelId || null,
    notificationsSent: ["created"],
    respondedAt: null,
    response: null,
    rejectionReason: null,
    completedAt: null,
    completionNotes: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const assignmentRef = await addDoc(collection(db, "taskAssignments"), assignmentData);

  // Auto-accept if configured
  if (autoAcceptAssignments && requiresAcceptance === true) {
    await acceptAssignment(assignmentRef.id, toAgentId, "Auto-accepted based on agent preferences");
  }

  // Create notification
  await createNotification({
    orgId,
    assignmentId: assignmentRef.id,
    agentId: toAgentId,
    type: "new_assignment",
    message: `New ${priority} priority task from ${fromAgentName || fromHumanName}: ${title}`,
    channelId,
  });

  return assignmentRef.id;
}

/**
 * Get a task assignment by ID.
 */
export async function getAssignment(assignmentId: string): Promise<TaskAssignment | null> {
  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    return null;
  }

  return {
    id: assignmentSnap.id,
    ...assignmentSnap.data(),
  } as TaskAssignment;
}

/**
 * List assignments for an agent.
 * Can filter by status and limit results.
 */
export async function listAssignments(
  agentId: string,
  status?: string,
  limitCount: number = 50
): Promise<TaskAssignment[]> {
  let q = query(
    collection(db, "taskAssignments"),
    where("toAgentId", "==", agentId),
    orderBy("createdAt", "desc"),
    firestoreLimit(limitCount)
  );

  if (status) {
    q = query(
      collection(db, "taskAssignments"),
      where("toAgentId", "==", agentId),
      where("status", "==", status),
      orderBy("createdAt", "desc"),
      firestoreLimit(limitCount)
    );
  }

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TaskAssignment[];
}

/**
 * Accept a task assignment.
 * Increments agent currentLoad and creates notification.
 */
export async function acceptAssignment(
  assignmentId: string,
  agentId: string,
  notes?: string
): Promise<void> {
  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    throw new Error(`Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    throw new Error(`Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is pending
  if (assignment.status !== "pending") {
    throw new Error(`Assignment ${assignmentId} is not pending (current status: ${assignment.status})`);
  }

  // Update assignment
  await updateDoc(assignmentRef, {
    status: "accepted",
    response: "accepted",
    respondedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Increment agent currentLoad
  const agentRef = doc(db, "agents", agentId);
  await updateDoc(agentRef, {
    currentLoad: increment(1),
  });

  // Create notification for assigner
  const fromId = assignment.fromAgentId || assignment.fromHumanId;
  if (fromId) {
    await createNotification({
      orgId: assignment.orgId,
      assignmentId,
      agentId: fromId,
      type: "accepted",
      message: `${assignment.toAgentName} accepted: ${assignment.title}${notes ? ` (${notes})` : ""}`,
      channelId: assignment.channelId,
    });
  }
}

/**
 * Reject a task assignment.
 * Does NOT increment agent currentLoad.
 */
export async function rejectAssignment(
  assignmentId: string,
  agentId: string,
  reason: string
): Promise<void> {
  if (!reason || reason.trim().length === 0) {
    throw new Error("Rejection reason is required");
  }

  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    throw new Error(`Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    throw new Error(`Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is pending
  if (assignment.status !== "pending") {
    throw new Error(`Assignment ${assignmentId} is not pending (current status: ${assignment.status})`);
  }

  // Update assignment
  await updateDoc(assignmentRef, {
    status: "rejected",
    response: "rejected",
    rejectionReason: reason,
    respondedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Increment agent rejection stats
  const agentRef = doc(db, "agents", agentId);
  await updateDoc(agentRef, {
    assignmentsRejected: increment(1),
  });

  // Create notification for assigner
  const fromId = assignment.fromAgentId || assignment.fromHumanId;
  if (fromId) {
    await createNotification({
      orgId: assignment.orgId,
      assignmentId,
      agentId: fromId,
      type: "rejected",
      message: `${assignment.toAgentName} rejected: ${assignment.title} (Reason: ${reason})`,
      channelId: assignment.channelId,
    });
  }
}

/**
 * Mark assignment as in progress.
 */
export async function startAssignment(assignmentId: string, agentId: string): Promise<void> {
  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    throw new Error(`Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  if (assignment.toAgentId !== agentId) {
    throw new Error(`Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  if (assignment.status !== "accepted") {
    throw new Error(`Assignment ${assignmentId} is not accepted (current status: ${assignment.status})`);
  }

  await updateDoc(assignmentRef, {
    status: "in_progress",
    updatedAt: serverTimestamp(),
  });
}

/**
 * Complete a task assignment.
 * Decrements agent currentLoad and updates stats.
 */
export async function completeAssignment(
  assignmentId: string,
  agentId: string,
  completionNotes?: string
): Promise<void> {
  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    throw new Error(`Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    throw new Error(`Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is accepted or in_progress
  if (assignment.status !== "accepted" && assignment.status !== "in_progress") {
    throw new Error(
      `Assignment ${assignmentId} is not in progress (current status: ${assignment.status})`
    );
  }

  const completedAt = new Date();
  const createdAt = assignment.createdAt.toDate();
  const completionTimeMs = completedAt.getTime() - createdAt.getTime();

  // Update assignment
  await updateDoc(assignmentRef, {
    status: "completed",
    completedAt: Timestamp.fromDate(completedAt),
    completionNotes: completionNotes || null,
    updatedAt: serverTimestamp(),
  });

  // Update agent stats
  const agentRef = doc(db, "agents", agentId);
  const agentSnap = await getDoc(agentRef);

  if (agentSnap.exists()) {
    const agentData = agentSnap.data();
    const currentLoad = (agentData.currentLoad || 1) - 1;
    const assignmentsCompleted = (agentData.assignmentsCompleted || 0) + 1;
    const currentAvgTime = agentData.averageCompletionTimeMs || 0;
    const newAvgTime = Math.round(
      (currentAvgTime * (assignmentsCompleted - 1) + completionTimeMs) / assignmentsCompleted
    );

    await updateDoc(agentRef, {
      currentLoad: Math.max(0, currentLoad),
      assignmentsCompleted,
      averageCompletionTimeMs: newAvgTime,
    });
  }

  // Create notification for assigner
  const fromId = assignment.fromAgentId || assignment.fromHumanId;
  if (fromId) {
    await createNotification({
      orgId: assignment.orgId,
      assignmentId,
      agentId: fromId,
      type: "completed",
      message: `${assignment.toAgentName} completed: ${assignment.title}${completionNotes ? ` (${completionNotes})` : ""}`,
      channelId: assignment.channelId,
    });
  }
}

/**
 * Cancel a task assignment (assigner only).
 */
export async function cancelAssignment(
  assignmentId: string,
  cancellingAgentId: string
): Promise<void> {
  const assignmentRef = doc(db, "taskAssignments", assignmentId);
  const assignmentSnap = await getDoc(assignmentRef);

  if (!assignmentSnap.exists()) {
    throw new Error(`Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the assigner
  if (assignment.fromAgentId !== cancellingAgentId && assignment.fromHumanId !== cancellingAgentId) {
    throw new Error(`Agent ${cancellingAgentId} is not the assigner of assignment ${assignmentId}`);
  }

  // Can only cancel pending or accepted assignments
  if (assignment.status !== "pending" && assignment.status !== "accepted") {
    throw new Error(`Cannot cancel assignment in status: ${assignment.status}`);
  }

  // Update assignment
  await updateDoc(assignmentRef, {
    status: "cancelled",
    updatedAt: serverTimestamp(),
  });

  // Decrement currentLoad if it was accepted
  if (assignment.status === "accepted") {
    const agentRef = doc(db, "agents", assignment.toAgentId);
    await updateDoc(agentRef, {
      currentLoad: increment(-1),
    });
  }

  // Notify recipient
  await createNotification({
    orgId: assignment.orgId,
    assignmentId,
    agentId: assignment.toAgentId,
    type: "new_assignment",
    message: `Assignment cancelled: ${assignment.title}`,
    channelId: assignment.channelId,
  });
}

// ─── Work Mode Management ───────────────────────────────────

/**
 * Get agent's work mode and capacity info.
 */
export async function getAgentWorkMode(agentId: string): Promise<AgentWorkMode | null> {
  const agentRef = doc(db, "agents", agentId);
  const agentSnap = await getDoc(agentRef);

  if (!agentSnap.exists()) {
    return null;
  }

  const data = agentSnap.data();

  return {
    workMode: data.workMode || "available",
    capacity: data.capacity || 3,
    currentLoad: data.currentLoad || 0,
    lastStatusUpdate: data.lastStatusUpdate || data.lastSeen,
    autoAcceptAssignments: data.autoAcceptAssignments || false,
    capacityOverflowPolicy: data.capacityOverflowPolicy || "warn",
    assignmentsCompleted: data.assignmentsCompleted || 0,
    assignmentsRejected: data.assignmentsRejected || 0,
    averageCompletionTimeMs: data.averageCompletionTimeMs || 0,
    overdueCount: data.overdueCount || 0,
  };
}

/**
 * Update agent's work mode and capacity settings.
 */
export async function updateAgentWorkMode(
  agentId: string,
  updates: Partial<{
    workMode: "available" | "busy" | "offline" | "paused";
    capacity: number;
    autoAcceptAssignments: boolean;
    capacityOverflowPolicy: "warn" | "reject" | "queue";
  }>
): Promise<void> {
  const agentRef = doc(db, "agents", agentId);

  await updateDoc(agentRef, {
    ...updates,
    lastStatusUpdate: serverTimestamp(),
  });
}

// ─── Notifications ──────────────────────────────────────────

interface CreateNotificationParams {
  orgId: string;
  assignmentId: string;
  agentId: string;
  type: AssignmentNotification["type"];
  message: string;
  channelId?: string;
}

/**
 * Create an assignment notification.
 */
export async function createNotification(params: CreateNotificationParams): Promise<string> {
  const { orgId, assignmentId, agentId, type, message, channelId } = params;

  const notificationRef = await addDoc(collection(db, "assignmentNotifications"), {
    orgId,
    assignmentId,
    agentId,
    type,
    message,
    read: false,
    channelId: channelId || null,
    createdAt: serverTimestamp(),
  });

  return notificationRef.id;
}

/**
 * List notifications for an agent.
 */
export async function listNotifications(
  agentId: string,
  unreadOnly: boolean = false,
  limitCount: number = 50
): Promise<AssignmentNotification[]> {
  let q = query(
    collection(db, "assignmentNotifications"),
    where("agentId", "==", agentId),
    orderBy("createdAt", "desc"),
    firestoreLimit(limitCount)
  );

  if (unreadOnly) {
    q = query(
      collection(db, "assignmentNotifications"),
      where("agentId", "==", agentId),
      where("read", "==", false),
      orderBy("createdAt", "desc"),
      firestoreLimit(limitCount)
    );
  }

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AssignmentNotification[];
}

/**
 * Mark notification as read.
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  const notificationRef = doc(db, "assignmentNotifications", notificationId);
  await updateDoc(notificationRef, {
    read: true,
  });
}

// ─── Stats & Utilities ──────────────────────────────────────

/**
 * Get assignment statistics for an agent.
 */
export async function getAssignmentStats(agentId: string): Promise<{
  pending: number;
  accepted: number;
  in_progress: number;
  overdue: number;
  completed: number;
  rejected: number;
}> {
  const allAssignments = await listAssignments(agentId, undefined, 1000);

  const stats = {
    pending: 0,
    accepted: 0,
    in_progress: 0,
    overdue: 0,
    completed: 0,
    rejected: 0,
  };

  for (const assignment of allAssignments) {
    if (assignment.status in stats) {
      stats[assignment.status as keyof typeof stats]++;
    }
  }

  return stats;
}
