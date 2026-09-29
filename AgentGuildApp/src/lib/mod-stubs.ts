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
