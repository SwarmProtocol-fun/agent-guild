/**
 * Graph Concentration Detector
 *
 * Detects agents whose interactions are highly concentrated among
 * very few counterparties — a sign of closed-loop score inflation.
 *
 * Algorithm:
 * 1. Build interaction graph per agent from assignments, comms, validations
 * 2. Compute unique counterparties (degree)
 * 3. Flag if high interaction count but very few counterparties
 * 4. Compute Herfindahl-Hirschman Index (HHI) on interaction distribution
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

interface InteractionMap {
  counterparties: Map<string, number>; // counterpartyId → interaction count
  totalInteractions: number;
}

export async function detectGraphConcentration(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Build per-agent interaction maps from multiple sources
  const agentInteractions = new Map<string, InteractionMap>();

  function addInteraction(agentId: string, counterpartyId: string) {
    if (agentId === counterpartyId) return;
    if (!agentInteractions.has(agentId)) {
      agentInteractions.set(agentId, { counterparties: new Map(), totalInteractions: 0 });
    }
    const map = agentInteractions.get(agentId)!;
    map.counterparties.set(counterpartyId, (map.counterparties.get(counterpartyId) || 0) + 1);
    map.totalInteractions++;
  }

  // Source 1: Task Assignments
  const assignmentsSnap = await adminDb().collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  for (const d of assignmentsSnap.docs) {
    const data = d.data();
    const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
    if (createdAt < windowStart) continue;

    const fromId = data.fromAgentId;
    const toId = data.toAgentId;
    if (fromId && toId) {
      addInteraction(fromId, toId);
      addInteraction(toId, fromId);
    }
  }

  // Source 2: Validation Stakes
  try {
    const stakesSnap = await adminDb().collection("validationStakes").get();

    for (const d of stakesSnap.docs) {
      const data = d.data();
      const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
      if (createdAt < windowStart) continue;

      const validatorId = data.validatorAgentId;
      const workerId = data.workerASN; // Cross-reference via ASN

      if (validatorId && workerId) {
        addInteraction(validatorId, workerId);
      }
    }
  } catch {
    // validationStakes may not exist yet
  }

  // Source 3: Agent Communications
  try {
    const commsSnap = await adminDb().collection("agentComms")
      .where("orgId", "==", orgId)
      .get();

    for (const d of commsSnap.docs) {
      const data = d.data();
      const createdAt = data.createdAt?.toDate?.()?.getTime() || 0;
      if (createdAt < windowStart) continue;

      const fromId = data.fromAgentId;
      const toId = data.toAgentId;
      if (fromId && toId) {
        addInteraction(fromId, toId);
        addInteraction(toId, fromId);
      }
    }
  } catch {
    // agentComms may not exist
  }

  // Evaluate each agent
  for (const [agentId, interactions] of agentInteractions) {
    // Skip agents with too few interactions
    if (interactions.totalInteractions < config.graphConcentrationMinInteractions) continue;

    const uniqueCounterparties = interactions.counterparties.size;

    // Flag 1: High interactions, very few counterparties
    if (uniqueCounterparties <= 2 && interactions.totalInteractions > 10) {
      let agentAsn = "";
      try {
        const agentDoc = await adminDb().collection("agents").doc(agentId).get();
        if (agentDoc.exists) {
          agentAsn = agentDoc.data()!.asn || "";
        }
      } catch {
        // continue
      }

      signals.push({
        agentId,
        asn: agentAsn,
        orgId,
        signalType: "graph_concentration",
        severity: uniqueCounterparties <= 1 ? "critical" : "high",
        confidence: Math.min(1, 0.7 + interactions.totalInteractions / 100),
        evidence: {
          counterpartyIds: [...interactions.counterparties.keys()],
          windowStart: Math.floor(windowStart / 1000),
          windowEnd: Math.floor(windowEnd / 1000),
          metric: uniqueCounterparties,
          threshold: 3,
          description: `${interactions.totalInteractions} interactions with only ${uniqueCounterparties} counterpart${uniqueCounterparties === 1 ? "y" : "ies"}`,
        },
        scanRunId,
        status: "active",
      });
      continue;
    }

    // Flag 2: HHI concentration index
    const hhi = computeHHI(interactions);
    if (hhi > config.graphConcentrationHHI) {
      let agentAsn = "";
      try {
        const agentDoc = await adminDb().collection("agents").doc(agentId).get();
        if (agentDoc.exists) {
          agentAsn = agentDoc.data()!.asn || "";
        }
      } catch {
        // continue
      }

      const topCounterparty = [...interactions.counterparties.entries()]
        .sort((a, b) => b[1] - a[1])[0];

      signals.push({
        agentId,
        asn: agentAsn,
        orgId,
        signalType: "graph_concentration",
        severity: hhi > 0.8 ? "high" : "medium",
        confidence: Math.min(1, hhi),
        evidence: {
          counterpartyIds: [...interactions.counterparties.keys()],
          windowStart: Math.floor(windowStart / 1000),
          windowEnd: Math.floor(windowEnd / 1000),
          metric: hhi,
          threshold: config.graphConcentrationHHI,
          description: `HHI concentration index: ${(hhi * 100).toFixed(0)}%. Top counterparty (${topCounterparty?.[0]}) accounts for ${((topCounterparty?.[1] || 0) / interactions.totalInteractions * 100).toFixed(0)}% of interactions`,
        },
        scanRunId,
        status: "active",
      });
    }
  }

  return signals;
}

/**
 * Compute Herfindahl-Hirschman Index.
 * HHI = sum(share_i^2) where share_i = interactions_with_i / total_interactions
 * Range: 0 (perfectly distributed) to 1 (all interactions with one counterparty)
 */
function computeHHI(interactions: InteractionMap): number {
  if (interactions.totalInteractions === 0) return 0;

  let hhi = 0;
  for (const count of interactions.counterparties.values()) {
    const share = count / interactions.totalInteractions;
    hhi += share * share;
  }

  return hhi;
}
