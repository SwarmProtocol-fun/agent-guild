/**
 * Low-Value Grinder Detector
 *
 * Detects agents grinding repetitive, near-identical trivial tasks
 * for credit score inflation.
 *
 * Algorithm:
 * 1. Per agent, get completed tasks in 14-day window
 * 2. Compute title similarity using Jaccard index on tokenized words
 * 3. Flag if > 60% of completions have > 0.7 title similarity
 * 4. Also flag if > 10 completions with titles shorter than 20 chars
 *
 * This is an informational signal — recommends credit discounting, not direct penalty.
 */

import { adminDb } from "@/lib/firebase-admin";
import type { RiskSignal, FraudDetectionConfig } from "../fraud-detection";

export async function detectLowValueGrinding(
  orgId: string,
  windowDays: number,
  config: FraudDetectionConfig,
  scanRunId: string,
): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const windowStart = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14-day window
  const windowEnd = Date.now();

  // Query completed assignments in the org
  const assignmentsSnap = await adminDb()
    .collection("taskAssignments")
    .where("orgId", "==", orgId)
    .where("status", "==", "completed")
    .get();

  // Group by agent
  const agentTasks = new Map<string, { title: string; id: string }[]>();

  for (const d of assignmentsSnap.docs) {
    const data = d.data();
    const completedAt = data.completedAt?.toDate?.()?.getTime()
      || data.updatedAt?.toDate?.()?.getTime() || 0;
    if (completedAt < windowStart) continue;

    const agentId = data.toAgentId;
    if (!agentId) continue;

    if (!agentTasks.has(agentId)) {
      agentTasks.set(agentId, []);
    }

    agentTasks.get(agentId)!.push({
      title: data.title || "",
      id: d.id,
    });
  }

  // Evaluate each agent
  for (const [agentId, tasks] of agentTasks) {
    if (tasks.length < 5) continue; // Need minimum volume

    // Check 1: Title similarity (pairwise Jaccard)
    let similarPairs = 0;
    let totalPairs = 0;

    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        totalPairs++;
        const similarity = jaccardSimilarity(tasks[i].title, tasks[j].title);
        if (similarity > config.lowValueSimilarityThreshold) {
          similarPairs++;
        }
      }
    }

    const similarityRatio = totalPairs > 0 ? similarPairs / totalPairs : 0;

    // Check 2: Short titles (trivial tasks)
    const shortTitleCount = tasks.filter((t) => t.title.length < 20).length;
    const shortTitleRatio = shortTitleCount / tasks.length;

    let flagged = false;
    let severity: "low" | "medium" | "high" = "low";

    if (similarityRatio > 0.6) {
      flagged = true;
      severity = similarityRatio > 0.8 ? "high" : "medium";
    }

    if (shortTitleCount > 10 && shortTitleRatio > 0.7) {
      flagged = true;
      severity = severity === "high" ? "high" : "medium";
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
      // continue
    }

    const confidence = Math.min(1, similarityRatio * 0.8 + shortTitleRatio * 0.2);

    signals.push({
      agentId,
      asn: agentAsn,
      orgId,
      signalType: "repetitive_low_value",
      severity,
      confidence,
      evidence: {
        taskIds: tasks.slice(0, 20).map((t) => t.id),
        windowStart: Math.floor(windowStart / 1000),
        windowEnd: Math.floor(windowEnd / 1000),
        metric: similarityRatio,
        threshold: 0.6,
        description: `${tasks.length} tasks in 14 days: ${(similarityRatio * 100).toFixed(0)}% pairwise similarity, ${shortTitleCount} short titles (< 20 chars)`,
      },
      scanRunId,
      status: "active",
    });
  }

  return signals;
}

/**
 * Jaccard similarity on tokenized words.
 * Returns 0.0 (no overlap) to 1.0 (identical word sets).
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
