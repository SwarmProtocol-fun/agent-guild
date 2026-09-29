/**
 * Credit Tier Definitions & Helpers
 *
 * Shared config for tier thresholds, descriptions, restrictions, and colors.
 * Used by the credit explainer engine, API routes, and all credit UI surfaces.
 *
 * Tier thresholds align with the existing reputation page logic.
 * Designed to be extended by PRD 4 (Policy Tiers) when implemented.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type TierName = "Bronze" | "Silver" | "Gold" | "Platinum";

export interface TierDefinition {
    /** Tier name */
    name: TierName;
    /** Minimum credit score for this tier (inclusive) */
    minCredit: number;
    /** Tailwind color classes for the tier badge */
    badgeClass: string;
    /** Hex color for charts */
    chartColor: string;
    /** Short description of what this tier means */
    description: string;
    /** Restrictions active at this tier level */
    restrictions: string[];
    /** Benefits unlocked at this tier level */
    benefits: string[];
}

export type ConfidenceLevel = "low" | "medium" | "high";

export interface ConfidenceInfo {
    level: ConfidenceLevel;
    eventCount: number;
    description: string;
}

// ═══════════════════════════════════════════════════════════════
// Tier Definitions (ordered highest → lowest for lookup)
// ═══════════════════════════════════════════════════════════════

export const CREDIT_TIERS: TierDefinition[] = [
    {
        name: "Platinum",
        minCredit: 850,
        badgeClass: "bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-700",
        chartColor: "#8b5cf6",
        description: "Elite reliability. This agent has an exceptional track record with consistently high performance.",
        restrictions: [],
        benefits: [
            "Priority task assignment",
            "Maximum escrow limits",
            "Featured in marketplace",
            "Reduced review requirements",
        ],
    },
    {
        name: "Gold",
        minCredit: 700,
        badgeClass: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-700",
        chartColor: "#f59e0b",
        description: "Proven performer. This agent has a strong track record with reliable task completion.",
        restrictions: [],
        benefits: [
            "Higher escrow limits",
            "Eligible for complex tasks",
            "Marketplace visibility boost",
        ],
    },
    {
        name: "Silver",
        minCredit: 550,
        badgeClass: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600",
        chartColor: "#94a3b8",
        description: "Developing reputation. This agent is building a track record with moderate activity.",
        restrictions: [
            "Standard escrow limits apply",
        ],
        benefits: [
            "Standard task access",
            "Marketplace listing eligible",
        ],
    },
    {
        name: "Bronze",
        minCredit: 300,
        badgeClass: "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-700",
        chartColor: "#ea580c",
        description: "New or recovering. This agent has limited history or recent issues affecting their score.",
        restrictions: [
            "Lower escrow limits",
            "May require manual review for tasks",
            "Limited marketplace visibility",
        ],
        benefits: [
            "Basic task access",
        ],
    },
];

// ═══════════════════════════════════════════════════════════════
// Score Constants
// ═══════════════════════════════════════════════════════════════

export const CREDIT_SCORE_MIN = 300;
export const CREDIT_SCORE_MAX = 900;
export const CREDIT_SCORE_DEFAULT = 680;
export const TRUST_SCORE_MIN = 0;
export const TRUST_SCORE_MAX = 100;
export const TRUST_SCORE_DEFAULT = 50;

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Get the tier definition for a given credit score. */
export function getTierForScore(creditScore: number): TierDefinition {
    // Tiers are ordered highest-first, so the first match is the correct tier
    for (const tier of CREDIT_TIERS) {
        if (creditScore >= tier.minCredit) {
            return tier;
        }
    }
    // Fallback (should never happen since Bronze starts at 300)
    return CREDIT_TIERS[CREDIT_TIERS.length - 1];
}

/** Get confidence level based on the number of score events. */
export function getConfidenceLevel(eventCount: number): ConfidenceLevel {
    if (eventCount >= 50) return "high";
    if (eventCount >= 10) return "medium";
    return "low";
}

/** Get full confidence info with description. */
export function getConfidenceInfo(eventCount: number): ConfidenceInfo {
    const level = getConfidenceLevel(eventCount);
    const descriptions: Record<ConfidenceLevel, string> = {
        low: "Limited data — fewer than 10 score events recorded",
        medium: "Moderate confidence — 10-49 score events recorded",
        high: "High confidence — 50+ score events recorded",
    };
    return { level, eventCount, description: descriptions[level] };
}

/** Get the next tier above the current score (or null if already Platinum). */
export function getNextTier(creditScore: number): TierDefinition | null {
    const current = getTierForScore(creditScore);
    const idx = CREDIT_TIERS.indexOf(current);
    return idx > 0 ? CREDIT_TIERS[idx - 1] : null;
}

/** Get points needed to reach the next tier (or 0 if Platinum). */
export function pointsToNextTier(creditScore: number): number {
    const next = getNextTier(creditScore);
    if (!next) return 0;
    return next.minCredit - creditScore;
}

/** Format a credit score delta with sign. */
export function formatDelta(delta: number): string {
    return delta > 0 ? `+${delta}` : `${delta}`;
}

/** Readable label for a score event type. */
export function eventTypeLabel(type: string): string {
    const labels: Record<string, string> = {
        task_complete: "Task Completed",
        task_fail: "Task Failed",
        skill_report: "Skill Report",
        penalty: "Penalty",
        bonus: "Bonus",
        checkpoint: "Checkpoint",
    };
    return labels[type] || type.replace(/_/g, " ");
}
