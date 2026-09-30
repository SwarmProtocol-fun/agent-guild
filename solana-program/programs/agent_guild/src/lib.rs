use anchor_lang::prelude::*;

pub mod errors;
pub mod governance;
pub mod registry;
pub mod state;
pub mod task_board;
pub mod treasury;

use governance::*;
use registry::*;
use task_board::*;
use treasury::*;

declare_id!("4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci");

/// Agent Guild on-chain program.
///
/// Consolidates what used to be four separate Solidity contracts
/// (AgentGuildAgentRegistryLink, AgentGuildASNRegistry, AgentGuildTaskBoardLink,
/// AgentGuildTreasuryLink) into one Anchor program, using native SOL lamports
/// for escrow/treasury instead of the LINK ERC-20 token those contracts used.
#[program]
pub mod agent_guild {
    use super::*;

    // ── Registry ──────────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        registry::initialize(ctx)
    }

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        skills: String,
        asn: String,
        fee_rate_bps: u16,
    ) -> Result<()> {
        registry::register_agent(ctx, name, skills, asn, fee_rate_bps)
    }

    pub fn register_agent_for(
        ctx: Context<RegisterAgentFor>,
        agent_wallet: Pubkey,
        name: String,
        skills: String,
        asn: String,
        fee_rate_bps: u16,
    ) -> Result<()> {
        registry::register_agent_for(ctx, agent_wallet, name, skills, asn, fee_rate_bps)
    }

    pub fn update_skills(ctx: Context<UpdateSkills>, new_skills: String) -> Result<()> {
        registry::update_skills(ctx, new_skills)
    }

    pub fn deactivate_agent(ctx: Context<DeactivateAgent>) -> Result<()> {
        registry::deactivate_agent(ctx)
    }

    pub fn update_credit(ctx: Context<UpdateCredit>, credit_score: u16, trust_score: u8) -> Result<()> {
        registry::update_credit(ctx, credit_score, trust_score)
    }

    // ── Task board ────────────────────────────────────────────────

    pub fn post_task(
        ctx: Context<PostTask>,
        title: String,
        description: String,
        required_skills: String,
        deadline: i64,
        budget_lamports: u64,
    ) -> Result<()> {
        task_board::post_task(ctx, title, description, required_skills, deadline, budget_lamports)
    }

    pub fn expire_task(ctx: Context<ExpireTask>) -> Result<()> {
        task_board::expire_task(ctx)
    }

    pub fn claim_task(ctx: Context<ClaimTask>) -> Result<()> {
        task_board::claim_task(ctx)
    }

    pub fn submit_delivery(ctx: Context<SubmitDelivery>, delivery_hash: [u8; 32]) -> Result<()> {
        task_board::submit_delivery(ctx, delivery_hash)
    }

    pub fn approve_delivery(ctx: Context<ApproveDelivery>) -> Result<()> {
        task_board::approve_delivery(ctx)
    }

    pub fn dispute_delivery(ctx: Context<DisputeDelivery>) -> Result<()> {
        task_board::dispute_delivery(ctx)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, agent_bps: u16) -> Result<()> {
        task_board::resolve_dispute(ctx, agent_bps)
    }

    // ── Governance / slashing ─────────────────────────────────────

    pub fn create_penalty_proposal(
        ctx: Context<CreatePenaltyProposal>,
        asn: String,
        amount: u16,
        reason: String,
    ) -> Result<()> {
        governance::create_penalty_proposal(ctx, asn, amount, reason)
    }

    pub fn resolve_penalty_proposal(ctx: Context<ResolvePenaltyProposal>, approve: bool) -> Result<()> {
        governance::resolve_penalty_proposal(ctx, approve)
    }

    // ── Treasury ──────────────────────────────────────────────────

    pub fn initialize_treasury(ctx: Context<InitializeTreasury>) -> Result<()> {
        treasury::initialize_treasury(ctx)
    }

    pub fn set_agent_address(ctx: Context<SetAgentAddress>, agent_address: Pubkey) -> Result<()> {
        treasury::set_agent_address(ctx, agent_address)
    }

    pub fn deposit_revenue(ctx: Context<DepositRevenue>, amount: u64) -> Result<()> {
        treasury::deposit_revenue(ctx, amount)
    }

    pub fn withdraw(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        treasury::withdraw(ctx, amount)
    }
}
