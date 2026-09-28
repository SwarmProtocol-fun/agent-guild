/**
 * System Resource Vitals Collector
 *
 * Auto-collect and monitor CPU, memory, and disk usage from agents.
 * Alerts on threshold violations (warning/critical levels).
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface AgentVitals {
  cpu: number; // Percentage (0-100)
  memory: number; // Percentage (0-100)
  disk: number; // Percentage (0-100)
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  diskUsedGB?: number;
  diskTotalGB?: number;
}

export interface VitalsRecord {
  id: string;
  orgId: string;
  agentId: string;
  agentName?: string;
  vitals: AgentVitals;
  timestamp: Date | null;
}

export interface VitalAlert {
  id: string;
  orgId: string;
  agentId: string;
  agentName?: string;
  resource: "cpu" | "memory" | "disk";
  threshold: number;
  currentValue: number;
  severity: "warning" | "critical";
  timestamp: Date | null;
  resolved: boolean;
  resolvedAt?: Date | null;
}

export interface VitalsThresholds {
  cpu: { warning: number; critical: number };
  memory: { warning: number; critical: number };
  disk: { warning: number; critical: number };
}

// Default thresholds
export const DEFAULT_THRESHOLDS: VitalsThresholds = {
  cpu: { warning: 70, critical: 90 },
  memory: { warning: 75, critical: 90 },
  disk: { warning: 80, critical: 95 },
};

// ═══════════════════════════════════════════════════════════════
// Recording Vitals
// ═══════════════════════════════════════════════════════════════

export async function recordVitals(
  orgId: string,
  agentId: string,
  vitals: AgentVitals,
  agentName?: string
): Promise<string> {
  const ref = await adminDb().collection("agentVitals").add({
    orgId,
    agentId,
    agentName: agentName || agentId,
    vitals,
    timestamp: FieldValue.serverTimestamp(),
  });

  // Check for threshold violations
  await checkThresholds(orgId, agentId, vitals, agentName);

  return ref.id;
}

// ═══════════════════════════════════════════════════════════════
// Threshold Monitoring
// ═══════════════════════════════════════════════════════════════

async function checkThresholds(
  orgId: string,
  agentId: string,
  vitals: AgentVitals,
  agentName?: string
): Promise<void> {
  const thresholds = DEFAULT_THRESHOLDS;

  // Check CPU
  if (vitals.cpu >= thresholds.cpu.critical) {
    await createAlert(
      orgId,
      agentId,
      "cpu",
      thresholds.cpu.critical,
      vitals.cpu,
      "critical",
      agentName
    );
  } else if (vitals.cpu >= thresholds.cpu.warning) {
    await createAlert(
      orgId,
      agentId,
      "cpu",
      thresholds.cpu.warning,
      vitals.cpu,
      "warning",
      agentName
    );
  }

  // Check Memory
  if (vitals.memory >= thresholds.memory.critical) {
    await createAlert(
      orgId,
      agentId,
      "memory",
      thresholds.memory.critical,
      vitals.memory,
      "critical",
      agentName
    );
  } else if (vitals.memory >= thresholds.memory.warning) {
    await createAlert(
      orgId,
      agentId,
      "memory",
      thresholds.memory.warning,
      vitals.memory,
      "warning",
      agentName
    );
  }

  // Check Disk
  if (vitals.disk >= thresholds.disk.critical) {
    await createAlert(
      orgId,
      agentId,
      "disk",
      thresholds.disk.critical,
      vitals.disk,
      "critical",
      agentName
    );
  } else if (vitals.disk >= thresholds.disk.warning) {
    await createAlert(
      orgId,
      agentId,
      "disk",
      thresholds.disk.warning,
      vitals.disk,
      "warning",
      agentName
    );
  }
}

async function createAlert(
  orgId: string,
  agentId: string,
  resource: "cpu" | "memory" | "disk",
  threshold: number,
  currentValue: number,
  severity: "warning" | "critical",
  agentName?: string
): Promise<void> {
  // Check if alert already exists for this resource
  const existingSnap = await adminDb()
    .collection("vitalAlerts")
    .where("orgId", "==", orgId)
    .where("agentId", "==", agentId)
    .where("resource", "==", resource)
    .where("resolved", "==", false)
    .get();

  if (!existingSnap.empty) {
    // Update existing alert
    const alertDoc = existingSnap.docs[0];
    await adminDb().collection("vitalAlerts").doc(alertDoc.id).set(
      {
        currentValue,
        severity,
        timestamp: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    // Create new alert
    await adminDb().collection("vitalAlerts").add({
      orgId,
      agentId,
      agentName: agentName || agentId,
      resource,
      threshold,
      currentValue,
      severity,
      timestamp: FieldValue.serverTimestamp(),
      resolved: false,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════

export async function getVitalsHistory(
  agentId: string,
  hoursBack: number = 24
): Promise<VitalsRecord[]> {
  const since = new Date();
  since.setHours(since.getHours() - hoursBack);

  const snap = await adminDb()
    .collection("agentVitals")
    .where("agentId", "==", agentId)
    .where("timestamp", ">=", Timestamp.fromDate(since))
    .orderBy("timestamp", "asc")
    .limit(1000)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      agentId: data.agentId,
      agentName: data.agentName,
      vitals: data.vitals,
      timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
    };
  });
}

export async function getAllVitalsHistory(
  orgId: string,
  hoursBack: number = 24
): Promise<VitalsRecord[]> {
  const since = new Date();
  since.setHours(since.getHours() - hoursBack);

  const snap = await adminDb()
    .collection("agentVitals")
    .where("orgId", "==", orgId)
    .where("timestamp", ">=", Timestamp.fromDate(since))
    .orderBy("timestamp", "desc")
    .limit(5000)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      agentId: data.agentId,
      agentName: data.agentName,
      vitals: data.vitals,
      timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
    };
  });
}

export async function getLatestVitals(agentId: string): Promise<VitalsRecord | null> {
  const snap = await adminDb()
    .collection("agentVitals")
    .where("agentId", "==", agentId)
    .orderBy("timestamp", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;

  const d = snap.docs[0];
  const data = d.data();
  return {
    id: d.id,
    orgId: data.orgId,
    agentId: data.agentId,
    agentName: data.agentName,
    vitals: data.vitals,
    timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Alerts
// ═══════════════════════════════════════════════════════════════

export async function getActiveAlerts(orgId: string): Promise<VitalAlert[]> {
  const snap = await adminDb()
    .collection("vitalAlerts")
    .where("orgId", "==", orgId)
    .where("resolved", "==", false)
    .orderBy("timestamp", "desc")
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      agentId: data.agentId,
      agentName: data.agentName,
      resource: data.resource,
      threshold: data.threshold,
      currentValue: data.currentValue,
      severity: data.severity,
      timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
      resolved: data.resolved,
      resolvedAt: data.resolvedAt instanceof Timestamp ? data.resolvedAt.toDate() : null,
    };
  });
}

export async function getAlertHistory(
  orgId: string,
  limit: number = 100
): Promise<VitalAlert[]> {
  const snap = await adminDb()
    .collection("vitalAlerts")
    .where("orgId", "==", orgId)
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      agentId: data.agentId,
      agentName: data.agentName,
      resource: data.resource,
      threshold: data.threshold,
      currentValue: data.currentValue,
      severity: data.severity,
      timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
      resolved: data.resolved,
      resolvedAt: data.resolvedAt instanceof Timestamp ? data.resolvedAt.toDate() : null,
    };
  });
}

export async function resolveAlert(alertId: string): Promise<void> {
  await adminDb().collection("vitalAlerts").doc(alertId).set(
    {
      resolved: true,
      resolvedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function resolveAllAlerts(orgId: string, agentId: string): Promise<void> {
  const snap = await adminDb()
    .collection("vitalAlerts")
    .where("orgId", "==", orgId)
    .where("agentId", "==", agentId)
    .where("resolved", "==", false)
    .get();
  const updates = snap.docs.map((d) =>
    adminDb().collection("vitalAlerts").doc(d.id).set(
      { resolved: true, resolvedAt: FieldValue.serverTimestamp() },
      { merge: true }
    )
  );

  await Promise.all(updates);
}

// ═══════════════════════════════════════════════════════════════
// Analytics
// ═══════════════════════════════════════════════════════════════

export interface VitalsStats {
  avgCpu: number;
  avgMemory: number;
  avgDisk: number;
  maxCpu: number;
  maxMemory: number;
  maxDisk: number;
  recordCount: number;
}

export function calculateVitalsStats(records: VitalsRecord[]): VitalsStats {
  if (records.length === 0) {
    return {
      avgCpu: 0,
      avgMemory: 0,
      avgDisk: 0,
      maxCpu: 0,
      maxMemory: 0,
      maxDisk: 0,
      recordCount: 0,
    };
  }

  const cpuValues = records.map((r) => r.vitals.cpu);
  const memoryValues = records.map((r) => r.vitals.memory);
  const diskValues = records.map((r) => r.vitals.disk);

  return {
    avgCpu: cpuValues.reduce((sum, v) => sum + v, 0) / cpuValues.length,
    avgMemory: memoryValues.reduce((sum, v) => sum + v, 0) / memoryValues.length,
    avgDisk: diskValues.reduce((sum, v) => sum + v, 0) / diskValues.length,
    maxCpu: Math.max(...cpuValues),
    maxMemory: Math.max(...memoryValues),
    maxDisk: Math.max(...diskValues),
    recordCount: records.length,
  };
}
