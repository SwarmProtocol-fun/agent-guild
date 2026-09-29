/**
 * Spam Task Farming Detector
 *
 * Detects agents completing an unusually high volume of low-complexity
 * tasks for score padding.
 *
 * Algorithm:
 * 1. Per agent: count completed tasks in the window
 * 2. Classify tasks by priority (low=simple, medium, high=complex)
 * 3. Flag if completion rate > threshold AND simple ratio > threshold
 * 4. Also flag if completion rate > 3x org-wide median
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

export async function detectSpamFarming(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Query completed assignments in the org
  const snap = await adminDb()
    .collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  // Per-agent stats
  const agentStats = new Map<string, {
    total: number;
    simple: number;
    medium: number;
    complex: number;
    taskIds: string[];
  }>();

  for (const d of snap.docs) {
    const data = d.data();

    // Filter by window
    const completedAt = data.completedAt?.toDate?.()?.getTime()
      || data.updatedAt?.toDate?.()?.getTime() || 0;
    if (completedAt < windowStart) continue;

    const agentId = data.toAgentId;
    if (!agentId) continue;

    if (!agentStats.has(agentId)) {
      agentStats.set(agentId, { total: 0, simple: 0, medium: 0, complex: 0, taskIds: [] });
    }

    const stats = agentStats.get(agentId)!;
    stats.total++;
    stats.taskIds.push(d.id);

    // Classify by priority
    const priority = data.priority || "medium";
    if (priority === "low") stats.simple++;
    else if (priority === "high" || priority === "urgent") stats.complex++;
    else stats.medium++;
  }

  // Compute org-wide median completion rate
  const rates = [...agentStats.values()].map((s) => s.total / 7); // completions per day
  rates.sort((a, b) => a - b);
  const medianRate = rates.length > 0 ? rates[Math.floor(rates.length / 2)] : 0;

  // Evaluate each agent
  for (const [agentId, stats] of agentStats) {
    const dailyRate = stats.total / 7;
    const simpleRatio = stats.total > 0 ? stats.simple / stats.total : 0;

    let flagged = false;
    let severity: "medium" | "high" | "critical" = "medium";

    // Check absolute velocity + simple ratio
    if (dailyRate > config.spamVelocityThreshold && simpleRatio > config.spamSimpleRatio) {
      flagged = true;
      severity = dailyRate > 30 ? "critical" : "high";
    }

    // Check relative velocity (3x median)
    if (!flagged && medianRate > 0 && dailyRate > medianRate * 3 && stats.total >= 10) {
      flagged = true;
      severity = "medium";
    }

    if (!flagged) continue;

    // Get agent details
    let agentAsn = "";
    try {
      const agentDoc = await adminDb().collection("agents").doc(agentId).get();
      if (agentDoc.exists) {
        agentAsn = agentDoc.data()!.asn || "";
      }
    } catch {
      // continue without ASN
    }

    const confidence = Math.min(1, 0.6 + simpleRatio * 0.3 + Math.min(dailyRate / 50, 0.1));

    signals.push({
      agentId,
      asn: agentAsn,
      orgId,
      signalType: "spam_task_farming",
      severity,
      confidence,
      evidence: {
        taskIds: stats.taskIds.slice(0, 20), // Cap evidence to first 20
        windowStart: Math.floor(windowStart / 1000),
        windowEnd: Math.floor(windowEnd / 1000),
        metric: dailyRate,
        threshold: config.spamVelocityThreshold,
        description: `${stats.total} completions in 7 days (${dailyRate.toFixed(1)}/day), ${(simpleRatio * 100).toFixed(0)}% simple tasks. Org median: ${medianRate.toFixed(1)}/day`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
}
