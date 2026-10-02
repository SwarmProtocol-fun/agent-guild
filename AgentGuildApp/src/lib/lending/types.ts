/**
 * Lending Marketplace — Types
 *
 * Two funding paths:
 *   - "pool"  — community-pooled capital (lower risk/return, always-on liquidity via a share-price vault)
 *   - "solo"  — a single lender funds one loan directly (higher risk/return)
 *
 * Two underwriting kinds:
 *   - "trust"     — collateral-backed starter loan, required before an agent unlocks unsecured lending
 *   - "unsecured" — no collateral, gated behind a tier-scaled number of successfully repaid trust loans
 */

import type { PolicyTierName } from "@/lib/credit-policy";

export type LoanKind = "trust" | "unsecured";
export type LoanSource = "pool" | "solo";
/**
 * "pending_collateral" — a trust loan waiting for the borrower to post its
 * collateral to the treasury (verified on-chain) before it can be funded.
 * "pending_disbursement" — a pool committed the liquidity but the real USDC
 * transfer to the borrower hasn't been confirmed on-chain yet (an admin has
 * to send it from the treasury and confirm). "pending" is the solo-loan
 * equivalent: posted to the marketplace, awaiting a lender to send funds
 * directly and confirm. "cancelled" — withdrawn or expired before it was
 * ever funded.
 */
export type LoanStatus = "pending_collateral" | "pending" | "pending_disbursement" | "active" | "repaid" | "defaulted" | "cancelled";

/**
 * Lifecycle of a trust loan's collateral, which is held in the lending
 * treasury: "awaiting" → "held" once verified on-chain, then
 * "return_pending" → "returned" on repayment/cancellation, or "seized" on
 * default. "none" for unsecured loans.
 */
export type CollateralStatus = "none" | "awaiting" | "held" | "return_pending" | "returned" | "seized";

export interface Loan {
    id: string;
    borrowerAgentId: string;
    borrowerOrgId: string;
    borrowerWalletAddress?: string;
    /** Wallet of the org member who submitted the request (for audit; the org itself is the borrower of record). */
    requestedByWallet?: string;
    kind: LoanKind;
    source: LoanSource;
    /** Set when source === "pool" */
    poolId?: string;
    /** Set once a solo loan is funded (source === "solo") */
    lenderWalletAddress?: string;
    status: LoanStatus;

    principalUsd: number;
    principalRemainingUsd: number;
    principalPaidUsd: number;
    interestRateBps: number;
    interestAccruedUsd: number;
    interestPaidUsd: number;
    /**
     * Collateral a "trust" loan requires, derived from the borrower's escrow
     * ratio (0 for unsecured). Posted to the treasury before funding and
     * tracked by collateralStatus. Loans created before collateral collection
     * existed have no collateralStatus and never held any.
     */
    collateralUsd: number;
    collateralStatus?: CollateralStatus;
    collateralTxSig?: string;
    /** Wallet that posted the collateral — where it is returned. */
    collateralPostedByWallet?: string;
    /** True once this pool loan's principal/interest is included in the pool's accruingUsdPerYear / interestReceivableUsd. */
    poolAccrualTracked?: boolean;
    cancelReason?: string;
    cancelledAt?: number;
    /** USDC the borrower sent beyond the total owed — owed back to them. */
    overpaymentOwedUsd?: number;

    termDays: number;
    requestedAt: number;
    originatedAt?: number;
    dueAt?: number;
    lastAccrualAt?: number;
    repaidAt?: number;
    defaultedAt?: number;

    policyTierAtOrigination: PolicyTierName;
    creditScoreAtOrigination: number;
    purpose?: string;
    /** On-chain signature that funded this loan's principal (treasury or solo lender -> borrower). */
    disbursementTxSig?: string;
    /** Set when this loan originated from accepting a LoanOffer. */
    offerId?: string;
    /** Set alongside offerId — only this wallet may fund the loan via fundLoanSolo(), since its lender pre-committed to these terms. */
    reservedLenderWallet?: string;
}

export interface LoanRepayment {
    id: string;
    loanId: string;
    amountUsd: number;
    principalPortionUsd: number;
    interestPortionUsd: number;
    remainingBalanceUsd: number;
    paidAt: number;
    paidByWallet?: string;
    /** On-chain signature verified for this repayment. */
    txSig?: string;
    /** Portion of the on-chain transfer beyond what was owed; needs a manual refund. */
    excessUsd?: number;
    refundStatus?: "pending" | "refunded";
}

export interface LendingPool {
    id: string;
    name: string;
    description?: string;
    /** Vault-style share accounting — sharePrice = (availableLiquidityUsd + totalLentUsd) / (totalShares - pendingWithdrawalShares) */
    totalShares: number;
    availableLiquidityUsd: number;
    totalLentUsd: number;
    totalDepositedUsd: number;
    totalInterestEarnedUsd: number;
    totalDefaultedUsd: number;
    /** USD moved out of availableLiquidityUsd for withdrawals awaiting a confirmed payout. */
    pendingWithdrawalUsd?: number;
    /** Shares still in totalShares but already promised to pending withdrawals. */
    pendingWithdrawalShares?: number;
    /**
     * Interest accounting for active pool loans, so the share price reflects
     * interest as it accrues rather than jumping when it's repaid:
     * accruingUsdPerYear = Σ principalRemaining × APR over active loans,
     * interestReceivableUsd = accrued-but-unpaid interest as of interestAccrualAt.
     */
    accruingUsdPerYear?: number;
    interestReceivableUsd?: number;
    interestAccrualAt?: number;
    createdAt: unknown;
    createdBy?: string;
}

export interface PoolPosition {
    id: string;
    poolId: string;
    walletAddress: string;
    shares: number;
    principalDepositedUsd: number;
    principalWithdrawnUsd: number;
    /** Shares locked in this wallet's pending withdrawal requests. */
    pendingWithdrawalShares?: number;
    createdAt: unknown;
    updatedAt: unknown;
}

export type PoolWithdrawalStatus = "pending_payout" | "paid" | "cancelled";

/**
 * A lender's withdrawal, locked in at request time (amount + shares to burn)
 * so a later share-price move can't change what they're owed. An admin pays
 * it out from the treasury wallet by hand and confirms with the signature;
 * the share burn only happens once that's verified on-chain.
 */
export interface PoolWithdrawalRequest {
    id: string;
    poolId: string;
    walletAddress: string;
    amountUsd: number;
    sharesToBurn: number;
    status: PoolWithdrawalStatus;
    requestedAt: number;
    txSig?: string;
    paidAt?: number;
    cancelledAt?: number;
    /**
     * True when the request reserved its liquidity and shares at creation.
     * Requests created before reservation existed lack this and settle the
     * old way on confirm.
     */
    reserved?: boolean;
}

/** Audit trail of verified on-chain deposits into a pool. */
/**
 * What a pool deposit was paid in. "sol" (native SOL) is devnet-only test
 * liquidity, valued at a fixed SOL→USD rate — the pool ledger itself stays USD.
 */
export type DepositAsset = "usdc" | "sol";

export interface PoolDepositRecord {
    id: string;
    poolId: string;
    walletAddress: string;
    amountUsd: number;
    /** Omitted for USDC (the default). */
    asset?: DepositAsset;
    /** Native SOL deposits only: lamports actually received by the treasury. */
    lamports?: number;
    /** Part of the transfer that wasn't credited (beta cap / paused / not allowlisted) and was queued for refund. */
    refundedUsd?: number;
    txSig: string;
    depositedAt: number;
}

export type LoanOfferStatus = "open" | "withdrawn" | "fulfilled";

/**
 * A lender-initiated standing offer to fund a solo loan on pre-agreed terms.
 * The inverse of a borrower's solo loan request: here the lender posts terms
 * first, and a borrower accepts one (subject to their own eligibility), which
 * creates a "pending" solo Loan reserved for that lender to fund (see
 * Loan.reservedLenderWallet).
 */
export interface LoanOffer {
    id: string;
    lenderWalletAddress: string;
    kind: LoanKind;
    /** Maximum principal the lender will fund at these terms. */
    amountUsd: number;
    rateBps: number;
    termDays: number;
    note?: string;
    status: LoanOfferStatus;
    createdAt: number;
    acceptedLoanId?: string;
    acceptedAt?: number;
    withdrawnAt?: number;
}

export interface KindEligibility {
    eligible: boolean;
    maxAmountUsd: number;
    rateBps: number;
    reason?: string;
}

export interface EligibilitySummary {
    policyTier: PolicyTierName;
    creditScore: number;
    completedTrustLoans: number;
    completedUnsecuredLoans: number;
    trustLoansRequiredForUnsecured: number;
    activeLoanCount: number;
    hasUnresolvedDefault: boolean;
    trust: KindEligibility;
    unsecured: KindEligibility;
}

export type LendingPayoutKind =
    | "collateral_return"      // treasury → borrower: collateral back after repayment, cancellation, or default excess
    | "collateral_to_lender"   // treasury → solo lender: seized collateral on default
    | "overpayment_refund"     // lender/treasury → borrower: paid beyond the balance
    | "repayment_refund"       // lender/treasury → payer: repayment that arrived after the loan closed
    | "deposit_refund"         // treasury → lender: deposit beyond the beta caps / while paused
    | "funding_refund";        // borrower → lender: solo funding that arrived after the loan was already funded or cancelled

/**
 * A money movement the lending ledger owes but can't execute itself (no
 * signing key is held anywhere in this app). Whoever controls `fromWallet` —
 * a platform admin for the treasury, or a solo lender for an overpayment that
 * landed in their wallet — sends it and confirms with the signature, which is
 * verified on-chain before the payout is marked paid.
 */
export interface LendingPayout {
    id: string;
    kind: LendingPayoutKind;
    fromWallet: string;
    toWallet: string;
    amountUsd: number;
    status: "pending" | "paid";
    loanId?: string;
    poolId?: string;
    repaymentId?: string;
    reason: string;
    createdAt: number;
    paidAt?: number;
    txSig?: string;
}
