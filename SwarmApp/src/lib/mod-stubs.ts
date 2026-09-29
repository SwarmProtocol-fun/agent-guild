/**
 * Core-side stand-ins for integrations that moved into mods.
 *
 * The open-core split removed Hedera (HCS score events, governance, slashing,
 * private memory topics) from core. Core callers still reference these entry
 * points, so they live here as inert defaults until the swarm-hedera mod
 * provides real implementations.
 *
 * Score emitters match the original behaviour when HCS was not configured:
 * warn and return. Anything that would have to fabricate ledger state
 * (memory topics) throws instead, so callers can't persist fake IDs.
 */

const MOD_MSG = "swarm-hedera mod not installed";

// ── Score events (were hedera-score-emitter.ts) ────────────────

export async function emitSkillReport(
    _asn: string,
    _agentAddress: string,
    _skills: string[],
): Promise<void> {
    console.warn(`[mod-stubs] ${MOD_MSG} — skill_report score event not submitted`);
}

export async function emitPenalty(
    _asn: string,
    _agentAddress: string,
    _amount: number,
    _reason: string,
): Promise<void> {
    console.warn(`[mod-stubs] ${MOD_MSG} — penalty score event not submitted`);
}

export async function emitAdminOverride(
    _asn: string,
    _agentAddress: string,
    _creditDelta: number,
    _trustDelta: number,
    _reason: string,
    _overrideId?: string,
): Promise<void> {
    console.warn(`[mod-stubs] ${MOD_MSG} — admin_override score event not submitted`);
}

// ── Governance / slashing (were hedera-governance.ts, hedera-slashing.ts) ──

export async function createPenaltyProposal(
    _asn: string,
    _agentAddress: string,
    _amount: number,
    _reason: string,
    _proposer: string,
    _approvers: string[],
): Promise<string> {
    // Original returned the proposal ID; never fabricate one.
    throw new Error(`${MOD_MSG} — cannot create penalty governance proposal`);
}

export async function getAgentSlashingHistory(_asn: string): Promise<unknown[]> {
    return [];
}

// ── Private memory topics (were hedera-memory) ─────────────────

export async function createPrivateMemoryTopic(
    _agentId: string,
    _asn: string,
): Promise<{ memoryTopicId: string }> {
    throw new Error(`${MOD_MSG} — cannot create private memory topic`);
}

export async function postPrivateMemory(
    _topicId: string,
    _asn: string,
    _message: { type: string; content: string; metadata?: Record<string, unknown> },
): Promise<void> {
    throw new Error(`${MOD_MSG} — cannot post private memory`);
}

// ── Agent identity issuance (was Hedera-only mintIdentityNFT) ──
//
// Registration used to mint a SwarmAgentIdentityNFT directly against
// Hedera from register/route.ts — chain-specific code sitting in core,
// inconsistent with every other integration on this page. It's also why
// identity issuance was silently a no-op in any deployment without
// HEDERA_PLATFORM_KEY configured (true in this environment) and why it
// ran fire-and-forget (an agent's identity might never land, with
// nothing checking for it).
//
// This is the swappable seam: core issues a Firestore-backed identity
// record synchronously (zero config, always succeeds), and a chain mod
// (e.g. swarm-hedera) can override this same call site to additionally
// mint the real on-chain soulbound NFT. Either way, the caller gets back
// a stable `{tokenId, asn}` shape it can store on the agent doc, and the
// record exists the instant registration completes — no async race.

import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export interface AgentIdentityRecord {
    tokenId: string;
    asn: string;
    agentAddress: string;
    vaultPublicKey: string | null;
    issuedAt: number;
}

/**
 * Issue a soulbound identity credential for a newly (or re-)registered
 * agent. Core-native default: a Firestore doc at `agentIdentities/{agentId}`
 * — no RPC, no env var, works today with zero setup. `vaultPublicKey` is
 * the agent's X25519 public key (see SwarmConnect's vault keypair) used
 * only as a discovery/identity artifact here; the server never derives or
 * holds the corresponding private key or any content-encryption key.
 *
 * A chain mod overriding this function should still write the same
 * `agentIdentities/{agentId}` doc shape (with a real on-chain `tokenId`)
 * so `requireAgentIdentity` (auth-guard.ts) doesn't need to know which
 * implementation issued it.
 */
export async function issueAgentIdentity(
    agentId: string,
    agentAddress: string,
    asn: string,
    vaultPublicKey: string | null,
): Promise<AgentIdentityRecord> {
    const ref = adminDb().collection("agentIdentities").doc(agentId);
    const existing = await ref.get();
    if (existing.exists) {
        const data = existing.data()!;
        // vaultPublicKey can be backfilled on a later registration (e.g. an
        // agent that registered before generating a vault keypair), but an
        // already-issued tokenId/asn never changes underneath the agent.
        if (vaultPublicKey && !data.vaultPublicKey) {
            await ref.update({ vaultPublicKey });
        }
        return {
            tokenId: data.tokenId,
            asn: data.asn,
            agentAddress: data.agentAddress,
            vaultPublicKey: vaultPublicKey || data.vaultPublicKey || null,
            issuedAt: data.issuedAt,
        };
    }

    const issuedAt = Date.now();
    const record = { tokenId: agentId, asn, agentAddress, vaultPublicKey: vaultPublicKey || null, issuedAt };
    await ref.set({ ...record, createdAt: FieldValue.serverTimestamp() });
    return record;
}

/** Read back an agent's identity record, or null if none has been issued. */
export async function getAgentIdentity(agentId: string): Promise<AgentIdentityRecord | null> {
    const snap = await adminDb().collection("agentIdentities").doc(agentId).get();
    if (!snap.exists) return null;
    const data = snap.data()!;
    return {
        tokenId: data.tokenId,
        asn: data.asn,
        agentAddress: data.agentAddress,
        vaultPublicKey: data.vaultPublicKey || null,
        issuedAt: data.issuedAt,
    };
}
