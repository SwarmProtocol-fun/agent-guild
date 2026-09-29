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

/** Thrown by firebase-admin.ts when Admin SDK env vars are missing — distinct from an auth failure. */
const ADMIN_NOT_CONFIGURED_MARKER = "Firebase Admin SDK not configured";

export function isAdminConfigError(err: unknown): boolean {
    return err instanceof Error && err.message.includes(ADMIN_NOT_CONFIGURED_MARKER);
}

// ── Nonce tracking (in-memory with Redis fallback) ──────
// Nonces are signature hashes — if the same signature is seen twice
// within the freshness window, the request is rejected.

const NONCE_TTL_MS = 3 * 60 * 1000; // 3 minutes (slightly > 2-min freshness window)
const nonceCache = new Map<string, number>(); // nonce → expiry timestamp

// Periodic cleanup (every ~100 calls)
let nonceCleanupCounter = 0;
function cleanupNonces() {
    const now = Date.now();
    for (const [nonce, expiry] of nonceCache) {
        if (now >= expiry) nonceCache.delete(nonce);
    }
}

/**
 * Check if a nonce (signature hash) has been seen before.
 * Returns true if the nonce is fresh (not seen), false if replayed.
 */
export function checkAndRecordNonce(signatureBase64: string): boolean {
    // Cleanup expired nonces periodically
    if (++nonceCleanupCounter % 100 === 0) cleanupNonces();

    const nonce = crypto.createHash("sha256").update(signatureBase64).digest("hex").slice(0, 32);
    const now = Date.now();

    if (nonceCache.has(nonce)) {
        const expiry = nonceCache.get(nonce)!;
        if (now < expiry) return false; // replay detected
    }

    nonceCache.set(nonce, now + NONCE_TTL_MS);
    return true;
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
    if (!agentId || !signatureBase64) return null;

    // Replay protection: reject if this exact signature was already used
    if (!checkAndRecordNonce(signatureBase64)) return null;

    try {
        const agentSnap = await adminDb().collection("agents").doc(agentId).get();
        if (!agentSnap.exists) return null;

        const data = agentSnap.data()!;
        const publicKeyPem = data.publicKey;
        if (!publicKeyPem) return null;

        const valid = verifySignature(publicKeyPem, message, signatureBase64);
        if (!valid) return null;

        return {
            agentId,
            agentName: data.name || agentId,
            orgId: data.orgId || data.organizationId || "",
            agentType: data.type || "agent",
        };
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
export function unauthorized(message = "Invalid or missing signature") {
    return Response.json({ error: message }, { status: 401 });
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
