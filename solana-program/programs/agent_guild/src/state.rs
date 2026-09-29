use anchor_lang::prelude::*;

pub const MAX_NAME_LEN: usize = 64;
pub const MAX_SKILLS_LEN: usize = 256;
pub const MAX_ASN_LEN: usize = 32;
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_DESCRIPTION_LEN: usize = 512;
pub const MAX_REQUIRED_SKILLS_LEN: usize = 256;

/// Global program config — replaces OpenZeppelin `Ownable` from the Solidity
/// contracts. `authority` gates every admin-only instruction (registerAgentFor,
/// updateCredit, resolveDispute, withdraw). `task_counter` is the monotonically
/// increasing id used to seed each `TaskAccount` PDA.
#[account]
pub struct GuildConfig {
    pub authority: Pubkey,
    pub task_counter: u64,
    pub bump: u8,
}

impl GuildConfig {
    pub const SIZE: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct AgentAccount {
    pub wallet: Pubkey,
    pub name: String,
    pub skills: String,
    pub asn: String,
    pub fee_rate_bps: u16,
    pub credit_score: u16,
    pub trust_score: u8,
    pub active: bool,
    pub registered_at: i64,
    pub last_updated: i64,
    pub bump: u8,
}

impl AgentAccount {
    pub const SIZE: usize = 8
        + 32
        + (4 + MAX_NAME_LEN)
        + (4 + MAX_SKILLS_LEN)
        + (4 + MAX_ASN_LEN)
        + 2
        + 2
        + 1
        + 1
        + 8
        + 8
        + 1;
}

/// Maps an ASN string to its owning agent wallet — replaces `ASNRegistry`'s
/// lookup role (`asnToAgent` in the Solidity `AgentGuildAgentRegistryLink`).
#[account]
pub struct AsnRecord {
    pub asn: String,
    pub agent: Pubkey,
    pub bump: u8,
}

impl AsnRecord {
    pub const SIZE: usize = 8 + (4 + MAX_ASN_LEN) + 32 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    Open,
    Claimed,
    Completed,
    Expired,
    Disputed,
    Resolved,
}

/// A task's escrow lives directly on this PDA's lamport balance (funded by
/// `post_task`'s transfer on top of its own rent-exempt minimum) — there is no
/// separate vault account, mirroring how `AgentGuildTaskBoardLink` held the
/// LINK escrow on the task-board contract itself.
#[account]
pub struct TaskAccount {
    pub task_id: u64,
    pub poster: Pubkey,
    pub claimed_by: Option<Pubkey>,
    pub title: String,
    pub description: String,
    pub required_skills: String,
    pub deadline: i64,
    pub budget_lamports: u64,
    pub delivery_hash: Option<[u8; 32]>,
    pub status: TaskStatus,
    pub created_at: i64,
    pub bump: u8,
}

impl TaskAccount {
    pub const SIZE: usize = 8
        + 8
        + 32
        + (1 + 32)
        + (4 + MAX_TITLE_LEN)
        + (4 + MAX_DESCRIPTION_LEN)
        + (4 + MAX_REQUIRED_SKILLS_LEN)
        + 8
        + 8
        + (1 + 32)
        + 1
        + 8
        + 1;
}

/// Revenue-splitting treasury — same 50/30/20 compute/growth/reserve split as
/// `AgentGuildTreasuryLink`, denominated in native lamports instead of LINK.
#[account]
pub struct TreasuryAccount {
    pub authority: Pubkey,
    pub agent_address: Pubkey,
    pub compute_balance: u64,
    pub growth_balance: u64,
    pub reserve_balance: u64,
    pub bump: u8,
}

impl TreasuryAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}
