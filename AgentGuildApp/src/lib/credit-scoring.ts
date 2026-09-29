/**
 * Credit Scoring — Platform-level scoring types, bands, and policy helpers.
 *
 * Extracted from chainlink.ts so the credit system is chain-agnostic.
 * Used by: credit-policy.ts, credit-service.ts, credit-enforcement.ts,
 *          scoring-engine.ts, agents pages, registration routes.
 */

// ═══════════════════════════════════════════════════════════════
// Score Bands
// ═══════════════════════════════════════════════════════════════

export type ScoreBand = "elite" | "strong" | "acceptable" | "risky" | "restricted";

export interface ScoreBandInfo {
    band: ScoreBand;
    label: string;
    range: string;
    min: number;
    max: number;
    color: string;
    bgColor: string;
    borderColor: string;
}

export const ASN_SCORE_BANDS: ScoreBandInfo[] = [
    { band: "elite",      label: "Elite",      range: "850–900", min: 850, max: 900, color: "text-emerald-400", bgColor: "bg-emerald-500/10", borderColor: "border-emerald-500/20" },
    { band: "strong",     label: "Strong",     range: "750–849", min: 750, max: 849, color: "text-blue-400",    bgColor: "bg-blue-500/10",    borderColor: "border-blue-500/20" },
    { band: "acceptable", label: "Acceptable", range: "650–749", min: 650, max: 749, color: "text-amber-400",   bgColor: "bg-amber-500/10",   borderColor: "border-amber-500/20" },
    { band: "risky",      label: "Risky",      range: "550–649", min: 550, max: 649, color: "text-orange-400",  bgColor: "bg-orange-500/10",  borderColor: "border-orange-500/20" },
    { band: "restricted", label: "Restricted", range: "< 550",   min: 300, max: 549, color: "text-red-400",     bgColor: "bg-red-500/10",     borderColor: "border-red-500/20" },
];

export function getScoreBand(score: number): ScoreBandInfo {
    for (const band of ASN_SCORE_BANDS) {
        if (score >= band.min && score <= band.max) return band;
    }
    return ASN_SCORE_BANDS[ASN_SCORE_BANDS.length - 1];
}

// ═══════════════════════════════════════════════════════════════
// Policy State
// ═══════════════════════════════════════════════════════════════

export interface PolicyState {
    spendingCapUsd: number;
    requiresManualReview: boolean;
    escrowRatio: number;
    maxConcurrentTasks: number;
    sensitiveWorkflowAccess: boolean;
}

export function getDefaultPolicy(score: number): PolicyState {
    if (score >= 850) return { spendingCapUsd: 50000, requiresManualReview: false, escrowRatio: 0.10, maxConcurrentTasks: 20, sensitiveWorkflowAccess: true };
    if (score >= 750) return { spendingCapUsd: 10000, requiresManualReview: false, escrowRatio: 0.25, maxConcurrentTasks: 10, sensitiveWorkflowAccess: true };
    if (score >= 650) return { spendingCapUsd: 5000,  requiresManualReview: false, escrowRatio: 0.50, maxConcurrentTasks: 5,  sensitiveWorkflowAccess: false };
    if (score >= 550) return { spendingCapUsd: 1000,  requiresManualReview: true,  escrowRatio: 0.75, maxConcurrentTasks: 2,  sensitiveWorkflowAccess: false };
    return { spendingCapUsd: 100, requiresManualReview: true, escrowRatio: 1.0, maxConcurrentTasks: 1, sensitiveWorkflowAccess: false };
}

// ═══════════════════════════════════════════════════════════════
// ASN Generator
// ═══════════════════════════════════════════════════════════════

export function generateASN(): string {
    const year = new Date().getFullYear();
    const hex = () => Math.random().toString(16).substring(2, 6).toUpperCase();
    const check = Math.random().toString(36).substring(2, 4).toUpperCase();
    return `ASN-SWM-${year}-${hex()}-${hex()}-${check}`;
}
