/**
 * Credit Policy Settings — Admin SDK reader/writer (server-only).
 *
 * Server counterpart of credit-policy-settings.ts. That module uses the
 * client SDK so claimJob can run in the browser, but on the server the client
 * SDK has no signed-in user and platformConfig / orgPolicies / creditPolicyLog
 * are denied by firestore.rules — reads quietly fell back to defaults, so
 * platform-admin policy changes and per-org overrides never took effect for
 * server-side enforcement. Same documents, same defaults, same cache TTL.
 *
 * Server-only — never import from client-facing code.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { getAgent } from "./firestore-admin";
import type { OrgPolicyOverride } from "./credit-policy";
import type { PolicyLoaders } from "./agent-policy";
import {
    CREDIT_POLICY_DEFAULTS,
    type CreditPolicyConfig,
    type PolicyEnforcementEvent,
} from "./credit-policy-settings";

const CACHE_TTL_MS = 60_000;

let configCache: { data: CreditPolicyConfig; expiresAt: number } | null = null;
const orgCache = new Map<string, { data: OrgPolicyOverride | null; expiresAt: number }>();

export async function getCreditPolicyConfig(): Promise<CreditPolicyConfig> {
    if (configCache && Date.now() < configCache.expiresAt) {
        return configCache.data;
    }
    const snap = await adminDb().collection("platformConfig").doc("creditPolicy").get();
    const config = { ...CREDIT_POLICY_DEFAULTS, ...(snap.data() ?? {}) } as CreditPolicyConfig;
    configCache = { data: config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
}

export async function setCreditPolicyConfig(
    update: Partial<CreditPolicyConfig>,
    updatedBy?: string,
): Promise<void> {
    const ref = adminDb().collection("platformConfig").doc("creditPolicy");
    const payload = {
        ...update,
        updatedAt: FieldValue.serverTimestamp(),
        ...(updatedBy ? { updatedBy } : {}),
    };
    const snap = await ref.get();
    if (snap.exists) {
        await ref.update(payload);
    } else {
        await ref.set({ ...CREDIT_POLICY_DEFAULTS, ...payload });
    }
    configCache = null;
}

export async function getOrgPolicyOverride(orgId: string): Promise<OrgPolicyOverride | null> {
    const cached = orgCache.get(orgId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }
    const snap = await adminDb().collection("orgPolicies").doc(orgId).get();
    const data = snap.exists ? ({ orgId, ...snap.data() } as OrgPolicyOverride) : null;
    orgCache.set(orgId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
}

export async function setOrgPolicyOverride(
    orgId: string,
    override: Partial<OrgPolicyOverride>,
    updatedBy?: string,
): Promise<void> {
    await adminDb().collection("orgPolicies").doc(orgId).set(
        {
            ...override,
            orgId,
            updatedAt: FieldValue.serverTimestamp(),
            ...(updatedBy ? { updatedBy } : {}),
        },
        { merge: true },
    );
    orgCache.delete(orgId);
}

/** Record a policy enforcement event to the audit log. Never throws. */
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

/** Admin SDK inputs for resolveAgentPolicy(agentId, adminPolicyLoaders). */
export const adminPolicyLoaders: PolicyLoaders = {
    getAgent,
    getCreditPolicyConfig,
    getOrgPolicyOverride,
};
