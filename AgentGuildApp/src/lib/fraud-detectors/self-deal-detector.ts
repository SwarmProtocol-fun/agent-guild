/**
 * Self-Deal Loop Detector
 *
 * Detects agents that assign tasks to each other in a reciprocal pattern.
 * A assigns to B, B assigns back to A — both completing tasks for mutual
 * score inflation.
 *
 * Algorithm:
 * 1. Query completed taskAssignments within the window
 * 2. Build directed edge list (fromAgentId → toAgentId) with counts
 * 3. For each edge A→B, check if reverse B→A exists
 * 4. Compute reciprocity ratio and flag if above threshold
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

export async function detectSelfDealLoops(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Query completed assignments in the org within the window
  const snap = await adminDb()
    .collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  // Filter by window and build edge counts
  const edgeCounts = new Map<string, number>(); // "fromId->toId" → count
  const agentDetails = new Map<string, { asn: string; orgId: string }>(); // agentId → details

  for (const d of snap.docs) {
    const data = d.data();

    // Filter by time window
    const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
    if (createdAt < windowStart) continue;

    const fromId = data.fromAgentId;
    const toId = data.toAgentId;
    if (!fromId || !toId || fromId === toId) continue;

    const edgeKey = `${fromId}->${toId}`;
    edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
  }

  // Check for reciprocal edges
  const checkedPairs = new Set<string>();

  for (const [edgeKey, countAB] of edgeCounts) {
    const [fromId, toId] = edgeKey.split("->");
    const pairKey = [fromId, toId].sort().join("|");

    if (checkedPairs.has(pairKey)) continue;
    checkedPairs.add(pairKey);

    const reverseKey = `${toId}->${fromId}`;
    const countBA = edgeCounts.get(reverseKey) || 0;

    if (countBA === 0) continue; // No reciprocal activity

    // Both directions need minimum completions
    if (countAB < config.selfDealMinCompletions || countBA < config.selfDealMinCompletions) continue;

    // Compute reciprocity ratio
    const reciprocity = Math.min(countAB, countBA) / Math.max(countAB, countBA);

    if (reciprocity < config.selfDealThreshold) continue;

    // Determine severity
    const severity = reciprocity > 0.8 ? "critical" as const : "high" as const;
    const confidence = Math.min(1, reciprocity * (Math.min(countAB, countBA) / 5));

    // Fetch agent details for both
    const agentADoc = await getAgentInfo(fromId);
    const agentBDoc = await getAgentInfo(toId);

    // Create signals for both agents in the loop
    for (const agentInfo of [
      { id: fromId, other: toId, info: agentADoc },
      { id: toId, other: fromId, info: agentBDoc },
    ]) {
      signals.push({
        agentId: agentInfo.id,
        asn: agentInfo.info?.asn || "",
        orgId,
        signalType: "self_deal_loop",
        severity,
        confidence,
        evidence: {
          counterpartyIds: [agentInfo.other],
          windowStart: Math.floor(windowStart / 1000),
          windowEnd: Math.floor(windowEnd / 1000),
          metric: reciprocity,
          threshold: config.selfDealThreshold,
          description: `Reciprocal task assignment loop: ${countAB} tasks A→B, ${countBA} tasks B→A (reciprocity: ${(reciprocity * 100).toFixed(0)}%)`,
        },
        scanRunId,
        status: "active",
      });
    }
  }

  return signals;
}

async function getAgentInfo(agentId: string): Promise<{ asn: string; orgId: string } | null> {
  try {
    const agentDoc = await adminDb().collection("agents").doc(agentId).get();
    if (!agentDoc.exists) return null;
    const data = agentDoc.data()!;
    return { asn: data.asn || "", orgId: data.orgId || "" };
  } catch {
    return null;
  }
}
