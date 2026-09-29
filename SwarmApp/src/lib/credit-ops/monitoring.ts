/**
 * Credit Operations — Monitoring & Alerting
 *
 * Anomaly detection, threshold alerts, and monitoring dashboard data.
 * Background service checks for anomalies at regular intervals.
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import type { CreditOpsAlert, AlertType, AlertSeverity } from "./types";

const ALERT_COLLECTION = "creditOpsAlerts";

// ═══════════════════════════════════════════════════════════════
// Alerts CRUD
// ═══════════════════════════════════════════════════════════════

/** Create an alert. */
export async function createAlert(alert: {
  alertType: AlertType;
  severity: AlertSeverity;
  agentId?: string;
  asn?: string;
  message: string;
  details: Record<string, unknown>;
}): Promise<string> {
  const ref = await adminDb().collection(ALERT_COLLECTION).add({
    ...alert,
    acknowledged: false,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Get alerts with filters. */
export async function getAlerts(opts: {
  severity?: AlertSeverity;
  alertType?: AlertType;
  acknowledged?: boolean;
  limit?: number;
}): Promise<CreditOpsAlert[]> {
  let q: Query = adminDb().collection(ALERT_COLLECTION);

  if (opts.severity) q = q.where("severity", "==", opts.severity);
  if (opts.alertType) q = q.where("alertType", "==", opts.alertType);
  if (opts.acknowledged !== undefined) q = q.where("acknowledged", "==", opts.acknowledged);

  q = q.orderBy("createdAt", "desc").limit(opts.limit || 50);

  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CreditOpsAlert[];
}

/** Acknowledge an alert. */
export async function acknowledgeAlert(
  alertId: string,
  acknowledgedBy: string,
): Promise<void> {
  await adminDb().collection(ALERT_COLLECTION).doc(alertId).update({
    acknowledged: true,
    acknowledgedBy,
    acknowledgedAt: FieldValue.serverTimestamp(),
  });
}

/** Batch acknowledge alerts. */
export async function batchAcknowledgeAlerts(
  alertIds: string[],
  acknowledgedBy: string,
): Promise<void> {
  for (const alertId of alertIds) {
    await acknowledgeAlert(alertId, acknowledgedBy);
  }
}

// ═══════════════════════════════════════════════════════════════
// Monitoring Stats
// ═══════════════════════════════════════════════════════════════

/** Get monitoring dashboard stats. */
export async function getMonitoringStats(): Promise<{
  activeAlerts: number;
  bySeverity: Record<AlertSeverity, number>;
  recentSlashings: number;
  avgCreditScore: number;
  avgTrustScore: number;
  tierDistribution: Record<string, number>;
  totalAgentsWithScores: number;
}> {
  // Alert counts
  const alertsCol = adminDb().collection(ALERT_COLLECTION).where("acknowledged", "==", false);
  const [infoSnap, warningSnap, criticalSnap] = await Promise.all([
    alertsCol.where("severity", "==", "info").count().get(),
    alertsCol.where("severity", "==", "warning").count().get(),
    alertsCol.where("severity", "==", "critical").count().get(),
  ]);

  const infoCount = infoSnap.data().count;
  const warningCount = warningSnap.data().count;
  const criticalCount = criticalSnap.data().count;

  // Recent slashings (last 24h)
  const slashingSnap = await adminDb().collection("slashingEvents").orderBy("slashedAt", "desc").limit(100).get();

  // Agent score distribution
  const agentsSnap = await adminDb().collection("agents").where("creditScore", ">", 0).limit(500).get();

  let totalCredit = 0;
  let totalTrust = 0;
  const tierDist: Record<string, number> = { Platinum: 0, Gold: 0, Silver: 0, Bronze: 0 };

  for (const agentDoc of agentsSnap.docs) {
    const data = agentDoc.data();
    const credit = data.creditScore || 680;
    const trust = data.trustScore || 50;
    totalCredit += credit;
    totalTrust += trust;

    if (credit >= 850) tierDist.Platinum++;
    else if (credit >= 700) tierDist.Gold++;
    else if (credit >= 550) tierDist.Silver++;
    else tierDist.Bronze++;
  }

  const totalAgents = agentsSnap.docs.length;

  return {
    activeAlerts: infoCount + warningCount + criticalCount,
    bySeverity: {
      info: infoCount,
      warning: warningCount,
      critical: criticalCount,
    },
    recentSlashings: slashingSnap.docs.length,
    avgCreditScore: totalAgents > 0 ? Math.round(totalCredit / totalAgents) : 680,
    avgTrustScore: totalAgents > 0 ? Math.round(totalTrust / totalAgents) : 50,
    tierDistribution: tierDist,
    totalAgentsWithScores: totalAgents,
  };
}

// ═══════════════════════════════════════════════════════════════
// Anomaly Detection
// ═══════════════════════════════════════════════════════════════

/**
 * Check a single agent's recent events for anomalies.
 * Called inline from mirror-subscriber after each event is processed.
 */
export async function checkAgentForAnomalies(
  asn: string,
  recentEvents: Array<{ type: string; creditDelta: number; trustDelta: number }>,
): Promise<void> {
  if (recentEvents.length < 5) return; // Need minimum sample

  // Check for rapid score drop (sum of deltas in recent events)
  const totalCreditDelta = recentEvents.reduce((sum, e) => sum + e.creditDelta, 0);
  if (totalCreditDelta <= -50) {
    await createAlert({
      alertType: "rapid_score_change",
      severity: totalCreditDelta <= -100 ? "critical" : "warning",
      asn,
      message: `Agent ${asn} rapid credit drop: ${totalCreditDelta} over ${recentEvents.length} events`,
      details: { asn, totalCreditDelta, eventCount: recentEvents.length },
    });
  }

  // Check for high penalty frequency
  const penalties = recentEvents.filter((e) => e.creditDelta < 0);
  if (penalties.length >= recentEvents.length * 0.8 && recentEvents.length >= 5) {
    await createAlert({
      alertType: "threshold_breach",
      severity: "warning",
      asn,
      message: `Agent ${asn} has ${penalties.length}/${recentEvents.length} negative events`,
      details: { asn, penaltyRatio: penalties.length / recentEvents.length },
    });
  }
}

/** Run anomaly detection scan. Checks for mass slashing patterns. */
export async function runAnomalyDetection(): Promise<CreditOpsAlert[]> {
  const alerts: CreditOpsAlert[] = [];

  // Check for mass slashing (> 10 events in recent window)
  const recentSlashings = await adminDb().collection("slashingEvents").orderBy("slashedAt", "desc").limit(50).get();

  if (recentSlashings.docs.length >= 10) {
    const alertId = await createAlert({
      alertType: "mass_slashing",
      severity: "warning",
      message: `${recentSlashings.docs.length} slashing events detected recently`,
      details: { count: recentSlashings.docs.length },
    });
    alerts.push({ id: alertId } as CreditOpsAlert);
  }

  return alerts;
}

// ═══════════════════════════════════════════════════════════════
// Background Service
// ═══════════════════════════════════════════════════════════════

let monitoringInterval: NodeJS.Timeout | null = null;

/** Start the monitoring service. Checks for anomalies every 30 minutes. */
export function startMonitoringService(): void {
  if (monitoringInterval) {
    console.warn("Monitoring service already running");
    return;
  }

  console.log("Starting credit ops monitoring service (interval: 30 minutes)");

  // Run immediately
  runAnomalyDetection().catch((error) => {
    console.error("Initial anomaly detection failed:", error);
  });

  // Then every 30 minutes
  monitoringInterval = setInterval(async () => {
    try {
      const alerts = await runAnomalyDetection();
      if (alerts.length > 0) {
        console.log(`Credit ops monitoring: ${alerts.length} alerts created`);
      }
    } catch (error) {
      console.error("Monitoring service error:", error);
    }
  }, 30 * 60 * 1000);
}

/** Stop the monitoring service. */
export function stopMonitoringService(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log("Stopped credit ops monitoring service");
  }
}
