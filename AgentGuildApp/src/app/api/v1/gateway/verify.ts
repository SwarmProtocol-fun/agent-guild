/**
 * Ed25519 signature verification for gateway workers.
 *
 * Parallel to /api/v1/verify.ts (which handles agent auth) but looks up
 * public keys from the `gatewayWorkers` Firestore collection.
 *
 * Used by:
 *   - /api/v1/gateway/register — self-service registration
 *   - auth-guard.ts requireGatewayAuth() — API route guard
 *   - hub/index.mjs verifyGatewayEd25519() — WebSocket auth
 */
import crypto from "crypto";
import { db } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";

// ── Nonce tracking (gateway-specific) ─────────────────────

const NONCE_TTL_MS = 3 * 60 * 1000;
const nonceCache = new Map<string, number>();
let cleanupCounter = 0;

function cleanupNonces() {
  const now = Date.now();
  for (const [nonce, expiry] of nonceCache) {
    if (now >= expiry) nonceCache.delete(nonce);
  }
}

export function checkAndRecordNonce(signatureBase64: string): boolean {
  if (++cleanupCounter % 100 === 0) cleanupNonces();

  const nonce = crypto.createHash("sha256").update(signatureBase64).digest("hex").slice(0, 32);
  const now = Date.now();

  if (nonceCache.has(nonce)) {
    const expiry = nonceCache.get(nonce)!;
    if (now < expiry) return false;
  }

  nonceCache.set(nonce, now + NONCE_TTL_MS);
  return true;
}

// ── Signature verification ────────────────────────────────

export function verifySignature(
  publicKeyPem: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: publicKeyPem,
      format: "pem",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(message, "utf-8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a standalone Ed25519 signature against a PEM public key.
 * Used during registration when the gateway isn't in Firestore yet.
 */
export function verifyEd25519Proof(
  publicKeyPem: string,
  message: string,
  signatureBase64: string,
): boolean {
  return verifySignature(publicKeyPem, message, signatureBase64);
}

/**
 * Look up a gateway worker's public key from Firestore and verify the signature.
 * Returns gateway data on success, null on failure.
 * Also checks nonce to prevent replay attacks.
 */
export async function verifyGatewayRequest(
  gatewayId: string,
  message: string,
  signatureBase64: string,
): Promise<{
  gatewayId: string;
  workerName: string;
  orgId: string;
  region: string;
} | null> {
  if (!gatewayId || !signatureBase64) return null;

  if (!checkAndRecordNonce(signatureBase64)) return null;

  try {
    const snap = await getDoc(doc(db, "gatewayWorkers", gatewayId));
    if (!snap.exists()) return null;

    const data = snap.data();
    const publicKeyPem = data.publicKey;
    if (!publicKeyPem) return null;

    const valid = verifySignature(publicKeyPem, message, signatureBase64);
    if (!valid) return null;

    return {
      gatewayId,
      workerName: data.name || gatewayId,
      orgId: data.orgId || "",
      region: data.region || "",
    };
  } catch {
    return null;
  }
}

export function isTimestampFresh(timestampMs: number, maxAgeMs = 2 * 60 * 1000): boolean {
  const now = Date.now();
  return Math.abs(now - timestampMs) < maxAgeMs;
}
