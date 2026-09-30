use anchor_lang::prelude::*;

use crate::errors::AgentGuildError;
use crate::state::{AgentAccount, GuildConfig, PenaltyProposal, ProposalStatus, MAX_ASN_LEN, MAX_REASON_LEN};

// ── Create penalty proposal (anyone can propose) ─────────────────────

#[derive(Accounts)]
#[instruction(asn: String, amount: u16, reason: String)]
pub struct CreatePenaltyProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [b"guild-config"], bump = config.bump)]
    pub config: Account<'info, GuildConfig>,
    pub agent_account: Account<'info, AgentAccount>,
    #[account(
        init,
        payer = proposer,
        space = PenaltyProposal::SIZE,
        seeds = [b"proposal", config.proposal_counter.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, PenaltyProposal>,
    pub system_program: Program<'info, System>,
}

pub fn create_penalty_proposal(
    ctx: Context<CreatePenaltyProposal>,
    asn: String,
    amount: u16,
    reason: String,
) -> Result<()> {
    require!(asn.len() <= MAX_ASN_LEN, AgentGuildError::AsnTooLong);
    require!(reason.len() <= MAX_REASON_LEN, AgentGuildError::ReasonTooLong);

    let proposal_id = ctx.accounts.config.proposal_counter;
    ctx.accounts.config.proposal_counter = proposal_id.checked_add(1).ok_or(AgentGuildError::Overflow)?;

    let now = Clock::get()?.unix_timestamp;
    let proposal = &mut ctx.accounts.proposal;
    proposal.proposal_id = proposal_id;
    proposal.asn = asn;
    proposal.agent = ctx.accounts.agent_account.wallet;
    proposal.amount = amount;
    proposal.reason = reason;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.status = ProposalStatus::Pending;
    proposal.created_at = now;
    proposal.resolved_at = 0;
    proposal.bump = ctx.bumps.proposal;

    Ok(())
}

// ── Resolve penalty proposal (authority-only) ────────────────────────

#[derive(Accounts)]
pub struct ResolvePenaltyProposal<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(mut)]
    pub proposal: Account<'info, PenaltyProposal>,
    #[account(
        mut,
        seeds = [b"agent", proposal.agent.as_ref()],
        bump = agent_account.bump
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

pub fn resolve_penalty_proposal(ctx: Context<ResolvePenaltyProposal>, approve: bool) -> Result<()> {
    {
        let proposal = &ctx.accounts.proposal;
        require!(proposal.status == ProposalStatus::Pending, AgentGuildError::ProposalNotPending);
    }

    if approve {
        let amount = ctx.accounts.proposal.amount;
        let agent = &mut ctx.accounts.agent_account;
        agent.credit_score = agent.credit_score.saturating_sub(amount).max(300);
        agent.last_updated = Clock::get()?.unix_timestamp;
    }

    let now = Clock::get()?.unix_timestamp;
    let proposal = &mut ctx.accounts.proposal;
    proposal.status = if approve { ProposalStatus::Approved } else { ProposalStatus::Rejected };
    proposal.resolved_at = now;

    Ok(())
}
