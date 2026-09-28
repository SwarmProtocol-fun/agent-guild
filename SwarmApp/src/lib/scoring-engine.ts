/**
 * Dynamic Scoring Engine (PRD 2)
 *
 * Computes multi-dimensional composite credit scores from verified events.
 * Replaces the flat credit/trust delta system with 5 sub-scores,
 * time decay, confidence weighting, model versioning, and simulation.
 *
 * Sub-scores:
 *   Execution     — Task completion rate, complexity-weighted success
 *   Reliability   — Deadline adherence, uptime, SLA compliance
 *   Settlement    — Payment/escrow completion, dispute resolution
 *   Trust Network — Endorsements, peer interactions, verification level
 *   Risk          — Inverse fraud/penalty load (100 = lowest risk)
 *
 * Architecture:
 *   HCS events → ingestScoreEvent() → event buffer
 *   Periodic / on-demand → computeAgentScore() → ScoreSnapshot
 *   ScoreSnapshot → Firestore (scoreSnapshots) + Agent doc update
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
// [swarm-core] Hedera removed
import type { ScoreEvent } from "@/lib/credit-types";
import { getScoreBand, type ScoreBand } from "./credit-scoring";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** The 5 sub-score dimensions */
export type SubScoreKind = "execution" | "reliability" | "settlement" | "trustNetwork" | "risk";

export const SUB_SCORE_KINDS: SubScoreKind[] = [
    "execution", "reliability", "settlement", "trustNetwork", "risk",
];

/** A single sub-score result */
export interface SubScore {
    kind: SubScoreKind;
    /** Raw value 0-100 */
    raw: number;
    /** After time decay applied */
    decayed: number;
    /** Confidence 0-1 based on data volume */
    confidence: number;
    /** Weighted contribution to composite */
    weighted: number;
    /** Event count used to compute this */
    eventCount: number;
    /** Span of data in days */
    dataSpanDays: number;
}

/** Complete score snapshot for an agent */
export interface ScoreSnapshot {
    agentId: string;
    asn: string;
    /** Composite credit score 300-900 */
    compositeScore: number;
    /** Trust score 0-100 (derived from trustNetwork sub-score) */
    trustScore: number;
    /** Individual sub-scores */
    subScores: Record<SubScoreKind, SubScore>;
    /** Overall confidence 0-1 */
    confidence: number;
    /** Score band */
    band: ScoreBand;
    /** Model version that produced this score */
    modelVersion: string;
    /** Delta from previous snapshot */
    delta: number;
    computedAt: unknown;
}

/** Inline breakdown stored on Agent doc */
export interface ScoreBreakdown {
    execution: number;
    reliability: number;
    settlement: number;
    trustNetwork: number;
    risk: number;
    confidence: number;
    modelVersion: string;
}

/** Scoring model definition (versioned) */
export interface ScoringModel {
    version: string;
    label: string;
    weights: Record<SubScoreKind, number>;
    decayHalfLifeDays: Record<SubScoreKind, number>;
    confidenceThresholds: Record<SubScoreKind, number>;
    confidenceMinSpanDays: number;
    active: boolean;
    createdAt: unknown;
}

/** Simulation result */
export interface SimulationResult {
    before: ScoreSnapshot;
    after: ScoreSnapshot;
    delta: number;
    subScoreDeltas: Record<SubScoreKind, number>;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const SCORE_SNAPSHOTS_COLLECTION = "scoreSnapshots";
const SCORING_MODELS_COLLECTION = "scoringModels";

/** Complexity weights for execution score */
const COMPLEXITY_WEIGHTS: Record<string, number> = {
    simple: 1.0,
    medium: 1.5,
    complex: 2.5,
};

/** Recompute threshold: recompute after this many buffered events */
const RECOMPUTE_EVENT_THRESHOLD = 5;

/** Recompute threshold: recompute after this many ms since last compute */
const RECOMPUTE_TIME_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const DEFAULT_MODEL: ScoringModel = {
    version: "v1.0.0",
    label: "Default Model",
    weights: {
        execution: 0.30,
        reliability: 0.25,
        settlement: 0.20,
        trustNetwork: 0.15,
        risk: 0.10,
    },
    decayHalfLifeDays: {
        execution: 90,
        reliability: 60,
        settlement: 120,
        trustNetwork: 180,
        risk: 30,
    },
    confidenceThresholds: {
        execution: 20,
        reliability: 15,
        settlement: 10,
        trustNetwork: 5,
        risk: 10,
    },
    confidenceMinSpanDays: 30,
    active: true,
    createdAt: null,
};

// ═══════════════════════════════════════════════════════════════
// In-Memory Event Buffer
// ═══════════════════════════════════════════════════════════════

/** Buffered events per agent (ASN → events) */
const eventBuffer = new Map<string, ScoreEvent[]>();

/** Timestamp of last full recompute per agent (ASN → epoch ms) */
const lastRecomputeTime = new Map<string, number>();

/**
 * Ingest a score event into the buffer.
 * Call this from the mirror subscriber for each decoded event.
 */
export function ingestScoreEvent(event: ScoreEvent): void {
    const events = eventBuffer.get(event.asn) || [];
    events.push(event);
    eventBuffer.set(event.asn, events);
}

/**
 * Check whether a full recompute should be triggered for this agent.
 */
export function shouldRecompute(asn: string): boolean {
    const events = eventBuffer.get(asn);
    if (!events || events.length === 0) return false;

    // Threshold: enough buffered events
    if (events.length >= RECOMPUTE_EVENT_THRESHOLD) return true;

    // Threshold: enough time since last recompute
    const lastTime = lastRecomputeTime.get(asn) || 0;
    if (Date.now() - lastTime >= RECOMPUTE_TIME_THRESHOLD_MS) return true;

    return false;
}

/**
 * Drain the event buffer for an agent after recompute.
 */
export function drainEventBuffer(asn: string): void {
    eventBuffer.delete(asn);
    lastRecomputeTime.set(asn, Date.now());
}

// ═══════════════════════════════════════════════════════════════
// Time Decay
// ═══════════════════════════════════════════════════════════════

/**
 * Exponential time decay factor.
 * Returns a multiplier in (0, 1] — recent events ≈ 1.0, old events → 0.
 */
function decayFactor(ageDays: number, halfLifeDays: number): number {
    if (halfLifeDays <= 0) return 1;
    return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Compute the age of an event in days from now.
 */
function eventAgeDays(eventTimestamp: number): number {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.max(0, (nowSec - eventTimestamp) / 86400);
}

// ═══════════════════════════════════════════════════════════════
// Confidence
// ═══════════════════════════════════════════════════════════════

/**
 * Compute confidence score (0-1) based on data volume and span.
 */
function computeConfidence(
    eventCount: number,
    dataSpanDays: number,
    threshold: number,
    minSpanDays: number,
): number {
    const eventConf = Math.min(1, eventCount / Math.max(1, threshold));
    const spanConf = Math.min(1, dataSpanDays / Math.max(1, minSpanDays));
    return eventConf * 0.7 + spanConf * 0.3;
}

/**
 * Adjust a raw score toward center based on confidence.
 * Low confidence → pulled toward 50 (center of 0-100).
 */
function confidenceAdjust(raw: number, confidence: number, center: number = 50): number {
    return raw * confidence + center * (1 - confidence);
}

// ═══════════════════════════════════════════════════════════════
// Sub-Score: Execution
// ═══════════════════════════════════════════════════════════════

/**
 * Compute execution sub-score from task completion events.
 * Factors: completion rate, complexity-weighted success.
 */
function computeExecutionScore(
    events: ScoreEvent[],
    halfLifeDays: number,
): { raw: number; decayed: number; eventCount: number; dataSpanDays: number } {
    const taskEvents = events.filter(e => e.type === "task_complete" || e.type === "task_fail");

    if (taskEvents.length === 0) {
        return { raw: 50, decayed: 50, eventCount: 0, dataSpanDays: 0 };
    }

    let completedWeightedSum = 0;
    let totalWeightedSum = 0;
    let decayedCompletedSum = 0;
    let decayedTotalSum = 0;

    const timestamps = taskEvents.map(e => e.timestamp);
    const oldestTs = Math.min(...timestamps);
    const newestTs = Math.max(...timestamps);
    const dataSpanDays = (newestTs - oldestTs) / 86400;

    for (const event of taskEvents) {
        const complexity = (event.metadata?.complexity as string) || "medium";
        const weight = COMPLEXITY_WEIGHTS[complexity] || 1.5;
        const decay = decayFactor(eventAgeDays(event.timestamp), halfLifeDays);

        totalWeightedSum += weight;
        decayedTotalSum += weight * decay;

        if (event.type === "task_complete") {
            completedWeightedSum += weight;
            decayedCompletedSum += weight * decay;
        }
    }

    // Raw: completion rate (70%) + complexity bonus (30%)
    const completionRate = totalWeightedSum > 0 ? completedWeightedSum / totalWeightedSum : 0;
    const avgComplexity = totalWeightedSum / Math.max(1, taskEvents.length);
    const complexityBonus = Math.min(1, (avgComplexity - 1) / 1.5); // Normalize 1.0-2.5 → 0-1
    const raw = Math.min(100, Math.max(0, completionRate * 70 + complexityBonus * 30));

    // Decayed version
    const decayedRate = decayedTotalSum > 0 ? decayedCompletedSum / decayedTotalSum : 0;
    const decayed = Math.min(100, Math.max(0, decayedRate * 70 + complexityBonus * 30));

    return { raw, decayed, eventCount: taskEvents.length, dataSpanDays };
}

// ═══════════════════════════════════════════════════════════════
// Sub-Score: Reliability
// ═══════════════════════════════════════════════════════════════

interface SlashingRecord {
    reason: string;
    creditPenalty: number;
    slashedAt: unknown;
}

/**
 * Compute reliability sub-score from slashing events and task events.
 * Factors: on-time rate, slash penalty count.
 */
function computeReliabilityScore(
    events: ScoreEvent[],
    slashingEvents: SlashingRecord[],
    halfLifeDays: number,
): { raw: number; decayed: number; eventCount: number; dataSpanDays: number } {
    const taskEvents = events.filter(e => e.type === "task_complete" || e.type === "task_fail");
    const totalEvents = taskEvents.length + slashingEvents.length;

    if (totalEvents === 0) {
        return { raw: 50, decayed: 50, eventCount: 0, dataSpanDays: 0 };
    }

    // On-time rate: task completions without corresponding slashes
    const completedCount = taskEvents.filter(e => e.type === "task_complete").length;
    const totalTaskCount = taskEvents.length;
    const onTimeRate = totalTaskCount > 0 ? completedCount / totalTaskCount : 0;

    // Slash penalty: each slash costs 5 pts, cap at 40
    const slashCount = slashingEvents.length;
    const slashPenalty = Math.min(40, slashCount * 5);

    // Raw score: on-time (80%) - slash penalty + base (20)
    const raw = Math.min(100, Math.max(0, onTimeRate * 80 - slashPenalty + 20));

    // Decayed: weight recent task events more
    let decayedOnTimeNum = 0;
    let decayedOnTimeDenom = 0;
    let oldestTs = Infinity;
    let newestTs = 0;

    for (const event of taskEvents) {
        const decay = decayFactor(eventAgeDays(event.timestamp), halfLifeDays);
        decayedOnTimeDenom += decay;
        if (event.type === "task_complete") {
            decayedOnTimeNum += decay;
        }
        oldestTs = Math.min(oldestTs, event.timestamp);
        newestTs = Math.max(newestTs, event.timestamp);
    }

    const decayedOnTimeRate = decayedOnTimeDenom > 0 ? decayedOnTimeNum / decayedOnTimeDenom : 0;
    const decayed = Math.min(100, Math.max(0, decayedOnTimeRate * 80 - slashPenalty + 20));

    const dataSpanDays = oldestTs < Infinity ? (newestTs - oldestTs) / 86400 : 0;

    return { raw, decayed, eventCount: totalEvents, dataSpanDays };
}

// ═══════════════════════════════════════════════════════════════
// Sub-Score: Settlement
// ═══════════════════════════════════════════════════════════════

interface JobRecord {
    hederaEscrowStatus?: "pending" | "executed" | "refunded";
    hederaBountyHbar?: string;
    reviewStatus?: "pending" | "approved" | "rejected";
}

/**
 * Compute settlement sub-score from job/bounty data.
 * Factors: escrow completion rate, volume bonus.
 */
function computeSettlementScore(
    jobs: JobRecord[],
    halfLifeDays: number,
): { raw: number; decayed: number; eventCount: number; dataSpanDays: number } {
    if (jobs.length === 0) {
        return { raw: 50, decayed: 50, eventCount: 0, dataSpanDays: 0 };
    }

    const jobsWithEscrow = jobs.filter(j => j.hederaEscrowStatus);
    if (jobsWithEscrow.length === 0) {
        return { raw: 50, decayed: 50, eventCount: jobs.length, dataSpanDays: 0 };
    }

    // Settlement rate: executed / total escrowed
    const executedCount = jobsWithEscrow.filter(j => j.hederaEscrowStatus === "executed").length;
    const settlementRate = executedCount / jobsWithEscrow.length;

    // Volume bonus: log scale of total HBAR settled
    let totalVolumeHbar = 0;
    for (const job of jobsWithEscrow) {
        if (job.hederaEscrowStatus === "executed" && job.hederaBountyHbar) {
            totalVolumeHbar += parseFloat(job.hederaBountyHbar) || 0;
        }
    }
    const volumeBonus = Math.min(20, Math.log10(totalVolumeHbar + 1) * 5);

    // Raw: settlement rate (70%) + volume bonus + base (10)
    const raw = Math.min(100, Math.max(0, settlementRate * 70 + volumeBonus + 10));

    // Settlement doesn't have per-event timestamps from HCS, use raw as decayed
    const decayed = raw;

    return { raw, decayed, eventCount: jobsWithEscrow.length, dataSpanDays: 0 };
}

// ═══════════════════════════════════════════════════════════════
// Sub-Score: Trust Network
// ═══════════════════════════════════════════════════════════════

interface TrustContext {
    endorsementCount: number;
    uniquePeersWorkedWith: number;
    verificationLevel: "unverified" | "basic" | "verified" | "certified";
    skillReportEvents: ScoreEvent[];
}

const VERIFICATION_BONUS: Record<string, number> = {
    unverified: 0,
    basic: 10,
    verified: 20,
    certified: 30,
};

/**
 * Compute trust network sub-score from endorsements, peers, and verification.
 */
function computeTrustNetworkScore(
    ctx: TrustContext,
    halfLifeDays: number,
): { raw: number; decayed: number; eventCount: number; dataSpanDays: number } {
    const endorsementScore = Math.min(40, ctx.endorsementCount * 8);
    const peerScore = Math.min(30, ctx.uniquePeersWorkedWith * 5);
    const verificationBonus = VERIFICATION_BONUS[ctx.verificationLevel] || 0;

    const raw = Math.min(100, Math.max(0, endorsementScore + peerScore + verificationBonus));

    // Apply decay to skill report events (proxy for network activity)
    let decayedActivity = 0;
    let totalActivity = 0;
    let oldestTs = Infinity;
    let newestTs = 0;

    for (const event of ctx.skillReportEvents) {
        const decay = decayFactor(eventAgeDays(event.timestamp), halfLifeDays);
        totalActivity += 1;
        decayedActivity += decay;
        oldestTs = Math.min(oldestTs, event.timestamp);
        newestTs = Math.max(newestTs, event.timestamp);
    }

    const activityDecayRatio = totalActivity > 0 ? decayedActivity / totalActivity : 1;
    const decayed = Math.min(100, Math.max(0, raw * activityDecayRatio));

    const eventCount = ctx.endorsementCount + ctx.uniquePeersWorkedWith + ctx.skillReportEvents.length;
    const dataSpanDays = oldestTs < Infinity ? (newestTs - oldestTs) / 86400 : 0;

    return { raw, decayed, eventCount, dataSpanDays };
}

// ═══════════════════════════════════════════════════════════════
// Sub-Score: Risk (inverted: 100 = lowest risk)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute risk sub-score (inverted: higher = safer).
 * Factors: penalty load, risk flags, fraud indicators.
 */
function computeRiskScore(
    events: ScoreEvent[],
    riskFlags: string[],
    halfLifeDays: number,
): { raw: number; decayed: number; eventCount: number; dataSpanDays: number } {
    const penaltyEvents = events.filter(e => e.type === "penalty");

    // Total credit lost from penalties
    let totalPenaltyCredit = 0;
    let decayedPenaltyLoad = 0;
    let oldestTs = Infinity;
    let newestTs = 0;

    for (const event of penaltyEvents) {
        const loss = Math.abs(event.creditDelta);
        totalPenaltyCredit += loss;

        const decay = decayFactor(eventAgeDays(event.timestamp), halfLifeDays);
        decayedPenaltyLoad += loss * decay;

        oldestTs = Math.min(oldestTs, event.timestamp);
        newestTs = Math.max(newestTs, event.timestamp);
    }

    // Raw: 100 - penalty load - flag penalty
    const penaltyLoad = Math.min(50, totalPenaltyCredit / 5);
    const flagPenalty = riskFlags.length * 10;
    const raw = Math.min(100, Math.max(0, 100 - penaltyLoad - flagPenalty));

    // Decayed: recent penalties weigh more
    const decayedLoad = Math.min(50, decayedPenaltyLoad / 5);
    const decayed = Math.min(100, Math.max(0, 100 - decayedLoad - flagPenalty));

    const dataSpanDays = oldestTs < Infinity ? (newestTs - oldestTs) / 86400 : 0;

    return { raw, decayed, eventCount: penaltyEvents.length + riskFlags.length, dataSpanDays };
}

// ═══════════════════════════════════════════════════════════════
// Composite Score
// ═══════════════════════════════════════════════════════════════

/**
 * Aggregate sub-scores into a composite credit score (300-900).
 */
function computeComposite(
    subScores: Record<SubScoreKind, SubScore>,
    model: ScoringModel,
): { compositeScore: number; overallConfidence: number } {
    let weightedSum = 0;
    let totalConfidenceWeight = 0;

    for (const kind of SUB_SCORE_KINDS) {
        const sub = subScores[kind];
        const weight = model.weights[kind];
        weightedSum += sub.decayed * weight * sub.confidence;
        totalConfidenceWeight += sub.confidence * weight;
    }

    // Normalize to 0-100 range
    const normalizedSum = totalConfidenceWeight > 0
        ? weightedSum / totalConfidenceWeight
        : 50; // Default to center if no confidence

    // Map 0-100 → 300-900
    const compositeScore = Math.round(
        Math.min(900, Math.max(300, 300 + (normalizedSum / 100) * 600)),
    );

    // Overall confidence is the confidence-weighted average
    const overallConfidence = totalConfidenceWeight > 0
        ? totalConfidenceWeight / SUB_SCORE_KINDS.reduce((sum, k) => sum + model.weights[k], 0)
        : 0;

    return { compositeScore, overallConfidence };
}

// ═══════════════════════════════════════════════════════════════
// Data Fetching
// ═══════════════════════════════════════════════════════════════

/** Fetch all HCS score events for an agent from the event buffer + any historical source */
async function fetchAgentEvents(asn: string): Promise<ScoreEvent[]> {
    // Start with buffered events
    const buffered = eventBuffer.get(asn) || [];

    // Also fetch historical events from the activityEvents collection
    // that have score-related metadata
    try {
        const snap = await adminDb()
            .collection("activityEvents")
            .where("metadata.asn", "==", asn)
            .orderBy("createdAt", "desc")
            .limit(500)
            .get();
        const historicalEvents: ScoreEvent[] = [];

        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            if (data.metadata?.scoreEvent) {
                historicalEvents.push(data.metadata.scoreEvent as ScoreEvent);
            }
        }

        // Merge and deduplicate by timestamp + type
        const all = [...historicalEvents, ...buffered];
        const seen = new Set<string>();
        return all.filter(e => {
            const key = `${e.asn}-${e.type}-${e.timestamp}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } catch {
        // If historical fetch fails, use buffered only
        return buffered;
    }
}

/** Fetch slashing events for an agent */
async function fetchSlashingEvents(asn: string): Promise<SlashingRecord[]> {
    try {
        const snap = await adminDb().collection("slashingEvents").where("asn", "==", asn).get();
        return snap.docs.map(d => d.data() as SlashingRecord);
    } catch {
        return [];
    }
}

/** Fetch jobs completed by an agent */
async function fetchAgentJobs(agentId: string): Promise<JobRecord[]> {
    try {
        const snap = await adminDb().collection("jobs").where("takenByAgentId", "==", agentId).get();
        return snap.docs.map(d => d.data() as JobRecord);
    } catch {
        return [];
    }
}

/** Build trust context from agent data and events */
async function buildTrustContext(
    agentId: string,
    events: ScoreEvent[],
): Promise<TrustContext> {
    // Get agent doc for verification level
    let verificationLevel: TrustContext["verificationLevel"] = "unverified";
    let endorsementCount = 0;

    try {
        const agentDoc = await adminDb().collection("agents").doc(agentId).get();
        if (agentDoc.exists) {
            const data = agentDoc.data()!;
            // Map on-chain registration to verification level
            if (data.asnOnChainRegistered && data.linkOnChainRegistered) {
                verificationLevel = "certified";
            } else if (data.onChainRegistered) {
                verificationLevel = "verified";
            } else if (data.asn) {
                verificationLevel = "basic";
            }
            // Endorsements from attestation refs count
            endorsementCount = (data.attestationRefs?.length) || 0;
        }
    } catch {
        // Use defaults
    }

    // Count unique peers from task events (via metadata)
    const peerSet = new Set<string>();
    for (const event of events) {
        if (event.metadata?.peerAgentId) {
            peerSet.add(event.metadata.peerAgentId as string);
        }
    }

    const skillReportEvents = events.filter(e => e.type === "skill_report");

    return {
        endorsementCount,
        uniquePeersWorkedWith: peerSet.size,
        verificationLevel,
        skillReportEvents,
    };
}

/** Get risk flags from agent's ASN profile */
async function fetchRiskFlags(agentId: string): Promise<string[]> {
    try {
        const agentDoc = await adminDb().collection("agents").doc(agentId).get();
        if (agentDoc.exists) {
            return (agentDoc.data()!.riskFlags as string[]) || [];
        }
    } catch {
        // Use defaults
    }
    return [];
}

// ═══════════════════════════════════════════════════════════════
// Model Management
// ═══════════════════════════════════════════════════════════════

/**
 * Get the active scoring model from Firestore, or return the default.
 */
export async function getActiveScoringModel(): Promise<ScoringModel> {
    try {
        const snap = await adminDb()
            .collection(SCORING_MODELS_COLLECTION)
            .where("active", "==", true)
            .limit(1)
            .get();
        if (!snap.empty) {
            return snap.docs[0].data() as ScoringModel;
        }
    } catch {
        // Fall through to default
    }
    return DEFAULT_MODEL;
}

/**
 * Save a new scoring model version to Firestore.
 */
export async function saveScoringModel(model: ScoringModel): Promise<void> {
    // Validate weights sum to ~1.0
    const weightSum = SUB_SCORE_KINDS.reduce((sum, k) => sum + model.weights[k], 0);
    if (Math.abs(weightSum - 1.0) > 0.01) {
        throw new Error(`Model weights must sum to 1.0 (got ${weightSum.toFixed(3)})`);
    }

    // Deactivate previous active models
    const snap = await adminDb().collection(SCORING_MODELS_COLLECTION).where("active", "==", true).get();
    for (const docSnap of snap.docs) {
        await adminDb().collection(SCORING_MODELS_COLLECTION).doc(docSnap.id).update({ active: false });
    }

    // Save new model
    await adminDb().collection(SCORING_MODELS_COLLECTION).doc(model.version).set({
        ...model,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
    });
}

// ═══════════════════════════════════════════════════════════════
// Core: Compute Agent Score
// ═══════════════════════════════════════════════════════════════

/**
 * Full score computation for an agent.
 * Fetches all relevant data, computes 5 sub-scores, aggregates into composite.
 *
 * @param agentId - Agent document ID
 * @param asn - Agent Social Number
 * @param extraEvents - Optional extra events to inject (for simulation)
 * @param modelOverride - Optional model override (for simulation)
 */
export async function computeAgentScore(
    agentId: string,
    asn: string,
    extraEvents?: ScoreEvent[],
    modelOverride?: ScoringModel,
): Promise<ScoreSnapshot> {
    const model = modelOverride || await getActiveScoringModel();

    // Fetch all data in parallel
    const [events, slashingRecords, jobs, trustCtx, riskFlags] = await Promise.all([
        fetchAgentEvents(asn),
        fetchSlashingEvents(asn),
        fetchAgentJobs(agentId),
        buildTrustContext(agentId, []), // Will augment with events below
        fetchRiskFlags(agentId),
    ]);

    // Merge extra events for simulation
    const allEvents = extraEvents ? [...events, ...extraEvents] : events;

    // Rebuild trust context with full event list
    const fullTrustCtx = await buildTrustContext(agentId, allEvents);

    // Compute each sub-score
    const executionResult = computeExecutionScore(allEvents, model.decayHalfLifeDays.execution);
    const reliabilityResult = computeReliabilityScore(allEvents, slashingRecords, model.decayHalfLifeDays.reliability);
    const settlementResult = computeSettlementScore(jobs, model.decayHalfLifeDays.settlement);
    const trustNetworkResult = computeTrustNetworkScore(fullTrustCtx, model.decayHalfLifeDays.trustNetwork);
    const riskResult = computeRiskScore(allEvents, riskFlags, model.decayHalfLifeDays.risk);

    // Build sub-score records with confidence
    const subScoreResults = {
        execution: executionResult,
        reliability: reliabilityResult,
        settlement: settlementResult,
        trustNetwork: trustNetworkResult,
        risk: riskResult,
    };

    const subScores: Record<SubScoreKind, SubScore> = {} as Record<SubScoreKind, SubScore>;

    for (const kind of SUB_SCORE_KINDS) {
        const result = subScoreResults[kind];
        const confidence = computeConfidence(
            result.eventCount,
            result.dataSpanDays,
            model.confidenceThresholds[kind],
            model.confidenceMinSpanDays,
        );

        const adjustedDecayed = confidenceAdjust(result.decayed, confidence);

        subScores[kind] = {
            kind,
            raw: Math.round(result.raw * 100) / 100,
            decayed: Math.round(adjustedDecayed * 100) / 100,
            confidence: Math.round(confidence * 1000) / 1000,
            weighted: Math.round(adjustedDecayed * model.weights[kind] * confidence * 100) / 100,
            eventCount: result.eventCount,
            dataSpanDays: Math.round(result.dataSpanDays * 10) / 10,
        };
    }

    // Composite
    const { compositeScore, overallConfidence } = computeComposite(subScores, model);

    // Trust score derived from trustNetwork sub-score (mapped to 0-100)
    const trustScore = Math.round(subScores.trustNetwork.decayed);

    // Get previous snapshot for delta
    let delta = 0;
    try {
        const prevSnap = await adminDb()
            .collection(SCORE_SNAPSHOTS_COLLECTION)
            .where("agentId", "==", agentId)
            .orderBy("computedAt", "desc")
            .limit(1)
            .get();
        if (!prevSnap.empty) {
            const prev = prevSnap.docs[0].data() as ScoreSnapshot;
            delta = compositeScore - prev.compositeScore;
        }
    } catch {
        // No previous snapshot
    }

    const band = getScoreBand(compositeScore).band;

    return {
        agentId,
        asn,
        compositeScore,
        trustScore,
        subScores,
        confidence: Math.round(overallConfidence * 1000) / 1000,
        band,
        modelVersion: model.version,
        delta,
        computedAt: null, // Will be set to serverTimestamp on persist
    };
}

// ═══════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════

/**
 * Persist a score snapshot to the scoreSnapshots collection.
 */
export async function persistScoreSnapshot(snapshot: ScoreSnapshot): Promise<string> {
    const ref = await adminDb().collection(SCORE_SNAPSHOTS_COLLECTION).add({
        ...snapshot,
        computedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

/**
 * Sync composite score to the agent document.
 * Updates creditScore, trustScore, and scoreBreakdown.
 */
export async function syncCompositeToAgent(snapshot: ScoreSnapshot): Promise<void> {
    try {
        const agentRef = adminDb().collection("agents").doc(snapshot.agentId);
        await agentRef.update({
            creditScore: snapshot.compositeScore,
            trustScore: snapshot.trustScore,
            lastCreditUpdate: FieldValue.serverTimestamp(),
            lastCreditReason: `Scoring engine ${snapshot.modelVersion} recompute`,
            scoreBreakdown: {
                execution: snapshot.subScores.execution.decayed,
                reliability: snapshot.subScores.reliability.decayed,
                settlement: snapshot.subScores.settlement.decayed,
                trustNetwork: snapshot.subScores.trustNetwork.decayed,
                risk: snapshot.subScores.risk.decayed,
                confidence: snapshot.confidence,
                modelVersion: snapshot.modelVersion,
            } satisfies ScoreBreakdown,
        });
    } catch (error) {
        console.error("Failed to sync composite score to agent:", error);
    }
}

/**
 * Get score history for an agent.
 */
export async function getScoreHistory(
    agentId: string,
    max: number = 50,
): Promise<ScoreSnapshot[]> {
    const snap = await adminDb()
        .collection(SCORE_SNAPSHOTS_COLLECTION)
        .where("agentId", "==", agentId)
        .orderBy("computedAt", "desc")
        .limit(max)
        .get();
    return snap.docs.map(d => ({ ...d.data() } as ScoreSnapshot));
}

// ═══════════════════════════════════════════════════════════════
// Simulation Sandbox
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate score changes from hypothetical events without persisting.
 */
export async function simulateScoreChange(
    agentId: string,
    asn: string,
    hypotheticalEvents: ScoreEvent[],
    modelVersion?: string,
): Promise<SimulationResult> {
    // Get optional model override
    let modelOverride: ScoringModel | undefined;
    if (modelVersion) {
        try {
            const modelDoc = await adminDb().collection(SCORING_MODELS_COLLECTION).doc(modelVersion).get();
            if (modelDoc.exists) {
                modelOverride = modelDoc.data() as ScoringModel;
            }
        } catch {
            // Use active model
        }
    }

    // Compute current score (before)
    const before = await computeAgentScore(agentId, asn, undefined, modelOverride);

    // Compute score with hypothetical events (after)
    const after = await computeAgentScore(agentId, asn, hypotheticalEvents, modelOverride);

    // Compute deltas per sub-score
    const subScoreDeltas: Record<SubScoreKind, number> = {} as Record<SubScoreKind, number>;
    for (const kind of SUB_SCORE_KINDS) {
        subScoreDeltas[kind] = Math.round(
            (after.subScores[kind].decayed - before.subScores[kind].decayed) * 100,
        ) / 100;
    }

    return {
        before,
        after,
        delta: after.compositeScore - before.compositeScore,
        subScoreDeltas,
    };
}
