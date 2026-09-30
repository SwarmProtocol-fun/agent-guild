/**
 * Ed25519 signature verification for the /v1/ API.
 *
 * Every request to /v1/messages and /v1/send must include a signature.
 * The hub looks up the agent's registered public key and verifies.
 *
 * Includes nonce tracking to prevent replay attacks within the
 * 2-minute timestamp freshness window.
 */
import crypto from "crypto";
import { adminDb } from "@/lib/firebase-admin";
import { getRedis } from "@/lib/redis";

/** Thrown by firebase-admin.ts when Admin SDK env vars are missing — distinct from an auth failure. */
const ADMIN_NOT_CONFIGURED_MARKER = "Firebase Admin SDK not configured";

export function isAdminConfigError(err: unknown): boolean {
    return err instanceof Error && err.message.includes(ADMIN_NOT_CONFIGURED_MARKER);
}

// ── Nonce tracking (Redis, shared across instances; in-memory fallback) ─
// Nonces are signature hashes — if the same signature is seen twice within
// the freshness window, the request is rejected. This only works as replay
// protection (rather than a false-positive trap) when the signed message
// itself varies from call to call — callers that sign a value which can
// legitimately repeat (like a poll cursor that doesn't advance on an empty
// poll) must fold in a fresh per-request nonce/timestamp so the signature,
// and therefore this cache key, is never identical across two honest calls.
// A single in-memory Map previously meant two server instances could
// disagree about what had been seen; Redis makes the record shared.

const NONCE_TTL_MS = 3 * 60 * 1000; // 3 minutes (slightly > 2-min freshness window)
const NONCE_TTL_SEC = Math.ceil(NONCE_TTL_MS / 1000);
const NONCE_KEY_PREFIX = "nonce:sig:";
const nonceCache = new Map<string, number>(); // nonce → expiry timestamp (fallback only)

// Periodic cleanup (every ~100 calls) — fallback map only
let nonceCleanupCounter = 0;
function cleanupNonces() {
    const now = Date.now();
    for (const [nonce, expiry] of nonceCache) {
        if (now >= expiry) nonceCache.delete(nonce);
    }
}

function fallbackCheckAndRecordNonce(nonce: string): boolean {
    if (++nonceCleanupCounter % 100 === 0) cleanupNonces();

    const now = Date.now();
    if (nonceCache.has(nonce)) {
        const expiry = nonceCache.get(nonce)!;
        if (now < expiry) return false; // replay detected
    }

    nonceCache.set(nonce, now + NONCE_TTL_MS);
    return true;
}

/**
 * Check if a nonce (signature hash) has been seen before.
 * Returns true if the nonce is fresh (not seen), false if replayed.
 */
export async function checkAndRecordNonce(signatureBase64: string): Promise<boolean> {
    const nonce = crypto.createHash("sha256").update(signatureBase64).digest("hex").slice(0, 32);

    const redis = getRedis();
    if (redis) {
        try {
            // SET NX EX — atomic "set only if absent". "OK" means this nonce was
            // fresh; null means some instance already recorded it (replay).
            const result = await redis.set(`${NONCE_KEY_PREFIX}${nonce}`, "1", {
                nx: true,
                ex: NONCE_TTL_SEC,
            });
            return result !== null;
        } catch (err) {
            console.warn("[verify] Redis nonce check failed, falling back to in-memory:", err);
        }
    }

    return fallbackCheckAndRecordNonce(nonce);
}

// ── Signature verification ──────────────────────────────

/**
 * Verify an Ed25519 signature against a known public key (PEM format).
 */
export function verifySignature(
    publicKeyPem: string,
    message: string,
    signatureBase64: string
): boolean {
    try {
        const publicKey = crypto.createPublicKey({
            key: publicKeyPem,
            format: "pem",
            type: "spki",
        });
        return crypto.verify(
            null, // Ed25519 doesn't use a separate hash algorithm
            Buffer.from(message, "utf-8"),
            publicKey,
            Buffer.from(signatureBase64, "base64")
        );
    } catch {
        return false;
    }
}

export type AgentAuthFailureReason =
    | "unknown_agent"
    | "missing_public_key"
    | "bad_signature"
    | "replayed_signature";

export type AgentAuthResult =
    | { ok: true; agentId: string; agentName: string; orgId: string; agentType: string }
    | { ok: false; reason: AgentAuthFailureReason };

/**
 * Look up an agent's public key from Firestore and verify the signature,
 * returning *why* a failure happened instead of collapsing every case into
 * a bare null. Callers that want to hand the caller a distinct error code
 * (rather than a generic 401) should use this instead of `verifyAgentRequest`.
 *
 * @param opts.skipReplayCheck — Skip nonce/replay tracking for this call.
 *   Only for endpoints supporting a legacy signed-message form that doesn't
 *   fold in a fresh per-request value, where every retry of the same logical
 *   request produces an identical (and therefore falsely-"replayed")
 *   signature — see the nonce-tracking note above `checkAndRecordNonce`.
 */
export async function verifyAgentRequestDetailed(
    agentId: string,
    message: string,
    signatureBase64: string,
    opts: { skipReplayCheck?: boolean } = {}
): Promise<AgentAuthResult> {
    if (!agentId || !signatureBase64) return { ok: false, reason: "unknown_agent" };

    if (!opts.skipReplayCheck) {
        // Replay protection: reject if this exact signature was already used
        if (!(await checkAndRecordNonce(signatureBase64))) {
            return { ok: false, reason: "replayed_signature" };
        }
    }

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) return { ok: false, reason: "unknown_agent" };

    const data = agentSnap.data()!;
    const publicKeyPem = data.publicKey;
    if (!publicKeyPem) return { ok: false, reason: "missing_public_key" };

    const valid = verifySignature(publicKeyPem, message, signatureBase64);
    if (!valid) return { ok: false, reason: "bad_signature" };

    return {
        ok: true,
        agentId,
        agentName: data.name || agentId,
        orgId: data.orgId || data.organizationId || "",
        agentType: data.type || "agent",
    };
}

/**
 * Look up an agent's public key from Firestore and verify the signature.
 * Returns the agent data on success, or null on failure.
 * Also checks the nonce to prevent replay attacks.
 */
export async function verifyAgentRequest(
    agentId: string,
    message: string,
    signatureBase64: string
): Promise<{
    agentId: string;
    agentName: string;
    orgId: string;
    agentType: string;
} | null> {
    try {
        const result = await verifyAgentRequestDetailed(agentId, message, signatureBase64);
        if (!result.ok) return null;
        const { ok, ...agent } = result;
        return agent;
    } catch (err) {
        // Admin SDK misconfiguration is a server-config problem, not an auth failure —
        // let it propagate so callers can return a distinct 503 instead of a misleading 401.
        if (isAdminConfigError(err)) throw err;
        return null;
    }
}

/**
 * Check that a timestamp is not stale (within 2 minutes).
 * Reduced from 5 minutes to minimize replay attack window.
 */
export function isTimestampFresh(timestampMs: number, maxAgeMs = 2 * 60 * 1000): boolean {
    const now = Date.now();
    return Math.abs(now - timestampMs) < maxAgeMs;
}

/**
 * Standard 401 response for failed signature verification.
 */
export function unauthorized(message = "Invalid or missing signature", code?: string) {
    return Response.json({ error: message, ...(code ? { code } : {}) }, { status: 401 });
}

/** Maps an `AgentAuthFailureReason` to the stable 401 code callers can branch on. */
const AUTH_FAILURE_CODES: Record<AgentAuthFailureReason, string> = {
    unknown_agent: "UNKNOWN_AGENT",
    missing_public_key: "UNKNOWN_AGENT",
    bad_signature: "BAD_SIGNATURE",
    replayed_signature: "REPLAY",
};

const AUTH_FAILURE_MESSAGES: Record<AgentAuthFailureReason, string> = {
    unknown_agent: "Unknown agent",
    missing_public_key: "Agent has no public key on file",
    bad_signature: "Invalid signature",
    replayed_signature: "Signature already used (replay detected)",
};

/** Standard 401 response for an `AgentAuthResult` failure, with a stable code. */
export function unauthorizedFor(reason: AgentAuthFailureReason) {
    return unauthorized(AUTH_FAILURE_MESSAGES[reason], AUTH_FAILURE_CODES[reason]);
}

/**
 * Standard 503 response when the Admin SDK itself isn't configured — distinct
 * from a signature/auth failure so operators don't mistake a broken deploy
 * for a bad key.
 */
export function configUnavailable() {
    return Response.json(
        { error: "Firebase Admin SDK not configured on the server — signed requests cannot be verified.", code: "ADMIN_NOT_CONFIGURED" },
        { status: 503 }
    );
}
