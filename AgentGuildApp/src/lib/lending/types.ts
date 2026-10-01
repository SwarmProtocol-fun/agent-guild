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
 * "pending_disbursement" — a pool committed the liquidity but the real USDC
 * transfer to the borrower hasn't been confirmed on-chain yet (an admin has
 * to send it from the treasury and confirm). "pending" is the solo-loan
 * equivalent: posted to the marketplace, awaiting a lender to send funds
 * directly and confirm.
 */
export type LoanStatus = "pending" | "pending_disbursement" | "active" | "repaid" | "defaulted";

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
    /** Locked security for "trust" loans, derived from the borrower's escrow ratio. 0 for unsecured. */
    collateralUsd: number;

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
}

export interface LendingPool {
    id: string;
    name: string;
    description?: string;
    /** Vault-style share accounting — sharePrice = (availableLiquidityUsd + totalLentUsd) / totalShares */
    totalShares: number;
    availableLiquidityUsd: number;
    totalLentUsd: number;
    totalDepositedUsd: number;
    totalInterestEarnedUsd: number;
    totalDefaultedUsd: number;
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
}

/** Audit trail of verified on-chain deposits into a pool. */
export interface PoolDepositRecord {
    id: string;
    poolId: string;
    walletAddress: string;
    amountUsd: number;
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
