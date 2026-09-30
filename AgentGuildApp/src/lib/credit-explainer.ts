/**
 * Credit Explainer Engine
 *
 * Computes human-readable explanations for an agent's credit score.
 * Derives sub-scores, top drivers, movement summaries, and confidence
 * from the on-chain score-event history (Solana memos) and Firestore data.
 *
 * Designed to work with the current basic scoring model and to be
 * enriched when PRD 2 (scoring engine) and PRD 4 (policy tiers) land.
 */

import { adminDb } from "@/lib/firebase-admin";
import type { ScoreEvent } from "@/lib/credit-types";
import { getScoreEventHistoryForAsn } from "@/lib/solana/client";
import {
    getTierForScore,
    getConfidenceInfo,
    eventTypeLabel,
    CREDIT_SCORE_DEFAULT,
    TRUST_SCORE_DEFAULT,
    type TierDefinition,
    type ConfidenceInfo,
} from "./credit-tiers";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SubScores {
    /** Net credit from task_complete events */
    taskPerformance: number;
    /** Credit from skill_report events */
    skillDiversity: number;
    /** Net credit from penalty events (negative or zero) */
    penaltyHistory: number;
    /** Net credit from bonus events */
    bonusHistory: number;
}

export interface ScoreFactor {
    label: string;
    delta: number;
    count: number;
}

export interface RecentEvent {
    type: string;
    creditDelta: number;
    trustDelta: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export interface ScoreExplanation {
    agentId: string;
    asn: string;
    currentCredit: number;
    currentTrust: number;
    tier: TierDefinition;
    confidence: ConfidenceInfo;
    subScores: SubScores;
    topPositiveFactors: ScoreFactor[];
    topNegativeFactors: ScoreFactor[];
    movement7d: number;
    movement30d: number;
    recentEvents: RecentEvent[];
    activeRestrictions: string[];
}

export interface ScoreHistoryPoint {
    date: string;
    creditScore: number;
    trustScore: number;
}

// ═══════════════════════════════════════════════════════════════
// On-Chain Event Helpers
// ═══════════════════════════════════════════════════════════════

/** Fetch all on-chain score-event memos for a given ASN. */
async function fetchEventsForASN(asn: string, limit = 500): Promise<Array<{ event: ScoreEvent; timestamp: string }>> {
    const memos = await getScoreEventHistoryForAsn(asn, limit);
    const events: Array<{ event: ScoreEvent; timestamp: string }> = [];

    for (const memo of memos) {
        const event = memo.payload as ScoreEvent;
        if (event && typeof event === "object" && event.asn === asn) {
            events.push({
                event,
                timestamp: memo.blockTime ? new Date(memo.blockTime * 1000).toISOString() : "",
            });
        }
    }

    return events;
}

// ═══════════════════════════════════════════════════════════════
// Explanation Logic
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a full score explanation for an agent.
 * Fetches current scores from Firestore and event history from on-chain memos.
 */
export async function explainScore(agentId: string): Promise<ScoreExplanation> {
    // 1. Load agent from Firestore
    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        throw new Error(`Agent ${agentId} not found`);
    }

    const agentData = agentSnap.data()!;
    const asn = (agentData.asn as string) || "";
    const currentCredit = (agentData.creditScore as number) || CREDIT_SCORE_DEFAULT;
    const currentTrust = (agentData.trustScore as number) || TRUST_SCORE_DEFAULT;

    // 2. Fetch on-chain event history
    const events = asn ? await fetchEventsForASN(asn) : [];

    // 3. Compute sub-scores from event aggregation
    const subScores: SubScores = {
        taskPerformance: 0,
        skillDiversity: 0,
        penaltyHistory: 0,
        bonusHistory: 0,
    };

    // Aggregate factors by event type
    const factorMap = new Map<string, { delta: number; count: number }>();

    // Movement tracking
    const now = Date.now() / 1000;
    const sevenDaysAgo = now - 7 * 86400;
    const thirtyDaysAgo = now - 30 * 86400;
    let movement7d = 0;
    let movement30d = 0;

    for (const { event } of events) {
        // Sub-score aggregation
        switch (event.type) {
            case "task_complete":
                subScores.taskPerformance += event.creditDelta;
                break;
            case "task_fail":
                subScores.taskPerformance += event.creditDelta; // negative
                break;
            case "skill_report":
                subScores.skillDiversity += event.creditDelta;
                break;
            case "penalty":
                subScores.penaltyHistory += event.creditDelta;
                break;
            case "bonus":
                subScores.bonusHistory += event.creditDelta;
                break;
        }

        // Factor aggregation (skip checkpoints)
        if (event.type !== "checkpoint") {
            const label = eventTypeLabel(event.type);
            const existing = factorMap.get(label) || { delta: 0, count: 0 };
            existing.delta += event.creditDelta;
            existing.count++;
            factorMap.set(label, existing);
        }

        // Movement tracking
        if (event.timestamp >= sevenDaysAgo) {
            movement7d += event.creditDelta;
        }
        if (event.timestamp >= thirtyDaysAgo) {
            movement30d += event.creditDelta;
        }
    }

    // 4. Sort factors into positive and negative
    const allFactors = Array.from(factorMap.entries()).map(([label, data]) => ({
        label,
        delta: data.delta,
        count: data.count,
    }));

    const topPositiveFactors = allFactors
        .filter((f) => f.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 5);

    const topNegativeFactors = allFactors
        .filter((f) => f.delta < 0)
        .sort((a, b) => a.delta - b.delta) // most negative first
        .slice(0, 5);

    // 5. Recent events (last 10)
    const recentEvents: RecentEvent[] = events
        .slice(-10)
        .reverse()
        .map(({ event }) => ({
            type: event.type,
            creditDelta: event.creditDelta,
            trustDelta: event.trustDelta,
            timestamp: event.timestamp,
            metadata: event.metadata,
        }));

    // 6. Tier and confidence
    const tier = getTierForScore(currentCredit);
    const confidence = getConfidenceInfo(events.length);

    return {
        agentId,
        asn,
        currentCredit,
        currentTrust,
        tier,
        confidence,
        subScores,
        topPositiveFactors,
        topNegativeFactors,
        movement7d,
        movement30d,
        recentEvents,
        activeRestrictions: tier.restrictions,
    };
}

/**
 * Generate a daily time-series of credit/trust scores for charting.
 * Aggregates on-chain events by day, computing running totals.
 */
export async function getScoreHistory(agentId: string, days = 30): Promise<ScoreHistoryPoint[]> {
    // Load agent for ASN and current scores
    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        throw new Error(`Agent ${agentId} not found`);
    }

    const agentData = agentSnap.data()!;
    const asn = (agentData.asn as string) || "";

    if (!asn) {
        // No ASN = no on-chain history — return current score as flat line
        const credit = (agentData.creditScore as number) || CREDIT_SCORE_DEFAULT;
        const trust = (agentData.trustScore as number) || TRUST_SCORE_DEFAULT;
        const today = new Date().toISOString().slice(0, 10);
        return [{ date: today, creditScore: credit, trustScore: trust }];
    }

    const events = await fetchEventsForASN(asn);
    if (events.length === 0) {
        const credit = (agentData.creditScore as number) || CREDIT_SCORE_DEFAULT;
        const trust = (agentData.trustScore as number) || TRUST_SCORE_DEFAULT;
        const today = new Date().toISOString().slice(0, 10);
        return [{ date: today, creditScore: credit, trustScore: trust }];
    }

    // Group events by day and compute running totals
    const cutoff = Date.now() / 1000 - days * 86400;
    let runningCredit = CREDIT_SCORE_DEFAULT;
    let runningTrust = TRUST_SCORE_DEFAULT;
    const dailyMap = new Map<string, { credit: number; trust: number }>();

    for (const { event } of events) {
        runningCredit = Math.max(300, Math.min(900, runningCredit + event.creditDelta));
        runningTrust = Math.max(0, Math.min(100, runningTrust + event.trustDelta));

        if (event.timestamp >= cutoff) {
            const date = new Date(event.timestamp * 1000).toISOString().slice(0, 10);
            dailyMap.set(date, { credit: runningCredit, trust: runningTrust });
        }
    }

    // Fill in missing days with carry-forward
    const result: ScoreHistoryPoint[] = [];
    const startDate = new Date(cutoff * 1000);
    const endDate = new Date();

    // Find the last known score before the cutoff
    let lastCredit = CREDIT_SCORE_DEFAULT;
    let lastTrust = TRUST_SCORE_DEFAULT;
    for (const { event } of events) {
        if (event.timestamp >= cutoff) break;
        lastCredit = Math.max(300, Math.min(900, lastCredit + event.creditDelta));
        lastTrust = Math.max(0, Math.min(100, lastTrust + event.trustDelta));
    }

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const dayData = dailyMap.get(dateStr);
        if (dayData) {
            lastCredit = dayData.credit;
            lastTrust = dayData.trust;
        }
        result.push({
            date: dateStr,
            creditScore: lastCredit,
            trustScore: lastTrust,
        });
    }

    return result;
}
