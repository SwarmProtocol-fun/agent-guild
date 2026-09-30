use anchor_lang::prelude::*;

#[error_code]
pub enum AgentGuildError {
    #[msg("Name exceeds maximum length")]
    NameTooLong,
    #[msg("Skills string exceeds maximum length")]
    SkillsTooLong,
    #[msg("ASN exceeds maximum length")]
    AsnTooLong,
    #[msg("Title exceeds maximum length")]
    TitleTooLong,
    #[msg("Description exceeds maximum length")]
    DescriptionTooLong,
    #[msg("Required skills exceeds maximum length")]
    RequiredSkillsTooLong,
    #[msg("Fee rate exceeds 10000 bps (100%)")]
    FeeRateTooHigh,
    #[msg("Task deadline must be in the future")]
    InvalidDeadline,
    #[msg("Task budget must be greater than zero")]
    InvalidBudget,
    #[msg("Task is not open")]
    TaskNotOpen,
    #[msg("Task is not claimed")]
    TaskNotClaimed,
    #[msg("Only the assigned agent can submit delivery")]
    NotClaimant,
    #[msg("Only the task poster can approve or dispute delivery")]
    NotPoster,
    #[msg("Task has no delivery submitted yet")]
    NoDeliverySubmitted,
    #[msg("Task is not disputed")]
    TaskNotDisputed,
    #[msg("Task deadline has not passed yet")]
    TaskNotExpired,
    #[msg("Task deadline has already passed; call expire_task instead")]
    TaskDeadlinePassed,
    #[msg("Cannot claim your own task")]
    CannotClaimOwnTask,
    #[msg("Agent split bps exceeds 10000")]
    InvalidSplitBps,
    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,
    #[msg("Withdrawal amount exceeds available treasury balance")]
    InsufficientTreasuryBalance,
    #[msg("Unauthorized: caller is not the program authority")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Reason exceeds maximum length")]
    ReasonTooLong,
    #[msg("Proposal is not pending")]
    ProposalNotPending,
}
