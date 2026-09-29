/**
 * Cron Execution History
 *
 * Track cron job execution history for auditing and debugging.
 * Records start time, end time, duration, success/failure, and agent results.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CronExecutionHistory {
  id: string;
  jobId: string;
  jobName: string;
  orgId: string;
  startTime: Date | null;
  endTime: Date | null;
  durationMs: number;
  success: boolean;
  error?: string;
  agentResults: AgentExecutionResult[];
  testRun?: boolean; // Was this a test/dry-run?
}

export interface AgentExecutionResult {
  agentId: string;
  agentName: string;
  success: boolean;
  error?: string;
  responsePreview?: string;
  executedAt: number; // timestamp
}

// ═══════════════════════════════════════════════════════════════
// Recording Execution History
// ═══════════════════════════════════════════════════════════════

export async function recordCronExecution(
  jobId: string,
  jobName: string,
  orgId: string,
  startTime: Date,
  endTime: Date,
  success: boolean,
  agentResults: AgentExecutionResult[],
  error?: string,
  testRun = false
): Promise<string> {
  const durationMs = endTime.getTime() - startTime.getTime();

  const ref = await adminDb().collection("cronExecutionHistory").add({
    jobId,
    jobName,
    orgId,
    startTime: Timestamp.fromDate(startTime),
    endTime: Timestamp.fromDate(endTime),
    durationMs,
    success,
    error: error || null,
    agentResults,
    testRun,
    createdAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════

export async function getCronExecutionHistory(
  jobId: string,
  limit = 50
): Promise<CronExecutionHistory[]> {
  const snap = await adminDb()
    .collection("cronExecutionHistory")
    .where("jobId", "==", jobId)
    .orderBy("startTime", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      jobId: data.jobId,
      jobName: data.jobName,
      orgId: data.orgId,
      startTime: data.startTime instanceof Timestamp ? data.startTime.toDate() : null,
      endTime: data.endTime instanceof Timestamp ? data.endTime.toDate() : null,
      durationMs: data.durationMs,
      success: data.success,
      error: data.error,
      agentResults: data.agentResults || [],
      testRun: data.testRun || false,
    };
  });
}

export async function getAllCronExecutionHistory(
  orgId: string,
  limit = 100
): Promise<CronExecutionHistory[]> {
  const snap = await adminDb()
    .collection("cronExecutionHistory")
    .where("orgId", "==", orgId)
    .orderBy("startTime", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      jobId: data.jobId,
      jobName: data.jobName,
      orgId: data.orgId,
      startTime: data.startTime instanceof Timestamp ? data.startTime.toDate() : null,
      endTime: data.endTime instanceof Timestamp ? data.endTime.toDate() : null,
      durationMs: data.durationMs,
      success: data.success,
      error: data.error,
      agentResults: data.agentResults || [],
      testRun: data.testRun || false,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Statistics
// ═══════════════════════════════════════════════════════════════

export interface CronExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  avgDurationMs: number;
  lastExecution: Date | null;
  lastSuccess: Date | null;
  lastFailure: Date | null;
}

export function calculateCronStats(history: CronExecutionHistory[]): CronExecutionStats {
  if (history.length === 0) {
    return {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      successRate: 0,
      avgDurationMs: 0,
      lastExecution: null,
      lastSuccess: null,
      lastFailure: null,
    };
  }

  const successfulExecutions = history.filter((h) => h.success).length;
  const failedExecutions = history.filter((h) => !h.success).length;
  const totalDuration = history.reduce((sum, h) => sum + h.durationMs, 0);
  const lastSuccess = history.find((h) => h.success)?.startTime || null;
  const lastFailure = history.find((h) => !h.success)?.startTime || null;

  return {
    totalExecutions: history.length,
    successfulExecutions,
    failedExecutions,
    successRate: history.length > 0 ? (successfulExecutions / history.length) * 100 : 0,
    avgDurationMs: history.length > 0 ? totalDuration / history.length : 0,
    lastExecution: history[0]?.startTime || null,
    lastSuccess,
    lastFailure,
  };
}
