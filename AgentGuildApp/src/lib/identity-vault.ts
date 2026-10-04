/**
 * Extra storage for an agent. One ciphertext, three wraps.
 *
 * Each identity is three soulbound copies. The data key is sealed to:
 *   protocol — platform keypair (copy #1)
 *   agent    — the agent's Ed25519 key (copy #3)
 *   user     — the org owner's Solana wallet (copy #2), when that copy exists
 *
 * Any one of those private keys opens the slot. This module never sees
 * plaintext. It checks the three copies on chain, then stores the wraps.
 *
 * Collection identityVault/{agentId}__{slot}
 * Server-only. Clients are denied in firestore.rules.
 */

import { adminDb } from "@/lib/firebase-admin";
import { getAgent } from "@/lib/firestore-admin";
import { fetchIdentityCopyOwner, platformIdentityHolder } from "@/lib/solana/identity-nft";
import { FieldValue } from "firebase-admin/firestore";

const COLLECTION = "identityVault";
const SLOT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CIPHERTEXT_CHARS = 350_000;

export class VaultError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type VaultRecipients = {
  protocol: string;
  agent: string;
  user: string | null;
};

type VaultWrap = { eph: string; nonce: string; boxed: string };

export function parseVaultSlot(slot: string): string {
  if (!SLOT_RE.test(slot)) throw new VaultError("slot must be a lowercase slug", 400);
  return slot;
}

function canonicalB64(value: unknown, label: string, size?: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CIPHERTEXT_CHARS) {
    throw new VaultError(`${label} is missing or too large`, 400);
  }
  const buf = Buffer.from(value, "base64");
  if ((size != null && buf.length !== size) || buf.toString("base64") !== value) {
    throw new VaultError(`${label} must be canonical base64${size != null ? ` of ${size} bytes` : ""}`, 400);
  }
  return value;
}

function parseBox(ciphertext: unknown, nonce: unknown): { ciphertext: string; nonce: string; bytes: number } {
  const bodyText = canonicalB64(ciphertext, "ciphertext");
  const ivText = canonicalB64(nonce, "nonce", 12);
  const bytes = Buffer.from(bodyText, "base64").length;
  if (bytes < 17) throw new VaultError("ciphertext has the wrong size", 400);
  return { ciphertext: bodyText, nonce: ivText, bytes };
}

function parseWrap(value: unknown, label: string): VaultWrap {
  if (!value || typeof value !== "object") throw new VaultError(`${label} wrap is required`, 400);
  const wrap = value as Record<string, unknown>;
  return {
    eph: canonicalB64(wrap.eph, `${label} ephemeral key`, 32),
    nonce: canonicalB64(wrap.nonce, `${label} nonce`, 12),
    boxed: canonicalB64(wrap.boxed, `${label} wrap`, 48),
  };
}

async function holderIs(asset: string | undefined, expected: string, missing: string, wrong: string): Promise<void> {
  if (!asset) throw new VaultError(missing, 403);
  const owner = await fetchIdentityCopyOwner(asset);
  if (!owner || owner !== expected) throw new VaultError(wrong, 403);
}

/**
 * Vault writes and reads are allowed only while the minted copies are
 * still held by the protocol, the agent, and (when minted) the user.
 * Returns the Solana addresses the ciphertext must be sealed to.
 */
export async function unlockIdentityVault(agentId: string): Promise<{ orgId: string; recipients: VaultRecipients }> {
  const agent = await getAgent(agentId);
  if (!agent) throw new VaultError("Agent not found", 404);
  const protocol = platformIdentityHolder();
  if (!protocol) throw new VaultError("Platform identity key is not configured", 503);

  const agentAsset = agent.nftAgentAssetAddress || agent.nftMintAddress;
  if (!agent.nftPlatformAssetAddress || !agentAsset || !agent.solanaAddress) {
    throw new VaultError("Identity NFT is not minted for this agent", 403);
  }
  await holderIs(
    agent.nftPlatformAssetAddress,
    protocol,
    "Protocol identity NFT is not minted",
    "Protocol identity NFT is not held by the platform",
  );
  await holderIs(
    agentAsset,
    agent.solanaAddress,
    "Agent identity NFT is not minted",
    "Agent identity NFT is not held by this agent",
  );

  let user: string | null = null;
  if (agent.nftOwnerAssetAddress) {
    if (!agent.nftOwnerSolanaAddress) throw new VaultError("User identity NFT has no owner wallet", 403);
    await holderIs(
      agent.nftOwnerAssetAddress,
      agent.nftOwnerSolanaAddress,
      "User identity NFT is not minted",
      "User identity NFT is not held by the org owner",
    );
    user = agent.nftOwnerSolanaAddress;
  }

  return { orgId: agent.orgId, recipients: { protocol, agent: agent.solanaAddress, user } };
}

function docId(agentId: string, slot: string): string {
  return `${agentId}__${slot}`;
}

function when(value: unknown): string | null {
  if (value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export async function listIdentityVault(agentId: string): Promise<{ slot: string; bytes: number; updatedAt: string | null }[]> {
  const snap = await adminDb().collection(COLLECTION).where("agentId", "==", agentId).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data();
      return { slot: String(data.slot), bytes: Number(data.bytes) || 0, updatedAt: when(data.updatedAt) };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

export async function putIdentityVault(
  agentId: string,
  orgId: string,
  slot: string,
  body: unknown,
  recipients: VaultRecipients,
): Promise<void> {
  if (!body || typeof body !== "object") throw new VaultError("vault body is required", 400);
  const record = body as Record<string, unknown>;
  if (record.v !== 2) throw new VaultError("vault body must be version 2", 400);
  const box = parseBox(record.ciphertext, record.nonce);
  const wraps = record.wraps;
  if (!wraps || typeof wraps !== "object") throw new VaultError("three key wraps are required", 400);
  const wrapped = wraps as Record<string, unknown>;
  const protocol = parseWrap(wrapped.protocol, "protocol");
  const agent = parseWrap(wrapped.agent, "agent");
  let user: VaultWrap | null = null;
  if (recipients.user) {
    user = parseWrap(wrapped.user, "user");
  } else if (wrapped.user != null) {
    throw new VaultError("user wrap is not allowed until copy #2 is minted", 400);
  }
  await adminDb().collection(COLLECTION).doc(docId(agentId, slot)).set({
    agentId,
    orgId,
    slot,
    v: 2,
    ciphertext: box.ciphertext,
    nonce: box.nonce,
    bytes: box.bytes,
    wraps: { protocol, agent, user },
    recipients,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function getIdentityVault(
  agentId: string,
  slot: string,
): Promise<{ v: 2; slot: string; ciphertext: string; nonce: string; wraps: { protocol: VaultWrap; agent: VaultWrap; user: VaultWrap | null } } | null> {
  const snap = await adminDb().collection(COLLECTION).doc(docId(agentId, slot)).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.agentId !== agentId) return null;
  return { v: 2, slot, ciphertext: data.ciphertext, nonce: data.nonce, wraps: data.wraps };
}

export async function deleteIdentityVault(agentId: string, slot: string): Promise<boolean> {
  const ref = adminDb().collection(COLLECTION).doc(docId(agentId, slot));
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agentId !== agentId) return false;
  await ref.delete();
  return true;
}
