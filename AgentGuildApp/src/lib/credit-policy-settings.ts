/**
 * Credit Policy Settings — Firestore reader/writer
 *
 * Reads `platformConfig/creditPolicy` and `orgPolicies/{orgId}` from Firestore.
 * Follows the same cache + defaults pattern as marketplace-settings.ts.
 *
 * NOTE: client SDK only — src/lib/firestore.ts::claimJob dynamically imports
 * this module and claimJob runs in the browser, so firebase-admin can't be
 * bundled here. Server code must use credit-policy-settings-admin.ts instead:
 * platformConfig, orgPolicies and creditPolicyLog all fall under the
 * firestore.rules deny-all catch-all, so from the server (no signed-in user)
 * these reads silently return the defaults and writes fail.
 */

import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";
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

export const CREDIT_POLICY_DEFAULTS: CreditPolicyConfig = {
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
        const snap = await getDoc(doc(db, "platformConfig", "creditPolicy"));
        const data = snap.exists() ? snap.data() : {};
        const config = { ...CREDIT_POLICY_DEFAULTS, ...data } as CreditPolicyConfig;
        configCache = { data: config, expiresAt: Date.now() + CACHE_TTL_MS };
        return config;
    } catch {
        return CREDIT_POLICY_DEFAULTS;
    }
}

/** Write/update platform-wide credit policy config. */
export async function setCreditPolicyConfig(
    update: Partial<CreditPolicyConfig>,
    updatedBy?: string,
): Promise<void> {
    const ref = doc(db, "platformConfig", "creditPolicy");
    const snap = await getDoc(ref);

    const payload = {
        ...update,
        updatedAt: serverTimestamp(),
        ...(updatedBy ? { updatedBy } : {}),
    };

    if (snap.exists()) {
        await updateDoc(ref, payload);
    } else {
        await setDoc(ref, { ...CREDIT_POLICY_DEFAULTS, ...payload });
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
        const snap = await getDoc(doc(db, "orgPolicies", orgId));
        if (!snap.exists()) {
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
    const ref = doc(db, "orgPolicies", orgId);

    await setDoc(
        ref,
        {
            ...override,
            orgId,
            updatedAt: serverTimestamp(),
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
        const { addDoc, collection } = await import("firebase/firestore");
        await addDoc(collection(db, "creditPolicyLog"), {
            ...event,
            timestamp: serverTimestamp(),
        });
    } catch (err) {
        console.error("Failed to record policy event:", err);
    }
}
