use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::AgentGuildError;
use crate::state::{
    GuildConfig, TaskAccount, TaskStatus, MAX_DESCRIPTION_LEN, MAX_REQUIRED_SKILLS_LEN, MAX_TITLE_LEN,
};

// ── Post task ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(title: String, description: String, required_skills: String, deadline: i64, budget_lamports: u64)]
pub struct PostTask<'info> {
    #[account(mut)]
    pub poster: Signer<'info>,
    #[account(mut, seeds = [b"guild-config"], bump = config.bump)]
    pub config: Account<'info, GuildConfig>,
    #[account(
        init,
        payer = poster,
        space = TaskAccount::SIZE,
        seeds = [b"task", config.task_counter.to_le_bytes().as_ref()],
        bump
    )]
    pub task_account: Account<'info, TaskAccount>,
    pub system_program: Program<'info, System>,
}

pub fn post_task(
    ctx: Context<PostTask>,
    title: String,
    description: String,
    required_skills: String,
    deadline: i64,
    budget_lamports: u64,
) -> Result<()> {
    require!(title.len() <= MAX_TITLE_LEN, AgentGuildError::TitleTooLong);
    require!(description.len() <= MAX_DESCRIPTION_LEN, AgentGuildError::DescriptionTooLong);
    require!(
        required_skills.len() <= MAX_REQUIRED_SKILLS_LEN,
        AgentGuildError::RequiredSkillsTooLong
    );
    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, AgentGuildError::InvalidDeadline);
    require!(budget_lamports > 0, AgentGuildError::InvalidBudget);

    let task_id = ctx.accounts.config.task_counter;
    ctx.accounts.config.task_counter = task_id
        .checked_add(1)
        .ok_or(AgentGuildError::Overflow)?;

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.poster.to_account_info(),
                to: ctx.accounts.task_account.to_account_info(),
            },
        ),
        budget_lamports,
    )?;

    let task = &mut ctx.accounts.task_account;
    task.task_id = task_id;
    task.poster = ctx.accounts.poster.key();
    task.claimed_by = None;
    task.title = title;
    task.description = description;
    task.required_skills = required_skills;
    task.deadline = deadline;
    task.budget_lamports = budget_lamports;
    task.delivery_hash = None;
    task.status = TaskStatus::Open;
    task.created_at = now;
    task.bump = ctx.bumps.task_account;

    Ok(())
}

// ── Expire task (reclaim escrow for an unclaimed, past-deadline task) ──
//
// `post_task` pulls `budget_lamports` into escrow immediately. Before this
// instruction existed, a task nobody claimed before its `deadline` had no
// way back to its poster — the escrow was locked on the TaskAccount PDA
// forever (`TaskStatus::Expired` was declared but never reachable). This
// only covers the unclaimed case: once a task is `Claimed`, it's on the
// approve/dispute path instead, which is a separate, already-covered flow.

#[derive(Accounts)]
pub struct ExpireTask<'info> {
    /// Must be the original poster — they're the only one who can be a
    /// refund destination for their own escrow (mirrors the `address =`
    /// checks on `ApproveDelivery`/`ResolveDispute`'s payout accounts).
    #[account(mut, address = task_account.poster @ AgentGuildError::NotPoster)]
    pub poster: Signer<'info>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
}

pub fn expire_task(ctx: Context<ExpireTask>) -> Result<()> {
    {
        let task = &ctx.accounts.task_account;
        require!(task.status == TaskStatus::Open, AgentGuildError::TaskNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now > task.deadline, AgentGuildError::TaskNotExpired);
    }

    let budget = ctx.accounts.task_account.budget_lamports;
    **ctx.accounts.task_account.to_account_info().try_borrow_mut_lamports()? -= budget;
    **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += budget;

    ctx.accounts.task_account.status = TaskStatus::Expired;
    Ok(())
}

// ── Claim task ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimTask<'info> {
    pub claimant: Signer<'info>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
}

pub fn claim_task(ctx: Context<ClaimTask>) -> Result<()> {
    let task = &mut ctx.accounts.task_account;
    require!(task.status == TaskStatus::Open, AgentGuildError::TaskNotOpen);
    require!(
        task.poster != ctx.accounts.claimant.key(),
        AgentGuildError::CannotClaimOwnTask
    );
    // Once the deadline passes, an Open task can only go through
    // `expire_task`, not be claimed — otherwise a claim that lands right
    // after the deadline flips status to Claimed and blocks expiry forever,
    // since expire_task only accepts TaskStatus::Open.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= task.deadline, AgentGuildError::TaskDeadlinePassed);

    task.claimed_by = Some(ctx.accounts.claimant.key());
    task.status = TaskStatus::Claimed;
    Ok(())
}

// ── Submit delivery ───────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SubmitDelivery<'info> {
    pub claimant: Signer<'info>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
}

pub fn submit_delivery(ctx: Context<SubmitDelivery>, delivery_hash: [u8; 32]) -> Result<()> {
    let task = &mut ctx.accounts.task_account;
    require!(task.status == TaskStatus::Claimed, AgentGuildError::TaskNotClaimed);
    require!(
        task.claimed_by == Some(ctx.accounts.claimant.key()),
        AgentGuildError::NotClaimant
    );

    task.delivery_hash = Some(delivery_hash);
    Ok(())
}

// ── Approve delivery (pays out escrow) ───────────────────────────────

#[derive(Accounts)]
pub struct ApproveDelivery<'info> {
    #[account(mut)]
    pub poster: Signer<'info>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
    /// CHECK: must equal `task_account.claimed_by`; payout destination only.
    #[account(mut, address = task_account.claimed_by.unwrap_or_default())]
    pub claimant: UncheckedAccount<'info>,
}

pub fn approve_delivery(ctx: Context<ApproveDelivery>) -> Result<()> {
    {
        let task = &ctx.accounts.task_account;
        require!(task.poster == ctx.accounts.poster.key(), AgentGuildError::NotPoster);
        require!(task.status == TaskStatus::Claimed, AgentGuildError::TaskNotClaimed);
        require!(task.delivery_hash.is_some(), AgentGuildError::NoDeliverySubmitted);
    }

    let budget = ctx.accounts.task_account.budget_lamports;
    **ctx.accounts.task_account.to_account_info().try_borrow_mut_lamports()? -= budget;
    **ctx.accounts.claimant.to_account_info().try_borrow_mut_lamports()? += budget;

    ctx.accounts.task_account.status = TaskStatus::Completed;
    Ok(())
}

// ── Dispute delivery ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DisputeDelivery<'info> {
    pub poster: Signer<'info>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
}

pub fn dispute_delivery(ctx: Context<DisputeDelivery>) -> Result<()> {
    let task = &mut ctx.accounts.task_account;
    require!(task.poster == ctx.accounts.poster.key(), AgentGuildError::NotPoster);
    require!(task.status == TaskStatus::Claimed, AgentGuildError::TaskNotClaimed);

    task.status = TaskStatus::Disputed;
    Ok(())
}

// ── Resolve dispute (authority-only, splits escrow) ──────────────────

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(mut)]
    pub task_account: Account<'info, TaskAccount>,
    /// CHECK: must equal `task_account.poster`; payout destination only.
    #[account(mut, address = task_account.poster)]
    pub poster: UncheckedAccount<'info>,
    /// CHECK: must equal `task_account.claimed_by`; payout destination only.
    #[account(mut, address = task_account.claimed_by.unwrap_or_default())]
    pub claimant: UncheckedAccount<'info>,
}

pub fn resolve_dispute(ctx: Context<ResolveDispute>, agent_bps: u16) -> Result<()> {
    require!(agent_bps <= 10_000, AgentGuildError::InvalidSplitBps);
    {
        let task = &ctx.accounts.task_account;
        require!(task.status == TaskStatus::Disputed, AgentGuildError::TaskNotDisputed);
    }

    let budget = ctx.accounts.task_account.budget_lamports;
    let agent_share = (budget as u128 * agent_bps as u128 / 10_000u128) as u64;
    let poster_share = budget - agent_share;

    **ctx.accounts.task_account.to_account_info().try_borrow_mut_lamports()? -= budget;
    **ctx.accounts.claimant.to_account_info().try_borrow_mut_lamports()? += agent_share;
    **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += poster_share;

    ctx.accounts.task_account.status = TaskStatus::Resolved;
    Ok(())
}
