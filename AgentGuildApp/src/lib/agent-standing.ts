/**
 * Agent standing — the anti-sybil rules that make a fresh ASN worth less
 * than an established one, so abandoning a damaged identity and
 * re-registering under a new name never pays.
 *
 *   1. Provisional period: every new identity starts provisional and is
 *      capped at the Restricted policy tier (low spending cap, high escrow)
 *      until it has tenure, completed work, a clean risk record, and a
 *      posted bond. It is computed from the agent doc on every policy
 *      resolution — nothing has to "graduate" an agent, and a slashed bond
 *      or a new risk flag drops it straight back to provisional.
 *   2. Owner quotas: every key-bound agent is charged to its org owner's
 *      wallet. Owners who passed proof-of-human get a larger quota.
 *
 * Pure functions only (no Firestore I/O) — imported by agent-policy.ts,
 * which also runs in the browser bundle.
 */

import type { PolicyTierName } from "./credit-policy";

export const PROVISIONAL_MIN_DAYS = 14;
export const PROVISIONAL_MIN_TASKS = 3;
/** Policy tier ceiling while provisional. */
export const PROVISIONAL_TIER_CAP: PolicyTierName = "restricted";

const DEFAULT_BOND_USD = 25;

/**
 * Refundable USDC bond required per ASN before it can leave provisional.
 * NEXT_PUBLIC_ so the browser-side policy resolution agrees with the server.
 * 0 disables the bond requirement.
 */
export function agentBondUsd(): number {
    const raw = process.env.NEXT_PUBLIC_AGENT_BOND_USD;
    if (raw === undefined || raw.trim() === "") return DEFAULT_BOND_USD;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BOND_USD;
}

export type BondStatus = "posted" | "slashed" | "refund_pending" | "refunded";

export interface AgentBond {
    status: BondStatus;
    amountUsd: number;
    /** Wallet that sent the bond — refunds go back here. */
    postedByWallet: string;
    txSig: string;
    postedAt: number;
    slashedAt?: number;
    slashReason?: string;
    refundRequestedAt?: number;
    refundPayoutId?: string;
}

/** Firestore Timestamp | Date | epoch ms | epoch seconds → epoch ms. */
export function toMillis(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "object") {
        const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
        if (typeof o.toMillis === "function") return o.toMillis();
        if (typeof o.seconds === "number") return o.seconds * 1000;
        if (typeof o._seconds === "number") return o._seconds * 1000;
    }
    return null;
}

/** The agent-doc fields standing reads. Everything optional — legacy docs lack them. */
export interface StandingInput {
    provisional?: boolean;
    provisionalSince?: unknown;
    createdAt?: unknown;
    tasksCompleted?: number;
    riskFlags?: string[];
    bond?: AgentBond | null;
}

export interface StandingRequirement {
    key: "tenure" | "tasks" | "risk" | "bond";
    label: string;
    met: boolean;
}

export interface AgentStanding {
    /** True while the provisional tier cap applies. */
    provisional: boolean;
    /** Agents created before this system existed are never provisional. */
    grandfathered: boolean;
    requirements: StandingRequirement[];
}

export function evaluateStanding(agent: StandingInput, nowMs: number = Date.now()): AgentStanding {
    if (agent.provisional !== true) {
        return { provisional: false, grandfathered: true, requirements: [] };
    }

    const since = toMillis(agent.provisionalSince) ?? toMillis(agent.createdAt) ?? nowMs;
    const ageDays = (nowMs - since) / 86_400_000;
    const tasks = agent.tasksCompleted ?? 0;
    const flags = agent.riskFlags ?? [];
    const bondUsd = agentBondUsd();

    const requirements: StandingRequirement[] = [
        {
            key: "tenure",
            label: `${PROVISIONAL_MIN_DAYS} days since registration (${Math.floor(Math.max(0, ageDays))} so far)`,
            met: ageDays >= PROVISIONAL_MIN_DAYS,
        },
        {
            key: "tasks",
            label: `${PROVISIONAL_MIN_TASKS} completed tasks (${tasks} so far)`,
            met: tasks >= PROVISIONAL_MIN_TASKS,
        },
        {
            key: "risk",
            label: flags.length === 0 ? "No open risk flags" : `Open risk flags: ${flags.join(", ")}`,
            met: flags.length === 0,
        },
    ];
    if (bondUsd > 0) {
        requirements.push({
            key: "bond",
            label: agent.bond?.status === "slashed"
                ? `Bond slashed${agent.bond.slashReason ? ` (${agent.bond.slashReason})` : ""} — post a new $${bondUsd} bond`
                : `$${bondUsd} USDC bond posted`,
            met: agent.bond?.status === "posted" && agent.bond.amountUsd >= bondUsd,
        });
    }

    return {
        provisional: requirements.some((r) => !r.met),
        grandfathered: false,
        requirements,
    };
}

// ═══════════════════════════════════════════════════════════════
// Owner quotas
// ═══════════════════════════════════════════════════════════════

export interface OwnerQuota {
    maxActiveAgents: number;
    maxNewPerDay: number;
}

export function ownerAgentQuota(humanVerified: boolean): OwnerQuota {
    return humanVerified
        ? { maxActiveAgents: 25, maxNewPerDay: 10 }
        : { maxActiveAgents: 3, maxNewPerDay: 2 };
}

export interface OwnedAgent {
    /** Set when the ASN is retired (bond refund) — no longer counts toward the quota. */
    retiredAt?: unknown;
    keyBoundAt?: unknown;
}

/** Can this owner bind a key to one more agent identity? */
export function checkOwnerQuota(
    owned: OwnedAgent[],
    humanVerified: boolean,
    nowMs: number = Date.now(),
): { ok: true } | { ok: false; reason: string; code: "OWNER_AGENT_LIMIT" | "OWNER_DAILY_LIMIT" } {
    const quota = ownerAgentQuota(humanVerified);
    const verifyHint = humanVerified ? "" : " Verify as human (Settings → Proof of Human) to raise the limit.";

    const active = owned.filter((a) => a.retiredAt == null).length;
    if (active >= quota.maxActiveAgents) {
        return {
            ok: false,
            code: "OWNER_AGENT_LIMIT",
            reason: `This org owner already has ${active} active agents (limit ${quota.maxActiveAgents}). Retire one first.${verifyHint}`,
        };
    }

    const dayAgo = nowMs - 86_400_000;
    const recent = owned.filter((a) => (toMillis(a.keyBoundAt) ?? 0) >= dayAgo).length;
    if (recent >= quota.maxNewPerDay) {
        return {
            ok: false,
            code: "OWNER_DAILY_LIMIT",
            reason: `This org owner registered ${recent} agents in the last 24h (limit ${quota.maxNewPerDay}).${verifyHint}`,
        };
    }
    return { ok: true };
}
