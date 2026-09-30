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
 *
 * Server-side only — reads and writes go through the Admin SDK (adminDb()),
 * not the browser client SDK. /api/v1/* routes call an agent's signature
 * verification, not a signed-in Firestore user, so the client SDK (which
 * firestore.rules gates on request.auth) has no user here and every read or
 * write it attempted returned PERMISSION_DENIED even after a valid
 * signature check. Signed-in dashboard widgets that need this data still go
 * through the client-SDK helpers in @/lib/firestore — this module is the
 * separate server-side data path for /api/v1/*.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp, type Query } from "firebase-admin/firestore";
import { getAgent } from "@/lib/firestore-admin";

// ─── Stable error codes ─────────────────────────────────────
// Routes branch on `err.code` to return a stable response instead of
// forwarding whatever the data layer's message happened to be.

export type AssignmentErrorCode =
  | "AGENT_NOT_FOUND"
  | "FORBIDDEN"
  | "AT_CAPACITY"
  | "NOT_FOUND"
  | "INVALID_STATUS"
  | "VALIDATION_ERROR";

export class AssignmentError extends Error {
  code: AssignmentErrorCode;
  constructor(code: AssignmentErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AssignmentError";
  }
}

function fail(code: AssignmentErrorCode, message: string): never {
  throw new AssignmentError(code, message);
}

const ERROR_STATUS: Record<AssignmentErrorCode, number> = {
  AGENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  AT_CAPACITY: 409,
  INVALID_STATUS: 409,
  VALIDATION_ERROR: 400,
};

/** HTTP status a route should return for a given AssignmentError code. */
export function assignmentErrorStatus(code: AssignmentErrorCode): number {
  return ERROR_STATUS[code] ?? 500;
}

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

const assignmentsCol = () => adminDb().collection("taskAssignments");
const agentsCol = () => adminDb().collection("agents");
const notificationsCol = () => adminDb().collection("assignmentNotifications");

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
    fail("VALIDATION_ERROR", "Assignment must have either fromAgentId or fromHumanId");
  }

  // Check target agent exists and belongs to same org
  const agent = await getAgent(toAgentId);
  if (!agent) {
    fail("AGENT_NOT_FOUND", `Agent ${toAgentId} not found`);
  }

  // SECURITY: Prevent cross-organization assignment
  if (agent.orgId !== orgId) {
    fail("FORBIDDEN", `Agent ${toAgentId} not found in organization ${orgId}`);
  }

  const workMode = (agent as any).workMode || "available";
  let capacity = (agent as any).capacity || 3;
  const currentLoad = (agent as any).currentLoad || 0;
  const capacityOverflowPolicy = (agent as any).capacityOverflowPolicy || "warn";
  const autoAcceptAssignments = (agent as any).autoAcceptAssignments || false;

  // ── Credit Policy: derive capacity ceiling from tier ──
  try {
    const { resolveAgentPolicy } = await import("@/lib/agent-policy");
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
      fail("AT_CAPACITY", `Agent ${toAgentName} is at capacity (${currentLoad}/${capacity})`);
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
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const assignmentRef = await assignmentsCol().add(assignmentData);

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
  const snap = await assignmentsCol().doc(assignmentId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() } as TaskAssignment;
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
  let q: Query = assignmentsCol().where("toAgentId", "==", agentId);
  if (status) {
    q = q.where("status", "==", status);
  }
  q = q.orderBy("createdAt", "desc").limit(limitCount);

  const snapshot = await q.get();
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
  const assignmentRef = assignmentsCol().doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    fail("NOT_FOUND", `Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    fail("FORBIDDEN", `Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is pending
  if (assignment.status !== "pending") {
    fail("INVALID_STATUS", `Assignment ${assignmentId} is not pending (current status: ${assignment.status})`);
  }

  // Update assignment
  await assignmentRef.update({
    status: "accepted",
    response: "accepted",
    respondedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Increment agent currentLoad
  await agentsCol().doc(agentId).update({
    currentLoad: FieldValue.increment(1),
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
    fail("VALIDATION_ERROR", "Rejection reason is required");
  }

  const assignmentRef = assignmentsCol().doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    fail("NOT_FOUND", `Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    fail("FORBIDDEN", `Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is pending
  if (assignment.status !== "pending") {
    fail("INVALID_STATUS", `Assignment ${assignmentId} is not pending (current status: ${assignment.status})`);
  }

  // Update assignment
  await assignmentRef.update({
    status: "rejected",
    response: "rejected",
    rejectionReason: reason,
    respondedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Increment agent rejection stats
  await agentsCol().doc(agentId).update({
    assignmentsRejected: FieldValue.increment(1),
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
  const assignmentRef = assignmentsCol().doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    fail("NOT_FOUND", `Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  if (assignment.toAgentId !== agentId) {
    fail("FORBIDDEN", `Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  if (assignment.status !== "accepted") {
    fail("INVALID_STATUS", `Assignment ${assignmentId} is not accepted (current status: ${assignment.status})`);
  }

  await assignmentRef.update({
    status: "in_progress",
    updatedAt: FieldValue.serverTimestamp(),
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
  const assignmentRef = assignmentsCol().doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    fail("NOT_FOUND", `Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the recipient
  if (assignment.toAgentId !== agentId) {
    fail("FORBIDDEN", `Agent ${agentId} is not the recipient of assignment ${assignmentId}`);
  }

  // Verify status is accepted or in_progress
  if (assignment.status !== "accepted" && assignment.status !== "in_progress") {
    fail("INVALID_STATUS", `Assignment ${assignmentId} is not in progress (current status: ${assignment.status})`);
  }

  const completedAt = new Date();
  const createdAt = assignment.createdAt.toDate();
  const completionTimeMs = completedAt.getTime() - createdAt.getTime();

  // Update assignment
  await assignmentRef.update({
    status: "completed",
    completedAt: Timestamp.fromDate(completedAt),
    completionNotes: completionNotes || null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Update agent stats
  const agentRef = agentsCol().doc(agentId);
  const agentSnap = await agentRef.get();

  if (agentSnap.exists) {
    const agentData = agentSnap.data()!;
    const currentLoad = (agentData.currentLoad || 1) - 1;
    const assignmentsCompleted = (agentData.assignmentsCompleted || 0) + 1;
    const currentAvgTime = agentData.averageCompletionTimeMs || 0;
    const newAvgTime = Math.round(
      (currentAvgTime * (assignmentsCompleted - 1) + completionTimeMs) / assignmentsCompleted
    );

    await agentRef.update({
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
  const assignmentRef = assignmentsCol().doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();

  if (!assignmentSnap.exists) {
    fail("NOT_FOUND", `Assignment ${assignmentId} not found`);
  }

  const assignment = assignmentSnap.data() as TaskAssignment;

  // Verify agent is the assigner
  if (assignment.fromAgentId !== cancellingAgentId && assignment.fromHumanId !== cancellingAgentId) {
    fail("FORBIDDEN", `Agent ${cancellingAgentId} is not the assigner of assignment ${assignmentId}`);
  }

  // Can only cancel pending or accepted assignments
  if (assignment.status !== "pending" && assignment.status !== "accepted") {
    fail("INVALID_STATUS", `Cannot cancel assignment in status: ${assignment.status}`);
  }

  // Update assignment
  await assignmentRef.update({
    status: "cancelled",
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Decrement currentLoad if it was accepted
  if (assignment.status === "accepted") {
    await agentsCol().doc(assignment.toAgentId).update({
      currentLoad: FieldValue.increment(-1),
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
  const agentSnap = await agentsCol().doc(agentId).get();

  if (!agentSnap.exists) {
    return null;
  }

  const data = agentSnap.data()!;

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
  const agentSnap = await agentsCol().doc(agentId).get();
  if (!agentSnap.exists) {
    fail("AGENT_NOT_FOUND", `Agent ${agentId} not found`);
  }

  await agentsCol().doc(agentId).update({
    ...updates,
    lastStatusUpdate: FieldValue.serverTimestamp(),
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

  const notificationRef = await notificationsCol().add({
    orgId,
    assignmentId,
    agentId,
    type,
    message,
    read: false,
    channelId: channelId || null,
    createdAt: FieldValue.serverTimestamp(),
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
  let q: Query = notificationsCol().where("agentId", "==", agentId);
  if (unreadOnly) {
    q = q.where("read", "==", false);
  }
  q = q.orderBy("createdAt", "desc").limit(limitCount);

  const snapshot = await q.get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AssignmentNotification[];
}

/**
 * Mark notification as read.
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  await notificationsCol().doc(notificationId).update({
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
