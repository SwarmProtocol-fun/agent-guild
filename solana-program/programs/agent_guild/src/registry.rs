use anchor_lang::prelude::*;

use crate::errors::AgentGuildError;
use crate::state::{AgentAccount, AsnRecord, GuildConfig, MAX_ASN_LEN, MAX_NAME_LEN, MAX_SKILLS_LEN};

const DEFAULT_CREDIT_SCORE: u16 = 680;
const DEFAULT_TRUST_SCORE: u8 = 50;
const MAX_FEE_RATE_BPS: u16 = 10_000;

fn validate_registration_inputs(name: &str, skills: &str, asn: &str, fee_rate_bps: u16) -> Result<()> {
    require!(name.len() <= MAX_NAME_LEN, AgentGuildError::NameTooLong);
    require!(skills.len() <= MAX_SKILLS_LEN, AgentGuildError::SkillsTooLong);
    require!(asn.len() <= MAX_ASN_LEN, AgentGuildError::AsnTooLong);
    require!(fee_rate_bps <= MAX_FEE_RATE_BPS, AgentGuildError::FeeRateTooHigh);
    Ok(())
}

// ── Initialize ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = GuildConfig::SIZE,
        seeds = [b"guild-config"],
        bump
    )]
    pub config: Account<'info, GuildConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.payer.key();
    config.task_counter = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}

// ── Register agent (self-service) ──────────────────────────────────────

#[derive(Accounts)]
#[instruction(name: String, skills: String, asn: String, fee_rate_bps: u16)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub agent_wallet: Signer<'info>,
    #[account(
        init,
        payer = agent_wallet,
        space = AgentAccount::SIZE,
        seeds = [b"agent", agent_wallet.key().as_ref()],
        bump
    )]
    pub agent_account: Account<'info, AgentAccount>,
    #[account(
        init,
        payer = agent_wallet,
        space = AsnRecord::SIZE,
        seeds = [b"asn", asn.as_bytes()],
        bump
    )]
    pub asn_record: Account<'info, AsnRecord>,
    pub system_program: Program<'info, System>,
}

pub fn register_agent(
    ctx: Context<RegisterAgent>,
    name: String,
    skills: String,
    asn: String,
    fee_rate_bps: u16,
) -> Result<()> {
    validate_registration_inputs(&name, &skills, &asn, fee_rate_bps)?;

    let now = Clock::get()?.unix_timestamp;
    let wallet = ctx.accounts.agent_wallet.key();

    let agent = &mut ctx.accounts.agent_account;
    agent.wallet = wallet;
    agent.name = name;
    agent.skills = skills;
    agent.asn = asn.clone();
    agent.fee_rate_bps = fee_rate_bps;
    agent.credit_score = DEFAULT_CREDIT_SCORE;
    agent.trust_score = DEFAULT_TRUST_SCORE;
    agent.active = true;
    agent.registered_at = now;
    agent.last_updated = now;
    agent.bump = ctx.bumps.agent_account;

    let asn_record = &mut ctx.accounts.asn_record;
    asn_record.asn = asn;
    asn_record.agent = wallet;
    asn_record.bump = ctx.bumps.asn_record;

    Ok(())
}

// ── Register agent for (platform-sponsored) ─────────────────────────────

#[derive(Accounts)]
#[instruction(agent_wallet: Pubkey, name: String, skills: String, asn: String, fee_rate_bps: u16)]
pub struct RegisterAgentFor<'info> {
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
        space = AgentAccount::SIZE,
        seeds = [b"agent", agent_wallet.as_ref()],
        bump
    )]
    pub agent_account: Account<'info, AgentAccount>,
    #[account(
        init,
        payer = payer,
        space = AsnRecord::SIZE,
        seeds = [b"asn", asn.as_bytes()],
        bump
    )]
    pub asn_record: Account<'info, AsnRecord>,
    pub system_program: Program<'info, System>,
}

pub fn register_agent_for(
    ctx: Context<RegisterAgentFor>,
    agent_wallet: Pubkey,
    name: String,
    skills: String,
    asn: String,
    fee_rate_bps: u16,
) -> Result<()> {
    validate_registration_inputs(&name, &skills, &asn, fee_rate_bps)?;

    let now = Clock::get()?.unix_timestamp;

    let agent = &mut ctx.accounts.agent_account;
    agent.wallet = agent_wallet;
    agent.name = name;
    agent.skills = skills;
    agent.asn = asn.clone();
    agent.fee_rate_bps = fee_rate_bps;
    agent.credit_score = DEFAULT_CREDIT_SCORE;
    agent.trust_score = DEFAULT_TRUST_SCORE;
    agent.active = true;
    agent.registered_at = now;
    agent.last_updated = now;
    agent.bump = ctx.bumps.agent_account;

    let asn_record = &mut ctx.accounts.asn_record;
    asn_record.asn = asn;
    asn_record.agent = agent_wallet;
    asn_record.bump = ctx.bumps.asn_record;

    Ok(())
}

// ── Update skills (agent-signed) ─────────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateSkills<'info> {
    pub agent_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [b"agent", agent_wallet.key().as_ref()],
        bump = agent_account.bump
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

pub fn update_skills(ctx: Context<UpdateSkills>, new_skills: String) -> Result<()> {
    require!(new_skills.len() <= MAX_SKILLS_LEN, AgentGuildError::SkillsTooLong);
    let agent = &mut ctx.accounts.agent_account;
    agent.skills = new_skills;
    agent.last_updated = Clock::get()?.unix_timestamp;
    Ok(())
}

// ── Deactivate agent (agent-signed) ──────────────────────────────────────

#[derive(Accounts)]
pub struct DeactivateAgent<'info> {
    pub agent_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [b"agent", agent_wallet.key().as_ref()],
        bump = agent_account.bump
    )]
    pub agent_account: Account<'info, AgentAccount>,
}

pub fn deactivate_agent(ctx: Context<DeactivateAgent>) -> Result<()> {
    let agent = &mut ctx.accounts.agent_account;
    agent.active = false;
    agent.last_updated = Clock::get()?.unix_timestamp;
    Ok(())
}

// ── Update credit (authority-only) ───────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateCredit<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"guild-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ AgentGuildError::Unauthorized
    )]
    pub config: Account<'info, GuildConfig>,
    #[account(mut)]
    pub agent_account: Account<'info, AgentAccount>,
}

pub fn update_credit(ctx: Context<UpdateCredit>, credit_score: u16, trust_score: u8) -> Result<()> {
    let agent = &mut ctx.accounts.agent_account;
    agent.credit_score = credit_score;
    agent.trust_score = trust_score;
    agent.last_updated = Clock::get()?.unix_timestamp;
    Ok(())
}
