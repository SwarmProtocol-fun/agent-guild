use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::AgentGuildError;
use crate::state::{GuildConfig, TreasuryAccount};

pub const COMPUTE_BPS: u64 = 5_000;
pub const GROWTH_BPS: u64 = 3_000;
pub const BPS_DENOMINATOR: u64 = 10_000;

// ── Initialize treasury ──────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == payer.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(
        init,
        payer = payer,
        space = TreasuryAccount::SIZE,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: Account<'info, TreasuryAccount>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_treasury(ctx: Context<InitializeTreasury>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    treasury.authority = ctx.accounts.config.authority;
    treasury.agent_address = Pubkey::default();
    treasury.compute_balance = 0;
    treasury.growth_balance = 0;
    treasury.reserve_balance = 0;
    treasury.bump = ctx.bumps.treasury;
    Ok(())
}

// ── Set agent address (authority-only) ───────────────────────────────

#[derive(Accounts)]
pub struct SetAgentAddress<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryAccount>,
}

pub fn set_agent_address(ctx: Context<SetAgentAddress>, agent_address: Pubkey) -> Result<()> {
    ctx.accounts.treasury.agent_address = agent_address;
    Ok(())
}

// ── Deposit revenue ───────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositRevenue<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryAccount>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_revenue(ctx: Context<DepositRevenue>, amount: u64) -> Result<()> {
    require!(amount > 0, AgentGuildError::InvalidDepositAmount);

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        ),
        amount,
    )?;

    let compute_share = amount * COMPUTE_BPS / BPS_DENOMINATOR;
    let growth_share = amount * GROWTH_BPS / BPS_DENOMINATOR;
    // Reserve absorbs any bps-rounding dust so the buckets always sum to `amount`.
    let reserve_share = amount - compute_share - growth_share;

    let treasury = &mut ctx.accounts.treasury;
    treasury.compute_balance = treasury
        .compute_balance
        .checked_add(compute_share)
        .ok_or(AgentGuildError::Overflow)?;
    treasury.growth_balance = treasury
        .growth_balance
        .checked_add(growth_share)
        .ok_or(AgentGuildError::Overflow)?;
    treasury.reserve_balance = treasury
        .reserve_balance
        .checked_add(reserve_share)
        .ok_or(AgentGuildError::Overflow)?;

    Ok(())
}

// ── Withdraw (authority-only) ─────────────────────────────────────────

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, TreasuryAccount>,
    /// CHECK: arbitrary payout destination, authority-controlled.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
}

pub fn withdraw(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    let total = treasury.compute_balance + treasury.growth_balance + treasury.reserve_balance;
    require!(amount <= total, AgentGuildError::InsufficientTreasuryBalance);

    // Draw down deterministically: reserve first, then growth, then compute.
    let mut remaining = amount;
    let from_reserve = remaining.min(treasury.reserve_balance);
    treasury.reserve_balance -= from_reserve;
    remaining -= from_reserve;
    let from_growth = remaining.min(treasury.growth_balance);
    treasury.growth_balance -= from_growth;
    remaining -= from_growth;
    let from_compute = remaining.min(treasury.compute_balance);
    treasury.compute_balance -= from_compute;
    remaining -= from_compute;
    require!(remaining == 0, AgentGuildError::InsufficientTreasuryBalance);

    **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.to.to_account_info().try_borrow_mut_lamports()? += amount;
    Ok(())
}
