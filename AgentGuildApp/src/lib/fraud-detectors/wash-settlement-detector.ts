/**
 * Wash Settlement Detector
 *
 * Detects jobs that are created and settled suspiciously fast, especially
 * when the poster and completer share the same wallet or org owner.
 *
 * Algorithm:
 * 1. Query completed jobs within the window
 * 2. Compute settlement time (completedAt - createdAt)
 * 3. Flag if settlement < threshold AND poster/completer share wallet lineage
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

export async function detectWashSettlement(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const windowEnd = Date.now();

  // Query completed jobs in the org
  const snap = await adminDb()
    .collection("jobs")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  // Get org owner wallet for cross-reference
  const orgDoc = await adminDb().collection("organizations").doc(orgId).get();
  const orgOwnerWallet = orgDoc.exists
    ? (orgDoc.data()!.ownerAddress || "").toLowerCase()
    : "";

  // Track per-agent wash counts
  const agentWashCounts = new Map<string, { jobs: string[]; wallets: string[] }>();

  for (const jobDoc of snap.docs) {
    const data = jobDoc.data();

    // Filter by time window
    const createdAtMs = data.createdAt?.toDate?.()?.getTime()
      || (typeof data.createdAt === "number" ? data.createdAt * 1000 : 0);
    if (createdAtMs < windowStart) continue;

    const completedAtMs = data.updatedAt?.toDate?.()?.getTime()
      || data.completedAt?.toDate?.()?.getTime()
      || Date.now();

    const settlementMinutes = (completedAtMs - createdAtMs) / (1000 * 60);

    // Only flag fast settlements
    if (settlementMinutes >= config.washSettlementMinutes) continue;

    // Check if poster and completer share wallet lineage
    const posterWallet = (data.postedBy || data.createdBy || "").toLowerCase();
    const claimedByAgentId = data.claimedBy || data.assignedTo || "";

    if (!claimedByAgentId) continue;

    // Get completer's wallet
    let completerWallet = "";
    try {
      const agentDoc = await adminDb().collection("agents").doc(claimedByAgentId).get();
      if (agentDoc.exists) {
        completerWallet = (agentDoc.data()!.walletAddress || "").toLowerCase();
      }
    } catch {
      continue;
    }

    // Check for same-wallet or same-org-owner relationship
    const sameWallet = posterWallet && completerWallet && posterWallet === completerWallet;
    const sameOrgOwner = posterWallet === orgOwnerWallet && completerWallet === orgOwnerWallet;

    if (!sameWallet && !sameOrgOwner && settlementMinutes >= 2) continue;

    // Determine severity
    let severity: "medium" | "high" | "critical";
    if (sameWallet) {
      severity = "critical";
    } else if (settlementMinutes < 2) {
      severity = "high";
    } else {
      severity = "medium";
    }

    const confidence = sameWallet
      ? 0.95
      : sameOrgOwner
        ? 0.85
        : 0.7;

    // Track per agent
    if (!agentWashCounts.has(claimedByAgentId)) {
      agentWashCounts.set(claimedByAgentId, { jobs: [], wallets: [] });
    }
    const entry = agentWashCounts.get(claimedByAgentId)!;
    entry.jobs.push(jobDoc.id);
    if (posterWallet) entry.wallets.push(posterWallet);
  }

  // Generate signals for agents with multiple wash-settled jobs
  for (const [agentId, data] of agentWashCounts) {
    if (data.jobs.length < 2) continue; // Need at least 2 suspicious jobs

    let agentAsn = "";
    try {
      const agentDoc = await adminDb().collection("agents").doc(agentId).get();
      if (agentDoc.exists) {
        agentAsn = agentDoc.data()!.asn || "";
      }
    } catch {
      // continue without ASN
    }

    const uniqueWallets = [...new Set(data.wallets)];
    const hasSameWallet = uniqueWallets.length === 1 && uniqueWallets[0] === orgOwnerWallet;

    signals.push({
      agentId,
      asn: agentAsn,
      orgId,
      signalType: "wash_settlement",
      severity: hasSameWallet ? "critical" : "high",
      confidence: Math.min(1, 0.7 + data.jobs.length * 0.05),
      evidence: {
        jobIds: data.jobs,
        walletAddresses: uniqueWallets,
        windowStart: Math.floor(windowStart / 1000),
        windowEnd: Math.floor(windowEnd / 1000),
        metric: data.jobs.length,
        threshold: 2,
        description: `${data.jobs.length} jobs settled suspiciously fast (< ${config.washSettlementMinutes} min)${hasSameWallet ? " from same wallet" : ""}`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
}
