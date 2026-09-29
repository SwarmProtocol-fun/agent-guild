/**
 * Credit Webhook System
 *
 * Manages webhook registrations for credit events.
 * Dispatches HMAC-SHA256 signed payloads on score/band/policy changes.
 *
 * Firestore collection: "creditWebhooks"
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CreditWebhook {
    id: string;
    agentId: string;
    url: string;
    events: string[];
    secret: string;
    registeredBy: string;
    active: boolean;
    createdAt: unknown;
}

export type CreditWebhookEvent = "score_change" | "band_change" | "policy_change";

export interface WebhookPayload {
    webhookId: string;
    agentId: string;
    event: string;
    data: Record<string, unknown>;
    timestamp: string;
    signature: string;
}

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

/** Register a new credit webhook. Returns the document ID. */
export async function registerWebhook(
    webhook: Omit<CreditWebhook, "id" | "createdAt">,
): Promise<string> {
    const ref = await adminDb().collection("creditWebhooks").add({
        ...webhook,
        createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
}

/** List active webhooks for an agent. */
export async function listWebhooks(agentId: string): Promise<CreditWebhook[]> {
    const snap = await adminDb().collection("creditWebhooks")
        .where("agentId", "==", agentId)
        .where("active", "==", true)
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as CreditWebhook));
}

/** Delete (hard-delete) a webhook. */
export async function deleteWebhook(webhookId: string): Promise<void> {
    await adminDb().collection("creditWebhooks").doc(webhookId).delete();
}

/** Count active webhooks for an agent (for max limit enforcement). */
export async function countWebhooks(agentId: string): Promise<number> {
    const webhooks = await listWebhooks(agentId);
    return webhooks.length;
}

// ═══════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════

/**
 * Fire webhooks for a credit event. Non-blocking fire-and-forget.
 * Errors are logged but don't propagate.
 */
export async function fireWebhooks(
    agentId: string,
    event: string,
    data: Record<string, unknown>,
): Promise<void> {
    let webhooks: CreditWebhook[];

    try {
        webhooks = await listWebhooks(agentId);
    } catch (error) {
        console.error("[credit-webhooks] Failed to list webhooks:", error);
        return;
    }

    for (const wh of webhooks) {
        if (!wh.events.includes(event)) continue;

        const payloadData = {
            webhookId: wh.id,
            agentId,
            event,
            data,
            timestamp: new Date().toISOString(),
        };

        // Compute HMAC-SHA256 signature
        const hmac = crypto.createHmac("sha256", wh.secret);
        hmac.update(JSON.stringify(payloadData));
        const signature = hmac.digest("hex");

        const payload: WebhookPayload = {
            ...payloadData,
            signature,
        };

        // Fire-and-forget with 10s timeout
        fetch(wh.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Webhook-Signature": signature,
                "X-Webhook-Event": event,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        }).catch(err => {
            console.error(`[credit-webhooks] Delivery failed for ${wh.id} -> ${wh.url}:`, err);
        });
    }
}

/** Generate a cryptographically random webhook secret. */
export function generateWebhookSecret(): string {
    return crypto.randomBytes(32).toString("hex");
}
