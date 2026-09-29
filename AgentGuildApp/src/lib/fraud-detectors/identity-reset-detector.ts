/**
 * Identity Reset / Laundering Detector
 *
 * Detects wallets that create new agents after previous agents under
 * the same wallet accumulated bad reputation — an attempt to escape
 * low credit scores by starting fresh.
 *
 * Algorithm:
 * 1. Group all agents by walletAddress
 * 2. For wallets with multiple agents, check if any previous agent had
 *    low creditScore or active risk signals
 * 3. Flag if new agent created within 7 days of old agent reaching low score
 * 4. Also check hierarchy for suspicious child agent creation patterns
 *
 * This is a platform-wide detector (not org-scoped).
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig, PlatformWideDetector } from "../fraud-detection";

const LOW_CREDIT_THRESHOLD = 400;
const RESET_WINDOW_DAYS = 7;

export const detectIdentityResets: PlatformWideDetector = async (
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> => {
  const signals: RiskSignal[] = [];

  // Fetch all agents
  const agentsSnap = await adminDb().collection("agents").get();

  // Group by wallet address
  const walletGroups = new Map<string, Array<{
    id: string;
    asn: string;
    orgId: string;
    name: string;
    walletAddress: string;
    creditScore: number;
    createdAt: number;
    status: string;
  }>>();

  for (const d of agentsSnap.docs) {
    const data = d.data();
    const wallet = (data.walletAddress || "").toLowerCase();
    if (!wallet) continue;

    if (!walletGroups.has(wallet)) {
      walletGroups.set(wallet, []);
    }

    walletGroups.get(wallet)!.push({
      id: d.id,
      asn: data.asn || "",
      orgId: data.orgId || "",
      name: data.name || d.id,
      walletAddress: wallet,
      creditScore: data.creditScore || 680, // Default starting score
      createdAt: data.createdAt?.toDate?.()?.getTime()
        || (typeof data.createdAt === "number" ? data.createdAt * 1000 : 0),
      status: data.status || "unknown",
    });
  }

  // Check wallets with multiple agents
  for (const [wallet, agents] of walletGroups) {
    if (agents.length < 2) continue;

    // Sort by creation time
    agents.sort((a, b) => a.createdAt - b.createdAt);

    // Check for pattern: old agent with low score → new agent created
    for (let i = 0; i < agents.length - 1; i++) {
      const oldAgent = agents[i];
      const newAgent = agents[i + 1];

      // Check if old agent had low credit score
      if (oldAgent.creditScore >= LOW_CREDIT_THRESHOLD) continue;

      // Check if new agent was created within the reset window
      const daysBetween = (newAgent.createdAt - oldAgent.createdAt) / (1000 * 60 * 60 * 24);
      if (daysBetween > RESET_WINDOW_DAYS * config.windowDays / 30) continue;

      // This looks like an identity reset
      const severity = oldAgent.creditScore < 350 ? "critical" as const : "high" as const;
      const confidence = Math.min(1, 0.7 + (LOW_CREDIT_THRESHOLD - oldAgent.creditScore) / 500);

      // Signal for the new agent (the one trying to escape)
      signals.push({
        agentId: newAgent.id,
        asn: newAgent.asn,
        orgId: newAgent.orgId,
        signalType: "identity_reset",
        severity,
        confidence,
        evidence: {
          counterpartyIds: [oldAgent.id],
          walletAddresses: [wallet],
          windowStart: Math.floor(oldAgent.createdAt / 1000),
          windowEnd: Math.floor(newAgent.createdAt / 1000),
          metric: oldAgent.creditScore,
          threshold: LOW_CREDIT_THRESHOLD,
          description: `New agent created ${daysBetween.toFixed(1)} days after previous agent (${oldAgent.name}, score: ${oldAgent.creditScore}) under same wallet ${wallet.slice(0, 10)}...`,
        },
        scanRunId,
        status: "active",
      });
    }
  }

  // Check for suspicious child agent trees
  // Agents that create many children to distribute bad reputation
  const parentChildMap = new Map<string, string[]>();
  for (const d of agentsSnap.docs) {
    const data = d.data();
    const parentId = data.parentAgentId;
    if (parentId) {
      if (!parentChildMap.has(parentId)) {
        parentChildMap.set(parentId, []);
      }
      parentChildMap.get(parentId)!.push(d.id);
    }
  }

  for (const [parentId, childIds] of parentChildMap) {
    if (childIds.length < 3) continue; // Need at least 3 children to be suspicious

    // Check if parent has low score
    const parentAgent = agentsSnap.docs.find((d) => d.id === parentId);
    if (!parentAgent) continue;

    const parentData = parentAgent.data();
    const parentScore = parentData.creditScore || 680;

    if (parentScore >= LOW_CREDIT_THRESHOLD) continue;

    // Check if children were created recently
    const recentChildren = childIds.filter((childId) => {
      const childDoc = agentsSnap.docs.find((d) => d.id === childId);
      if (!childDoc) return false;
      const createdAt = childDoc.data().createdAt?.toDate?.()?.getTime() || 0;
      return createdAt > Date.now() - config.windowDays * 24 * 60 * 60 * 1000;
    });

    if (recentChildren.length < 3) continue;

    signals.push({
      agentId: parentId,
      asn: parentData.asn || "",
      orgId: parentData.orgId || "",
      signalType: "identity_reset",
      severity: "high",
      confidence: Math.min(1, 0.6 + recentChildren.length * 0.05),
      evidence: {
        counterpartyIds: recentChildren,
        walletAddresses: [(parentData.walletAddress || "").toLowerCase()],
        windowStart: Math.floor((Date.now() - config.windowDays * 24 * 60 * 60 * 1000) / 1000),
        windowEnd: Math.floor(Date.now() / 1000),
        metric: recentChildren.length,
        threshold: 3,
        description: `Agent with low score (${parentScore}) created ${recentChildren.length} child agents recently — possible reputation distribution`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
};
