/**
 * Diagnostics & Auto-Fix System
 *
 * Detect and auto-fix common issues:
 * - Stale agents (offline > 1 hour)
 * - High error rate (> 50% failed tasks)
 * - Budget overrun (exceeded thresholds)
 * - Orphaned tasks (assigned to deleted agents)
 * - Circuit breakers stuck open
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getHeartbeats } from "./heartbeat";
import { getActiveAlerts } from "./vitals-collector";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type DiagnosticCheckType =
  | "stale_agents"
  | "high_error_rate"
  | "budget_overrun"
  | "orphaned_tasks"
  | "circuit_breakers";

export interface DiagnosticIssue {
  checkType: DiagnosticCheckType;
  targetId: string;
  targetName: string;
  severity: "low" | "medium" | "high";
  description: string;
  suggestedFix?: string;
  autoFixable: boolean;
}

export interface DiagnosticRun {
  id: string;
  orgId: string;
  checkType: DiagnosticCheckType;
  runAt: Date | null;
  issuesFound: number;
  issues: DiagnosticIssue[];
  autoFixAttempted: boolean;
  fixResults?: FixResult[];
}

export interface FixResult {
  targetId: string;
  targetName: string;
  action: string;
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Diagnostic Checks
// ═══════════════════════════════════════════════════════════════

export async function checkStaleAgents(orgId: string): Promise<DiagnosticIssue[]> {
  const heartbeats = await getHeartbeats(orgId);
  const issues: DiagnosticIssue[] = [];

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();

  for (const hb of heartbeats) {
    if (hb.status === "offline" && hb.lastSeen) {
      const elapsed = now - hb.lastSeen.getTime();
      if (elapsed > ONE_HOUR_MS) {
        issues.push({
          checkType: "stale_agents",
          targetId: hb.agentId,
          targetName: hb.agentName || hb.agentId,
          severity: elapsed > ONE_HOUR_MS * 24 ? "high" : "medium",
          description: `Agent offline for ${Math.floor(elapsed / ONE_HOUR_MS)} hours`,
          suggestedFix: "Check agent logs, restart agent service",
          autoFixable: false,
        });
      }
    }
  }

  return issues;
}

export async function checkHighErrorRate(orgId: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  // Get agents
  const agentsSnap = await adminDb().collection("agents").where("orgId", "==", orgId).get();

  for (const agentDoc of agentsSnap.docs) {
    const agentId = agentDoc.id;
    const agentName = agentDoc.data().name || agentId;

    // Get recent activity
    const activitySnap = await adminDb()
      .collection("activityLog")
      .where("agentId", "==", agentId)
      .where("eventType", "in", ["task_completed", "task_failed"])
      .get();

    const events = activitySnap.docs.map((d) => d.data());
    const failures = events.filter((e) => e.eventType === "task_failed").length;
    const total = events.length;

    if (total >= 10 && failures / total > 0.5) {
      issues.push({
        checkType: "high_error_rate",
        targetId: agentId,
        targetName: agentName,
        severity: "high",
        description: `High error rate: ${((failures / total) * 100).toFixed(0)}% (${failures}/${total})`,
        suggestedFix: "Review agent logs, check task assignments",
        autoFixable: false,
      });
    }
  }

  return issues;
}

export async function checkBudgetOverrun(orgId: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  // Get active budget alerts
  const alerts = await getActiveAlerts(orgId);

  for (const alert of alerts) {
    if (alert.severity === "critical") {
      issues.push({
        checkType: "budget_overrun",
        targetId: alert.agentId,
        targetName: alert.agentName || alert.agentId,
        severity: "high",
        description: `Budget exceeded: ${alert.resource} at ${alert.currentValue.toFixed(1)}% (threshold: ${alert.threshold}%)`,
        suggestedFix: "Pause agent or increase budget limit",
        autoFixable: true, // Can auto-pause agent
      });
    }
  }

  return issues;
}

export async function checkOrphanedTasks(orgId: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  // Get all tasks
  const tasksSnap = await adminDb().collection("kanbanTasks").where("orgId", "==", orgId).get();

  // Get all agents
  const agentsSnap = await adminDb().collection("agents").where("orgId", "==", orgId).get();

  const agentIds = new Set(agentsSnap.docs.map((d) => d.id));

  for (const taskDoc of tasksSnap.docs) {
    const task = taskDoc.data();
    if (task.assignee && !agentIds.has(task.assignee)) {
      issues.push({
        checkType: "orphaned_tasks",
        targetId: taskDoc.id,
        targetName: task.title || taskDoc.id,
        severity: "medium",
        description: `Task assigned to non-existent agent: ${task.assigneeName || task.assignee}`,
        suggestedFix: "Reassign to available agent or unassign",
        autoFixable: true,
      });
    }
  }

  return issues;
}

export async function checkCircuitBreakers(orgId: string): Promise<DiagnosticIssue[]> {
  const issues: DiagnosticIssue[] = [];

  // Get circuit breaker states
  const circuitSnap = await adminDb().collection("modelHealth").where("circuitState", "==", "open").get();

  for (const circuitDoc of circuitSnap.docs) {
    const circuit = circuitDoc.data();
    issues.push({
      checkType: "circuit_breakers",
      targetId: circuitDoc.id,
      targetName: circuit.model || circuitDoc.id,
      severity: "medium",
      description: `Circuit breaker open for model ${circuit.model}: ${circuit.failureCount} failures`,
      suggestedFix: "Reset circuit breaker to retry",
      autoFixable: true,
    });
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════
// Auto-Fix Actions
// ═══════════════════════════════════════════════════════════════

export async function fixBudgetOverrun(
  orgId: string,
  issue: DiagnosticIssue
): Promise<FixResult> {
  try {
    // Pause the agent
    await adminDb().collection("agents").doc(issue.targetId).set(
      {
        status: "paused",
        pausedAt: FieldValue.serverTimestamp(),
        pausedBy: "auto_diagnostics",
        pauseReason: `Auto-paused due to ${issue.description}`,
      },
      { merge: true }
    );

    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Paused agent",
      success: true,
    };
  } catch (err) {
    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Pause agent",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function fixOrphanedTask(issue: DiagnosticIssue): Promise<FixResult> {
  try {
    // Unassign the task
    await adminDb().collection("kanbanTasks").doc(issue.targetId).set(
      {
        assignee: null,
        assigneeName: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Unassigned orphaned task",
      success: true,
    };
  } catch (err) {
    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Unassign task",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function fixCircuitBreaker(issue: DiagnosticIssue): Promise<FixResult> {
  try {
    // Reset circuit breaker
    await adminDb().collection("modelHealth").doc(issue.targetId).set(
      {
        circuitState: "closed",
        failureCount: 0,
        lastFailure: null,
      },
      { merge: true }
    );

    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Reset circuit breaker",
      success: true,
    };
  } catch (err) {
    return {
      targetId: issue.targetId,
      targetName: issue.targetName,
      action: "Reset circuit breaker",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Run Diagnostics
// ═══════════════════════════════════════════════════════════════

export async function runDiagnostics(
  orgId: string,
  checkType?: DiagnosticCheckType
): Promise<DiagnosticRun[]> {
  const checks: DiagnosticCheckType[] = checkType
    ? [checkType]
    : ["stale_agents", "high_error_rate", "budget_overrun", "orphaned_tasks", "circuit_breakers"];

  const runs: DiagnosticRun[] = [];

  for (const check of checks) {
    let issues: DiagnosticIssue[] = [];

    switch (check) {
      case "stale_agents":
        issues = await checkStaleAgents(orgId);
        break;
      case "high_error_rate":
        issues = await checkHighErrorRate(orgId);
        break;
      case "budget_overrun":
        issues = await checkBudgetOverrun(orgId);
        break;
      case "orphaned_tasks":
        issues = await checkOrphanedTasks(orgId);
        break;
      case "circuit_breakers":
        issues = await checkCircuitBreakers(orgId);
        break;
    }

    // Record run
    const runRef = await adminDb().collection("diagnosticRuns").add({
      orgId,
      checkType: check,
      runAt: FieldValue.serverTimestamp(),
      issuesFound: issues.length,
      issues,
      autoFixAttempted: false,
    });

    runs.push({
      id: runRef.id,
      orgId,
      checkType: check,
      runAt: new Date(),
      issuesFound: issues.length,
      issues,
      autoFixAttempted: false,
    });
  }

  return runs;
}

export async function runAutoFix(
  orgId: string,
  runId: string,
  issue: DiagnosticIssue
): Promise<FixResult> {
  let result: FixResult;

  switch (issue.checkType) {
    case "budget_overrun":
      result = await fixBudgetOverrun(orgId, issue);
      break;
    case "orphaned_tasks":
      result = await fixOrphanedTask(issue);
      break;
    case "circuit_breakers":
      result = await fixCircuitBreaker(issue);
      break;
    default:
      result = {
        targetId: issue.targetId,
        targetName: issue.targetName,
        action: "Auto-fix not available",
        success: false,
        error: "This issue type does not support auto-fix",
      };
  }

  // Update run record
  await adminDb().collection("diagnosticRuns").doc(runId).set(
    {
      autoFixAttempted: true,
      fixResults: [result],
    },
    { merge: true }
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════

export async function getRecentDiagnosticRuns(
  orgId: string,
  limit = 10
): Promise<DiagnosticRun[]> {
  const snap = await adminDb().collection("diagnosticRuns").where("orgId", "==", orgId).get();
  return snap.docs
    .slice(0, limit)
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        orgId: data.orgId,
        checkType: data.checkType,
        runAt: data.runAt instanceof Timestamp ? data.runAt.toDate() : null,
        issuesFound: data.issuesFound,
        issues: data.issues || [],
        autoFixAttempted: data.autoFixAttempted || false,
        fixResults: data.fixResults || [],
      };
    });
}
