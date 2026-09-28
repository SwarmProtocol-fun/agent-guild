/**
 * Velocity Anomaly Detector
 *
 * Detects sudden bursts of task completions that deviate significantly
 * from an agent's historical baseline.
 *
 * Algorithm:
 * 1. Per agent, compute daily completion counts over 30 days
 * 2. Calculate rolling 7-day mean and standard deviation
 * 3. Flag days where completions > mean + 3*stddev (z-score > 3)
 * 4. Signal if >= 2 anomalous days in the window
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

export async function detectVelocityAnomalies(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Query completed assignments in the org
  const assignmentsSnap = await adminDb()
    .collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  // Build per-agent daily completion counts
  const agentDailyCounts = new Map<string, Map<string, number>>(); // agentId → { "YYYY-MM-DD" → count }

  for (const d of assignmentsSnap.docs) {
    const data = d.data();
    const completedAt = data.completedAt?.toDate?.()?.getTime()
      || data.updatedAt?.toDate?.()?.getTime() || 0;
    if (completedAt < windowStart) continue;

    const agentId = data.toAgentId;
    if (!agentId) continue;

    const dateKey = new Date(completedAt).toISOString().slice(0, 10);

    if (!agentDailyCounts.has(agentId)) {
      agentDailyCounts.set(agentId, new Map());
    }
    const dailyMap = agentDailyCounts.get(agentId)!;
    dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + 1);
  }

  // Evaluate each agent
  for (const [agentId, dailyMap] of agentDailyCounts) {
    // Need sufficient history
    if (dailyMap.size < 7) continue;

    // Convert to sorted array of daily counts
    const sortedDates = [...dailyMap.keys()].sort();
    const dailyCounts = sortedDates.map((d) => dailyMap.get(d) || 0);

    // Fill in zero-count days
    const allDays: number[] = [];
    const startDate = new Date(sortedDates[0]);
    const endDate = new Date(sortedDates[sortedDates.length - 1]);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      allDays.push(dailyMap.get(key) || 0);
    }

    if (allDays.length < 7) continue;

    // Compute rolling stats and find anomalies
    const anomalousDays: { date: string; count: number; mean: number; stddev: number; zScore: number }[] = [];

    for (let i = 7; i < allDays.length; i++) {
      // 7-day rolling window (previous 7 days)
      const window = allDays.slice(i - 7, i);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
      const stddev = Math.sqrt(variance);

      const todayCount = allDays[i];

      // Avoid flagging when stddev is near zero (consistent low activity)
      if (stddev < 1) continue;

      const zScore = (todayCount - mean) / stddev;

      if (zScore > config.velocityZScoreThreshold) {
        const dateOffset = new Date(startDate);
        dateOffset.setDate(dateOffset.getDate() + i);
        anomalousDays.push({
          date: dateOffset.toISOString().slice(0, 10),
          count: todayCount,
          mean,
          stddev,
          zScore,
        });
      }
    }

    // Need at least 2 anomalous days
    if (anomalousDays.length < 2) continue;

    // Get agent details
    let agentAsn = "";
    try {
      const agentDoc = await adminDb().collection("agents").doc(agentId).get();
      if (agentDoc.exists) {
        agentAsn = agentDoc.data()!.asn || "";
      }
    } catch {
      // continue
    }

    const maxZScore = Math.max(...anomalousDays.map((d) => d.zScore));
    const severity = maxZScore > 5 ? "high" as const : "medium" as const;
    const confidence = Math.min(1, 0.5 + anomalousDays.length * 0.1 + maxZScore / 20);

    signals.push({
      agentId,
      asn: agentAsn,
      orgId,
      signalType: "velocity_anomaly",
      severity,
      confidence,
      evidence: {
        windowStart: Math.floor(windowStart / 1000),
        windowEnd: Math.floor(windowEnd / 1000),
        metric: maxZScore,
        threshold: config.velocityZScoreThreshold,
        description: `${anomalousDays.length} anomalous days detected (max z-score: ${maxZScore.toFixed(1)}). Spikes: ${anomalousDays.map((d) => `${d.date}: ${d.count} (avg ${d.mean.toFixed(1)})`).join(", ")}`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
}
