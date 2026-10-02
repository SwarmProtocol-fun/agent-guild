/**
 * Vault envelope encryption.
 *
 * Every secret gets its own random 256-bit data key (DEK). The value is
 * sealed with AES-256-GCM under that DEK, and the DEK itself is wrapped by a
 * key-encryption key (KEK) that never leaves its provider:
 *
 *   - gcp-kms  — VAULT_KMS_KEY = projects/…/locations/…/keyRings/…/cryptoKeys/…
 *                The DEK is wrapped by Cloud KMS (HSM-backed if the key's
 *                protection level is HSM). Auth reuses the Firebase Admin
 *                service account, so no extra SDK or credentials.
 *   - local    — VAULT_MASTER_KEY = 32 random bytes, base64. For dev and
 *                self-hosting; the KEK lives in the server's environment.
 *
 * The provider id and key reference are stored next to each wrapped DEK, so
 * switching providers later only affects newly written secrets and old ones
 * stay readable while the old key is still configured.
 *
 * Unlike the legacy src/lib/secrets.ts vault (PBKDF2 over a password the
 * caller supplies on every reveal), this one is decryptable by the server
 * itself — which is what lets an agent *use* a credential through a binding
 * without ever being handed it.
 */

import crypto from "crypto";
import { getApps } from "firebase-admin/app";
import { adminDb } from "@/lib/firebase-admin";

export interface SealedValue {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16 bytes
  wrappedDek: string; // base64, provider-specific
  kekProvider: "gcp-kms" | "local";
  kekRef: string; // KMS key resource name, or "env:VAULT_MASTER_KEY"
}

interface KeyProvider {
  id: SealedValue["kekProvider"];
  ref: string;
  wrap(dek: Buffer, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
}

// ─── local provider ────────────────────────────────────────────

function localKek(): Buffer {
  const raw = process.env.VAULT_MASTER_KEY;
  if (!raw) throw new Error("Vault not configured: set VAULT_KMS_KEY (Cloud KMS) or VAULT_MASTER_KEY (32 bytes, base64)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("VAULT_MASTER_KEY must decode to exactly 32 bytes");
  return key;
}

const localProvider: KeyProvider = {
  id: "local",
  ref: "env:VAULT_MASTER_KEY",
  async wrap(dek, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", localKek(), iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  },
  async unwrap(wrapped, aad) {
    const buf = Buffer.from(wrapped, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", localKek(), buf.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  },
};

// ─── Cloud KMS provider ────────────────────────────────────────

async function gcpAccessToken(): Promise<string> {
  adminDb(); // ensures the Admin app (and its service-account credential) is initialized
  const app = getApps().find((a) => a.name === "agent-guild-admin");
  const credential = app?.options.credential;
  if (!credential) throw new Error("Cloud KMS needs the Firebase Admin service account");
  const { access_token } = await credential.getAccessToken();
  return access_token;
}

async function kmsCall(keyName: string, op: "encrypt" | "decrypt", body: Record<string, string>) {
  const resp = await fetch(`https://cloudkms.googleapis.com/v1/${keyName}:${op}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await gcpAccessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Cloud KMS ${op} failed (${resp.status})`);
  return resp.json() as Promise<{ ciphertext?: string; plaintext?: string }>;
}

function gcpProvider(keyName: string): KeyProvider {
  return {
    id: "gcp-kms",
    ref: keyName,
    async wrap(dek, aad) {
      const out = await kmsCall(keyName, "encrypt", {
        plaintext: dek.toString("base64"),
        additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
      });
      if (!out.ciphertext) throw new Error("Cloud KMS returned no ciphertext");
      return out.ciphertext;
    },
    async unwrap(wrapped, aad) {
      const out = await kmsCall(keyName, "decrypt", {
        ciphertext: wrapped,
        additionalAuthenticatedData: Buffer.from(aad).toString("base64"),
      });
      if (!out.plaintext) throw new Error("Cloud KMS returned no plaintext");
      return Buffer.from(out.plaintext, "base64");
    },
  };
}

/** Provider used for new writes. */
function activeProvider(): KeyProvider {
  const kms = process.env.VAULT_KMS_KEY;
  return kms ? gcpProvider(kms) : localProvider;
}

/** Provider that wrapped an existing value. */
function providerFor(sealed: Pick<SealedValue, "kekProvider" | "kekRef">): KeyProvider {
  if (sealed.kekProvider === "gcp-kms") return gcpProvider(sealed.kekRef);
  return localProvider;
}

export function vaultProviderInfo(): { provider: SealedValue["kekProvider"]; configured: boolean } {
  if (process.env.VAULT_KMS_KEY) return { provider: "gcp-kms", configured: true };
  return { provider: "local", configured: Boolean(process.env.VAULT_MASTER_KEY) };
}

// ─── seal / open ───────────────────────────────────────────────

/**
 * `aad` binds the ciphertext to its owner (e.g. `${orgId}:${secretId}`), so a
 * sealed blob copied onto another org's or secret's document won't decrypt.
 */
export async function seal(plaintext: string, aad: string): Promise<SealedValue> {
  const provider = activeProvider();
  const dek = crypto.randomBytes(32);
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", dek, iv);
    c.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      wrappedDek: await provider.wrap(dek, aad),
      kekProvider: provider.id,
      kekRef: provider.ref,
    };
  } finally {
    dek.fill(0);
  }
}

export async function open(sealed: SealedValue, aad: string): Promise<string> {
  const dek = await providerFor(sealed).unwrap(sealed.wrappedDek, aad);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", dek, Buffer.from(sealed.iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, "base64")), d.final()]).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Last 4 characters only, and nothing at all for short values. */
export function maskSecret(value: string): string {
  if (value.length < 12) return "••••••••";
  return `••••••••${value.slice(-4)}`;
}
