/**
 * Reputation/governance/memory integrations — replaces `mod-stubs.ts`
 * (the inert Hedera stand-ins) with real Solana-backed implementations.
 *
 * - Score events (emitSkillReport/emitPenalty/emitAdminOverride) post an
 *   on-chain memo tagged to the agent's registry PDA — see
 *   src/lib/solana/client.ts#postEventMemo. A memo's payload can't be
 *   encrypted-yet-private the way an HCS topic message conceptually could
 *   (anyone can already see a transaction happened; explorers index the
 *   plaintext) — so events are gated on `isAgentPublic()` below and only
 *   ever forwarded on-chain for agents whose privacy level is public.
 *   Private/organization-level agents' events stay in Firestore only,
 *   same as every other private Agent Guild document.
 * - Governance/slashing (createPenaltyProposal/getAgentSlashingHistory) use
 *   the Anchor program's PenaltyProposal accounts — single-authority
 *   approval, not a multi-sig vote (matches the app's existing
 *   admin-driven model elsewhere). Not gated on privacy — these are
 *   authority-only actions visible to admins regardless.
 * - Private memory topics are Firestore documents, relying on Firestore's
 *   own access control (never posted on-chain at all).
 */

import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getAgent } from "@/lib/firestore-admin";
import { addMemoryEntry } from "@/lib/firestore-admin";
import { getPrivacySettings } from "@/lib/privacy-settings";
import type { ScoreEvent } from "@/lib/credit-types";
import {
    createPenaltyProposalOnChain,
    emitScoreEventOnChain,
    getAgentSlashingHistoryOnChain,
} from "@/lib/solana/platform";

// ── Score events ──────────────────────────────────────────────────────
// Payloads are `ScoreEvent`-shaped (credit-types.ts) so the read side
// (credit-service.ts/credit-explainer.ts) can decode on-chain memos
// straight into the same type the rest of the credit engine already uses.

/**
 * Whether this agent's score events are allowed on a public blockchain.
 * Fails closed (never forwards on-chain) on any lookup error — the whole
 * point is not to leak a "private" agent's activity.
 */
async function isAgentPublic(agentAddress: string): Promise<boolean> {
    try {
        let snap = await adminDb().collection("agents").where("walletAddress", "==", agentAddress).limit(1).get();
        if (snap.empty) {
            snap = await adminDb().collection("agents").where("solanaAddress", "==", agentAddress).limit(1).get();
        }
        if (snap.empty) return false;

        const doc = snap.docs[0];
        const orgId = doc.data().orgId as string;
        const privacy = await getPrivacySettings(orgId, doc.id);
        return privacy.privacyLevel === "public" || privacy.allowPublicScores === true;
    } catch (err) {
        console.error("[reputation-chain] isAgentPublic lookup failed — defaulting to private:", err);
        return false;
    }
}

export async function emitSkillReport(
    asn: string,
    agentAddress: string,
    skills: string[],
): Promise<void> {
    if (!(await isAgentPublic(agentAddress))) return;

    const event: ScoreEvent = {
        type: "skill_report",
        asn,
        agentAddress,
        creditDelta: 0,
        trustDelta: 0,
        timestamp: Math.floor(Date.now() / 1000),
        metadata: { skills },
    };
    const result = await emitScoreEventOnChain(agentAddress, event);
    if (!result.txSignature) {
        console.warn(`[reputation-chain] skill_report event not submitted for ${asn} (no platform keypair or address)`);
    }
}

export async function emitPenalty(
    asn: string,
    agentAddress: string,
    amount: number,
    reason: string,
): Promise<void> {
    if (!(await isAgentPublic(agentAddress))) return;

    const event: ScoreEvent = {
        type: "penalty",
        asn,
        agentAddress,
        creditDelta: amount,
        trustDelta: 0,
        timestamp: Math.floor(Date.now() / 1000),
        metadata: { reason },
    };
    const result = await emitScoreEventOnChain(agentAddress, event);
    if (!result.txSignature) {
        console.warn(`[reputation-chain] penalty event not submitted for ${asn} (no platform keypair or address)`);
    }
}

export async function emitAdminOverride(
    asn: string,
    agentAddress: string,
    creditDelta: number,
    trustDelta: number,
    reason: string,
    overrideId?: string,
): Promise<void> {
    if (!(await isAgentPublic(agentAddress))) return;

    const event: ScoreEvent = {
        type: "admin_override",
        asn,
        agentAddress,
        creditDelta,
        trustDelta,
        timestamp: Math.floor(Date.now() / 1000),
        metadata: { reason, overrideId },
    };
    const result = await emitScoreEventOnChain(agentAddress, event);
    if (!result.txSignature) {
        console.warn(`[reputation-chain] admin_override event not submitted for ${asn} (no platform keypair or address)`);
    }
}

// ── Governance / slashing ─────────────────────────────────────────────

/**
 * Creates a real on-chain penalty-governance proposal. `proposer` and
 * `approvers` are kept in the signature for call-site compatibility with
 * the original multi-sig design, but approval here is single-authority
 * (the platform key resolves proposals via the admin credit-ops queue) —
 * they're not persisted on-chain.
 */
export async function createPenaltyProposal(
    asn: string,
    agentAddress: string,
    amount: number,
    reason: string,
    _proposer: string,
    _approvers: string[],
): Promise<string> {
    return createPenaltyProposalOnChain({ agentAddress, asn, amount: Math.abs(Math.round(amount)), reason });
}

export async function getAgentSlashingHistory(asn: string): Promise<unknown[]> {
    return getAgentSlashingHistoryOnChain(asn);
}

// ── Private memory topics (Firestore, not on-chain — see file header) ──

const MEMORY_TOPICS_COLLECTION = "memoryTopics";

export async function createPrivateMemoryTopic(
    agentId: string,
    asn: string,
): Promise<{ memoryTopicId: string }> {
    const agent = await getAgent(agentId);
    if (!agent) {
        throw new Error(`Cannot create memory topic — agent ${agentId} not found`);
    }

    const ref = await adminDb().collection(MEMORY_TOPICS_COLLECTION).add({
        agentId,
        orgId: agent.orgId,
        asn,
        createdAt: FieldValue.serverTimestamp(),
    });
    return { memoryTopicId: ref.id };
}

export async function postPrivateMemory(
    topicId: string,
    asn: string,
    message: { type: string; content: string; metadata?: Record<string, unknown> },
): Promise<void> {
    const topicSnap = await adminDb().collection(MEMORY_TOPICS_COLLECTION).doc(topicId).get();
    if (!topicSnap.exists) {
        throw new Error(`Cannot post to memory topic ${topicId} — topic does not exist`);
    }
    const topic = topicSnap.data()!;

    await addMemoryEntry({
        orgId: topic.orgId,
        agentId: topic.agentId,
        type: "long_term",
        title: message.type,
        content: message.content,
        tags: ["private-memory-topic"],
        structuredData: { ...message.metadata, topicId, asn },
    });
}
