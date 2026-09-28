/**
 * Credit Policy Settings — Firestore reader/writer
 *
 * Reads `platformConfig/creditPolicy` and `orgPolicies/{orgId}` from Firestore.
 * Follows the same cache + defaults pattern as marketplace-settings.ts.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type { PolicyTierName, OrgPolicyOverride } from "./credit-policy";

// ═══════════════════════════════════════════════════════════════
// Platform-Wide Config
// ═══════════════════════════════════════════════════════════════

export interface CreditPolicyConfig {
    /** Master kill switch — disables all enforcement when false */
    enforcementEnabled: boolean;

    // Per-feature enforcement toggles
    enforceJobClaims: boolean;
    enforceEscrow: boolean;
    enforceFeeMultipliers: boolean;
    enforceMarketplaceVisibility: boolean;
    enforceConcurrentLimits: boolean;

    /** Grace period for new agents (score starts at 680) */
    newAgentGracePeriodDays: number;
    /** Default tier assigned during grace period */
    newAgentDefaultTier: PolicyTierName;

    updatedAt?: unknown;
    updatedBy?: string;
}

const CONFIG_DEFAULTS: CreditPolicyConfig = {
    enforcementEnabled: false,
    enforceJobClaims: true,
    enforceEscrow: true,
    enforceFeeMultipliers: true,
    enforceMarketplaceVisibility: true,
    enforceConcurrentLimits: true,
    newAgentGracePeriodDays: 30,
    newAgentDefaultTier: "standard",
};

// ═══════════════════════════════════════════════════════════════
// Cache (60-second TTL, matching marketplace-settings.ts)
// ═══════════════════════════════════════════════════════════════

let configCache: { data: CreditPolicyConfig; expiresAt: number } | null = null;
const orgCache = new Map<string, { data: OrgPolicyOverride | null; expiresAt: number }>();

const CACHE_TTL_MS = 60_000;

// ═══════════════════════════════════════════════════════════════
// Platform Config Reader/Writer
// ═══════════════════════════════════════════════════════════════

/** Read platform-wide credit policy config with 60-second cache. */
export async function getCreditPolicyConfig(): Promise<CreditPolicyConfig> {
    if (configCache && Date.now() < configCache.expiresAt) {
        return configCache.data;
    }

    try {
        const snap = await adminDb().collection("platformConfig").doc("creditPolicy").get();
        const data = snap.exists ? snap.data() : {};
        const config = { ...CONFIG_DEFAULTS, ...data } as CreditPolicyConfig;
        configCache = { data: config, expiresAt: Date.now() + CACHE_TTL_MS };
        return config;
    } catch {
        return CONFIG_DEFAULTS;
    }
}

/** Write/update platform-wide credit policy config. */
export async function setCreditPolicyConfig(
    update: Partial<CreditPolicyConfig>,
    updatedBy?: string,
): Promise<void> {
    const ref = adminDb().collection("platformConfig").doc("creditPolicy");
    const snap = await ref.get();

    const payload = {
        ...update,
        updatedAt: FieldValue.serverTimestamp(),
        ...(updatedBy ? { updatedBy } : {}),
    };

    if (snap.exists) {
        await ref.update(payload);
    } else {
        await ref.set({ ...CONFIG_DEFAULTS, ...payload });
    }

    // Bust cache
    configCache = null;
}

// ═══════════════════════════════════════════════════════════════
// Org Policy Override Reader/Writer
// ═══════════════════════════════════════════════════════════════

/** Read per-org policy override with 60-second cache. Returns null if none set. */
export async function getOrgPolicyOverride(orgId: string): Promise<OrgPolicyOverride | null> {
    const cached = orgCache.get(orgId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    try {
        const snap = await adminDb().collection("orgPolicies").doc(orgId).get();
        if (!snap.exists) {
            orgCache.set(orgId, { data: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }

        const data = { orgId, ...snap.data() } as OrgPolicyOverride;
        orgCache.set(orgId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        return data;
    } catch {
        return null;
    }
}

/** Write/update per-org policy override. */
export async function setOrgPolicyOverride(
    orgId: string,
    override: Partial<OrgPolicyOverride>,
    updatedBy?: string,
): Promise<void> {
    const ref = adminDb().collection("orgPolicies").doc(orgId);

    await ref.set(
        {
            ...override,
            orgId,
            updatedAt: FieldValue.serverTimestamp(),
            ...(updatedBy ? { updatedBy } : {}),
        },
        { merge: true },
    );

    // Bust cache for this org
    orgCache.delete(orgId);
}

// ═══════════════════════════════════════════════════════════════
// Policy Enforcement Audit Log
// ═══════════════════════════════════════════════════════════════

export type PolicyAction =
    | "job_claim_blocked"
    | "job_claim_allowed"
    | "escrow_enforced"
    | "fee_multiplier_applied"
    | "marketplace_visibility_set"
    | "concurrent_limit_enforced"
    | "manual_review_required"
    | "tier_resolved"
    | "org_override_applied";

export interface PolicyEnforcementEvent {
    agentId: string;
    asn?: string;
    orgId: string;
    action: PolicyAction;
    tier: PolicyTierName;
    details: Record<string, unknown>;
    timestamp: unknown;
}

/** Record a policy enforcement event to the audit log. */
export async function recordPolicyEvent(
    event: Omit<PolicyEnforcementEvent, "timestamp">,
): Promise<void> {
    try {
        await adminDb().collection("creditPolicyLog").add({
            ...event,
            timestamp: FieldValue.serverTimestamp(),
        });
    } catch (err) {
        console.error("Failed to record policy event:", err);
    }
}
