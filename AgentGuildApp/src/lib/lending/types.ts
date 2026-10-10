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
import type { LendingAsset } from "./assets";

export type { LendingAsset };

/*
 * Amount fields (principal, availableLiquidity, amount, ...) are in the
 * record's `asset` units (USDC, SOL or ETH); a record without `asset` is USDC.
 * Fields ending in `Usd` (principalUsdValue, tier limits) are real dollars.
 */

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
 * "liquidating" — a collateral-market loan whose loan-to-value crossed the
 * liquidation threshold (or that went overdue): its collateral is seized and
 * awaits sale. "liquidated" — the sale's proceeds covered the debt (any
 * shortfall makes it "defaulted" instead).
 */
export type LoanStatus =
    | "pending_collateral" | "pending" | "pending_disbursement" | "active" | "repaid" | "defaulted" | "cancelled"
    | "liquidating" | "liquidated";

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
    /** What was lent — the pool's asset. Solo loans are always USDC. Absent = USDC. */
    asset?: LendingAsset;
    /** Collateral-market loans: the asset `collateral` is posted in. Absent = same as `asset`. */
    collateralAsset?: LendingAsset;
    /** Collateral-market loans: liquidation threshold copied from the pool at request time. */
    liquidationLtvBps?: number;
    liquidationStartedAt?: number;
    /** Collateral price (USD) and loan-to-value when liquidation started. */
    liquidationPriceUsd?: number;
    liquidationLtvAtStart?: number;
    liquidationReason?: "ltv" | "overdue" | "admin";
    /** USDC the seized collateral sold for, and the transfer that delivered it. */
    liquidationProceeds?: number;
    liquidationTxSig?: string;
    liquidatedAt?: number;
    /** USD value of the principal at request time (non-USDC loans), for limits and credit history. */
    principalUsdValue?: number;
    /** Set once a solo loan is funded (source === "solo") */
    lenderWalletAddress?: string;
    status: LoanStatus;

    principal: number;
    principalRemaining: number;
    principalPaid: number;
    interestRateBps: number;
    interestAccrued: number;
    interestPaid: number;
    /**
     * Collateral a "trust" loan requires, derived from the borrower's escrow
     * ratio (0 for unsecured). Posted to the treasury before funding and
     * tracked by collateralStatus. Loans created before collateral collection
     * existed have no collateralStatus and never held any.
     */
    collateral: number;
    collateralStatus?: CollateralStatus;
    collateralTxSig?: string;
    /** Wallet that posted the collateral — where it is returned. */
    collateralPostedByWallet?: string;
    /** Set when the collateral is being posted straight from the agent's own wallet (lib/lending/agent-collateral.ts). */
    agentCollateralSend?: AgentWalletSend;
    /** Latest collateral top-up / repayment sent from the agent's own wallet (one in flight at a time). */
    agentTopUpSend?: AgentWalletSend;
    agentRepaySend?: AgentWalletSend;
    /** Pool loans under the auto-disburse limit: the platform payout wallet sending the principal (lib/lending/auto-disburse.ts). */
    autoDisburseSend?: AgentWalletSend;
    /** Collateral-market loans: collateral added after posting (already included in `collateral`). */
    collateralTopUps?: CollateralTopUp[];
    /** True once this pool loan's principal/interest is included in the pool's accruingPerYear / interestReceivable. */
    poolAccrualTracked?: boolean;
    cancelReason?: string;
    cancelledAt?: number;
    /** USDC the borrower sent beyond the total owed — owed back to them. */
    overpaymentOwed?: number;

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
    amount: number;
    principalPortion: number;
    interestPortion: number;
    remainingBalance: number;
    paidAt: number;
    paidByWallet?: string;
    /** On-chain signature verified for this repayment. */
    txSig?: string;
    /** Portion of the on-chain transfer beyond what was owed; needs a manual refund. */
    excess?: number;
    refundStatus?: "pending" | "refunded";
}

export interface LendingPool {
    id: string;
    name: string;
    description?: string;
    /** The single asset this pool takes, lends and pays out. Absent = USDC. */
    asset?: LendingAsset;
    /**
     * Set on collateral markets (e.g. USDC/ETH): borrowers lock this asset and
     * borrow `asset` against it, up to maxLtvBps of its value; the sweep starts
     * liquidation at liquidationLtvBps.
     */
    collateralAsset?: LendingAsset;
    maxLtvBps?: number;
    liquidationLtvBps?: number;
    /** Vault-style share accounting — sharePrice = (availableLiquidity + totalLent) / (totalShares - pendingWithdrawalShares) */
    totalShares: number;
    availableLiquidity: number;
    totalLent: number;
    totalDeposited: number;
    totalInterestEarned: number;
    totalDefaulted: number;
    /** USD moved out of availableLiquidity for withdrawals awaiting a confirmed payout. */
    pendingWithdrawal?: number;
    /** Shares still in totalShares but already promised to pending withdrawals. */
    pendingWithdrawalShares?: number;
    /**
     * Interest accounting for active pool loans, so the share price reflects
     * interest as it accrues rather than jumping when it's repaid:
     * accruingPerYear = Σ principalRemaining × APR over active loans,
     * interestReceivable = accrued-but-unpaid interest as of interestAccrualAt.
     */
    accruingPerYear?: number;
    interestReceivable?: number;
    interestAccrualAt?: number;
    createdAt: unknown;
    createdBy?: string;
}

export interface PoolPosition {
    id: string;
    poolId: string;
    walletAddress: string;
    shares: number;
    principalDeposited: number;
    principalWithdrawn: number;
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
    /** The signed-in account that owns the position (may be an EVM address). */
    walletAddress: string;
    /** Wallet the treasury pays (Solana, or Ethereum for the ETH pool). Absent on older requests, which pay walletAddress. */
    payoutWalletAddress?: string;
    /** The pool's asset, copied for display. Absent = USDC. */
    asset?: LendingAsset;
    amount: number;
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
export interface PoolDepositRecord {
    id: string;
    poolId: string;
    walletAddress: string;
    amount: number;
    /** The pool's asset; omitted for USDC. */
    asset?: LendingAsset;
    /** Legacy: devnet SOL credited into the USDC pool at a fixed rate, before per-asset pools. */
    lamports?: number;
    /** Part of the transfer that wasn't credited (beta cap / paused / not allowlisted) and was queued for refund. */
    refunded?: number;
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
    amount: number;
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
    | "funding_refund"         // borrower → lender: solo funding that arrived after the loan was already funded or cancelled
    | "liquidation_surplus"    // treasury → borrower: liquidation proceeds beyond the debt
    | "bond_refund";           // treasury → bond poster: an agent's anti-sybil bond, on retirement (agent-bond.ts)

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
    amount: number;
    /** Asset to send (and verify). Absent = USDC. */
    asset?: LendingAsset;
    status: "pending" | "paid";
    loanId?: string;
    poolId?: string;
    repaymentId?: string;
    /** bond_refund: the retired agent whose bond this returns. */
    agentId?: string;
    reason: string;
    createdAt: number;
    paidAt?: number;
    txSig?: string;
}

/**
 * One transfer from the borrowing agent's custodial wallet
 * (lib/lending/agent-wallet-send.ts). "sending" = claimed, not broadcast;
 * "sent" = broadcast, awaiting finality; "posted" = verified and credited;
 * "returned" = landed after the loan stopped taking it, queued back;
 * "failed" = see `error` (with no txSig, nothing moved).
 */
export type AgentSendStatus = "sending" | "sent" | "posted" | "returned" | "failed";

export interface AgentWalletSend {
    walletId: string;
    wallet: string;
    asset: "usdc" | "sol" | "eth";
    amount: number;
    /** Where it was sent (the treasury, or a solo lender for repayments). Absent on early collateral sends (treasury). */
    recipient?: string;
    txSig: string | null;
    status: AgentSendStatus;
    startedAt: number;
    sentAt?: number;
    /** Wallet address of the person who triggered it. */
    requestedBy: string;
    error: string | null;
}

/** @deprecated use AgentWalletSend */
export type AgentCollateralSend = AgentWalletSend;
export type AgentCollateralStatus = AgentSendStatus;

/** Collateral added to an active collateral-market loan after it was posted. */
export interface CollateralTopUp {
    amount: number;
    txSig: string;
    at: number;
    byWallet: string;
}
