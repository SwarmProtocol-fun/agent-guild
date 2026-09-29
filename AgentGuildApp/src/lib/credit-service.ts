/**
 * Credit Service — Core service layer for all credit-related operations.
 *
 * Centralizes credit logic into a single importable module.
 * Consumed by API routes, enforcement middleware, and webhooks.
 *
 * Depends on:
 *   - credit-scoring.ts: getScoreBand(), getDefaultPolicy(), PolicyState, ScoreBandInfo
 *   - hedera-hcs-client.ts: ScoreEvent, getReputationTopicId()
 *   - credit-cache.ts: getCached, setCache, invalidateCache
 *   - firebase.ts: Firestore db
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
    getScoreBand,
    getDefaultPolicy,
    type ScoreBandInfo,
    type PolicyState,
} from "@/lib/credit-scoring";
import type { ScoreEvent } from "@/lib/credit-types";
import { getCached, setCache } from "@/lib/credit-cache";

// [agent-guild-core] Hedera HCS removed — install agent-guild-hedera mod.
// No reputation topic is configured in core, so HCS history is always empty.
const getReputationTopicId = (): string | null => null;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CreditProfile {
    agentId: string;
    asn: string | null;
    creditScore: number;
    trustScore: number;
    scoreBand: ScoreBandInfo;
    policyTier: PolicyState;
    lastCreditUpdate: string | null;
    lastCreditReason: string | null;
    tasksCompleted: number;
    status: string;
    verificationLevel: string;
}

export interface CreditHistoryOptions {
    limit?: number;
    offset?: number;
    eventType?: ScoreEvent["type"];
}

export interface ScoreHistoryEntry {
    timestamp: string;
    sequenceNumber: number;
    event: ScoreEvent;
    cumulativeCreditScore: number;
    cumulativeTrustScore: number;
}

export interface CreditHistoryResult {
    asn: string;
    events: ScoreHistoryEntry[];
    total: number;
    currentCreditScore: number;
    currentTrustScore: number;
}

export interface CreditFactor {
    name: string;
    impact: "positive" | "negative" | "neutral";
    weight: number;
    description: string;
    value: string;
}

export interface CreditExplanation {
    agentId: string;
    asn: string;
    currentScore: number;
    scoreBand: ScoreBandInfo;
    factors: CreditFactor[];
    summary: string;
}

export interface PolicyTierResult {
    agentId: string;
    creditScore: number;
    trustScore: number;
    scoreBand: ScoreBandInfo;
    policy: PolicyState;
    constraints: {
        canAcceptTasks: boolean;
        canPublishMarketplace: boolean;
        canCreateCompute: boolean;
        canAcceptBounties: boolean;
    };
}

export interface RecomputeResult {
    agentId: string;
    asn: string;
    previousCreditScore: number;
    previousTrustScore: number;
    newCreditScore: number;
    newTrustScore: number;
    eventsProcessed: number;
}

export interface SimulationResult {
    agentId: string;
    currentCreditScore: number;
    currentTrustScore: number;
    projectedCreditScore: number;
    projectedTrustScore: number;
    projectedBand: ScoreBandInfo;
    projectedPolicy: PolicyState;
    events: Array<{ type: string; creditDelta: number; trustDelta: number }>;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

// Dead unless a mod supplies a real getReputationTopicId() — see the stub note above.
const MIRROR_NODE_URL = process.env.HEDERA_MIRROR_NODE_URL || "";
const DEFAULT_CREDIT_SCORE = 680;
const DEFAULT_TRUST_SCORE = 50;
const CREDIT_MIN = 300;
const CREDIT_MAX = 900;
const TRUST_MIN = 0;
const TRUST_MAX = 100;

// ═══════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════

interface MirrorMessage {
    consensus_timestamp: string;
    message: string;
    sequence_number: number;
}

/** Fetch and decode HCS events for a given ASN from Mirror Node. */
async function fetchHCSEventsForASN(
    asn: string,
    limit = 500,
): Promise<{ events: Array<{ event: ScoreEvent; timestamp: string; sequenceNumber: number }>; total: number }> {
    const topicId = getReputationTopicId();
    if (!topicId) {
        return { events: [], total: 0 };
    }

    const url = `${MIRROR_NODE_URL}/api/v1/topics/${topicId.toString()}/messages?limit=${limit}&order=asc`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Mirror Node API error: ${response.status}`);
    }

    const data = await response.json();
    const messages: MirrorMessage[] = data.messages || [];

    const filtered: Array<{ event: ScoreEvent; timestamp: string; sequenceNumber: number }> = [];

    for (const message of messages) {
        try {
            const jsonStr = Buffer.from(message.message, "base64").toString("utf-8");
            const event = JSON.parse(jsonStr) as ScoreEvent;
            if (event.asn === asn) {
                filtered.push({
                    event,
                    timestamp: message.consensus_timestamp,
                    sequenceNumber: message.sequence_number,
                });
            }
        } catch {
            // Skip invalid messages
        }
    }

    return { events: filtered, total: filtered.length };
}

/** Build cumulative score timeline from raw events. */
function buildScoreTimeline(
    events: Array<{ event: ScoreEvent; timestamp: string; sequenceNumber: number }>,
): { history: ScoreHistoryEntry[]; finalCredit: number; finalTrust: number } {
    let credit = DEFAULT_CREDIT_SCORE;
    let trust = DEFAULT_TRUST_SCORE;
    const history: ScoreHistoryEntry[] = [];

    for (const entry of events) {
        // Use checkpoint as anchor point if available
        if (entry.event.type === "checkpoint" && entry.event.metadata?.finalCreditScore) {
            credit = entry.event.metadata.finalCreditScore as number;
            trust = (entry.event.metadata.finalTrustScore as number) ?? trust;
        }

        credit = Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, credit + entry.event.creditDelta));
        trust = Math.max(TRUST_MIN, Math.min(TRUST_MAX, trust + entry.event.trustDelta));

        history.push({
            timestamp: entry.timestamp,
            sequenceNumber: entry.sequenceNumber,
            event: entry.event,
            cumulativeCreditScore: credit,
            cumulativeTrustScore: trust,
        });
    }

    return { history, finalCredit: credit, finalTrust: trust };
}

/** Convert Firestore timestamp to ISO string. */
function timestampToString(ts: unknown): string | null {
    if (!ts) return null;
    if (typeof ts === "object" && ts !== null && "toDate" in ts) {
        return (ts as { toDate: () => Date }).toDate().toISOString();
    }
    if (ts instanceof Date) return ts.toISOString();
    return null;
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Get a complete credit profile for an agent by ID.
 */
export async function getCreditProfile(agentId: string): Promise<CreditProfile | null> {
    const agentSnap = await adminDb().collection("agents").doc(agentId).get();

    if (!agentSnap.exists) return null;

    const data = agentSnap.data()!;
    const creditScore = (data.creditScore as number) ?? DEFAULT_CREDIT_SCORE;
    const trustScore = (data.trustScore as number) ?? DEFAULT_TRUST_SCORE;

    return {
        agentId,
        asn: (data.asn as string) || null,
        creditScore,
        trustScore,
        scoreBand: getScoreBand(creditScore),
        policyTier: getDefaultPolicy(creditScore),
        lastCreditUpdate: timestampToString(data.lastCreditUpdate),
        lastCreditReason: (data.lastCreditReason as string) || null,
        tasksCompleted: (data.tasksCompleted as number) || 0,
        status: (data.status as string) || "active",
        verificationLevel: (data.verificationLevel as string) || "unverified",
    };
}

/**
 * Get a credit profile by ASN.
 */
export async function getCreditProfileByAsn(asn: string): Promise<CreditProfile | null> {
    const snap = await adminDb().collection("agents").where("asn", "==", asn).limit(1).get();

    if (snap.empty) return null;

    const agentDoc = snap.docs[0];
    return getCreditProfile(agentDoc.id);
}

/**
 * Get a credit profile with in-memory caching (60s TTL).
 */
export async function getCreditProfileCached(agentId: string): Promise<CreditProfile | null> {
    const cacheKey = `credit:${agentId}`;
    const cached = getCached<CreditProfile>(cacheKey);
    if (cached) return cached;

    const profile = await getCreditProfile(agentId);
    if (profile) setCache(cacheKey, profile);
    return profile;
}

/**
 * Get paginated credit event history for an agent.
 */
export async function getCreditHistory(
    agentId: string,
    opts: CreditHistoryOptions = {},
): Promise<CreditHistoryResult | null> {
    const profile = await getCreditProfile(agentId);
    if (!profile || !profile.asn) {
        return profile ? { asn: "", events: [], total: 0, currentCreditScore: profile.creditScore, currentTrustScore: profile.trustScore } : null;
    }

    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;

    const { events } = await fetchHCSEventsForASN(profile.asn, 500);

    // Filter by event type if specified
    const filtered = opts.eventType
        ? events.filter(e => e.event.type === opts.eventType)
        : events;

    // Build full timeline to get cumulative scores
    const { history, finalCredit, finalTrust } = buildScoreTimeline(filtered);

    // Apply pagination
    const paginated = history.slice(offset, offset + limit);

    return {
        asn: profile.asn,
        events: paginated,
        total: history.length,
        currentCreditScore: finalCredit,
        currentTrustScore: finalTrust,
    };
}

/**
 * Get a human-readable explanation of an agent's credit score factors.
 */
export async function getCreditExplanation(agentId: string): Promise<CreditExplanation | null> {
    const profile = await getCreditProfile(agentId);
    if (!profile) return null;

    const factors: CreditFactor[] = [];

    // If agent has an ASN, analyze event history
    if (profile.asn) {
        try {
            const { events } = await fetchHCSEventsForASN(profile.asn, 500);

            // Factor 1: Task completion rate
            const taskCompletes = events.filter(e => e.event.type === "task_complete").length;
            const taskFails = events.filter(e => e.event.type === "task_fail").length;
            const totalTasks = taskCompletes + taskFails;
            const completionRate = totalTasks > 0 ? taskCompletes / totalTasks : 1;

            factors.push({
                name: "Task Completion Rate",
                impact: completionRate >= 0.8 ? "positive" : completionRate >= 0.5 ? "neutral" : "negative",
                weight: 0.35,
                description: totalTasks > 0
                    ? `Completed ${taskCompletes} of ${totalTasks} tasks (${(completionRate * 100).toFixed(0)}% success rate)`
                    : "No task history available",
                value: totalTasks > 0 ? `${(completionRate * 100).toFixed(0)}%` : "N/A",
            });

            // Factor 2: Penalty history
            const penalties = events.filter(e => e.event.type === "penalty");
            const totalPenaltyCredit = penalties.reduce((sum, e) => sum + Math.abs(e.event.creditDelta), 0);

            factors.push({
                name: "Penalty History",
                impact: penalties.length === 0 ? "positive" : penalties.length <= 2 ? "neutral" : "negative",
                weight: 0.25,
                description: penalties.length === 0
                    ? "No penalties received — clean record"
                    : `${penalties.length} penalties totaling -${totalPenaltyCredit} credit`,
                value: `${penalties.length} penalties`,
            });

            // Factor 3: Skill diversity
            const skillEvents = events.filter(e => e.event.type === "skill_report");
            const uniqueSkills = new Set<string>();
            for (const se of skillEvents) {
                const skills = (se.event.metadata?.skills as string[]) || [];
                skills.forEach(s => uniqueSkills.add(s));
            }

            factors.push({
                name: "Skill Diversity",
                impact: uniqueSkills.size >= 5 ? "positive" : uniqueSkills.size >= 2 ? "neutral" : "negative",
                weight: 0.15,
                description: uniqueSkills.size > 0
                    ? `${uniqueSkills.size} unique skills reported`
                    : "No skills reported",
                value: `${uniqueSkills.size} skills`,
            });

            // Factor 4: Activity recency
            const lastEvent = events.length > 0 ? events[events.length - 1] : null;
            const daysSinceLastActivity = lastEvent
                ? (Date.now() / 1000 - lastEvent.event.timestamp) / 86400
                : Infinity;

            factors.push({
                name: "Activity Recency",
                impact: daysSinceLastActivity <= 7 ? "positive" : daysSinceLastActivity <= 30 ? "neutral" : "negative",
                weight: 0.15,
                description: lastEvent
                    ? `Last activity ${daysSinceLastActivity.toFixed(0)} days ago`
                    : "No recorded activity",
                value: lastEvent ? `${daysSinceLastActivity.toFixed(0)}d ago` : "N/A",
            });

            // Factor 5: Bonus events
            const bonuses = events.filter(e => e.event.type === "bonus");
            const totalBonusCredit = bonuses.reduce((sum, e) => sum + e.event.creditDelta, 0);

            factors.push({
                name: "Bonuses & Rewards",
                impact: bonuses.length > 0 ? "positive" : "neutral",
                weight: 0.10,
                description: bonuses.length > 0
                    ? `${bonuses.length} bonuses totaling +${totalBonusCredit} credit`
                    : "No bonuses received",
                value: bonuses.length > 0 ? `+${totalBonusCredit}` : "None",
            });
        } catch (error) {
            console.error("[credit-service] Failed to fetch HCS events for explanation:", error);
            factors.push({
                name: "Event History",
                impact: "neutral",
                weight: 1.0,
                description: "Unable to retrieve event history — score based on Firestore record",
                value: "Unavailable",
            });
        }
    } else {
        factors.push({
            name: "ASN Registration",
            impact: "negative",
            weight: 1.0,
            description: "Agent does not have an ASN — event-sourced scoring unavailable",
            value: "No ASN",
        });
    }

    // Generate summary
    const band = getScoreBand(profile.creditScore);
    const positiveFactors = factors.filter(f => f.impact === "positive").length;
    const negativeFactors = factors.filter(f => f.impact === "negative").length;

    let summary = `Agent has a ${band.label.toLowerCase()} credit score of ${profile.creditScore} (band: ${band.range}).`;
    if (positiveFactors > negativeFactors) {
        summary += ` Score is supported by ${positiveFactors} positive factor${positiveFactors > 1 ? "s" : ""}.`;
    } else if (negativeFactors > positiveFactors) {
        summary += ` Score is weighed down by ${negativeFactors} negative factor${negativeFactors > 1 ? "s" : ""}.`;
    } else {
        summary += ` Score reflects a balanced mix of positive and negative factors.`;
    }

    return {
        agentId,
        asn: profile.asn || "",
        currentScore: profile.creditScore,
        scoreBand: band,
        factors,
        summary,
    };
}

/**
 * Get the current policy tier and action constraints for an agent.
 */
export async function getPolicyTier(agentId: string): Promise<PolicyTierResult | null> {
    const profile = await getCreditProfile(agentId);
    if (!profile) return null;

    const policy = getDefaultPolicy(profile.creditScore);

    return {
        agentId,
        creditScore: profile.creditScore,
        trustScore: profile.trustScore,
        scoreBand: getScoreBand(profile.creditScore),
        policy,
        constraints: {
            canAcceptTasks: profile.creditScore >= CREDIT_MIN,
            canPublishMarketplace: profile.creditScore >= 550,
            canCreateCompute: profile.creditScore >= 550,
            canAcceptBounties: profile.creditScore >= 550,
        },
    };
}

/**
 * Recompute an agent's credit score by replaying all HCS events from baseline.
 * Updates Firestore with the recomputed score.
 */
export async function recomputeScore(agentId: string): Promise<RecomputeResult> {
    const agentRef = adminDb().collection("agents").doc(agentId);
    const agentSnap = await agentRef.get();

    if (!agentSnap.exists) {
        throw new Error("Agent not found");
    }

    const data = agentSnap.data()!;
    const asn = data.asn as string;
    if (!asn) {
        throw new Error("Agent does not have an ASN — cannot recompute from HCS");
    }

    const previousCredit = (data.creditScore as number) ?? DEFAULT_CREDIT_SCORE;
    const previousTrust = (data.trustScore as number) ?? DEFAULT_TRUST_SCORE;

    // Fetch all events and replay
    const { events } = await fetchHCSEventsForASN(asn, 1000);
    if (events.length === 0) {
        // Replaying zero events would reset the agent to the baseline score.
        throw new Error("No HCS events available (reputation topic not configured) — refusing to overwrite score");
    }
    const { finalCredit, finalTrust } = buildScoreTimeline(events);

    // Update Firestore
    await agentRef.update({
        creditScore: finalCredit,
        trustScore: finalTrust,
        lastCreditUpdate: FieldValue.serverTimestamp(),
        lastCreditReason: `Recomputed from ${events.length} HCS events`,
    });

    return {
        agentId,
        asn,
        previousCreditScore: previousCredit,
        previousTrustScore: previousTrust,
        newCreditScore: finalCredit,
        newTrustScore: finalTrust,
        eventsProcessed: events.length,
    };
}

/**
 * Simulate score changes given hypothetical events (read-only, no state changes).
 */
export async function simulateScore(
    agentId: string,
    hypotheticalEvents: Array<{ type: ScoreEvent["type"]; creditDelta: number; trustDelta: number }>,
): Promise<SimulationResult> {
    const profile = await getCreditProfile(agentId);
    if (!profile) {
        throw new Error("Agent not found");
    }

    let credit = profile.creditScore;
    let trust = profile.trustScore;

    const appliedEvents: SimulationResult["events"] = [];

    for (const event of hypotheticalEvents) {
        credit = Math.max(CREDIT_MIN, Math.min(CREDIT_MAX, credit + event.creditDelta));
        trust = Math.max(TRUST_MIN, Math.min(TRUST_MAX, trust + event.trustDelta));
        appliedEvents.push({
            type: event.type,
            creditDelta: event.creditDelta,
            trustDelta: event.trustDelta,
        });
    }

    return {
        agentId,
        currentCreditScore: profile.creditScore,
        currentTrustScore: profile.trustScore,
        projectedCreditScore: credit,
        projectedTrustScore: trust,
        projectedBand: getScoreBand(credit),
        projectedPolicy: getDefaultPolicy(credit),
        events: appliedEvents,
    };
}
