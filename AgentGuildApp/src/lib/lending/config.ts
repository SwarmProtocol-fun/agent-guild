/**
 * Lending launch guards — env-driven limits for running the marketplace as a
 * capped beta. Every limit is optional; unset means unlimited. Repayments are
 * never blocked by any of these (a borrower must always be able to pay back).
 *
 *   LENDING_PAUSED=true                  — no new deposits, loans or offers
 *   LENDING_ALLOWLIST=walletA,walletB    — only these wallets may deposit, borrow or post offers
 *   LENDING_MAX_POOL_TVL_USD             — cap on a pool's total value
 *   LENDING_MAX_DEPOSIT_PER_WALLET_USD   — cap on one wallet's net deposits into a pool
 *   LENDING_MAX_LOAN_USD                 — cap on any single loan
 *   LENDING_DEFAULT_GRACE_DAYS           — days past due before the sweep defaults a loan (default 3)
 *   LENDING_PENDING_EXPIRY_DAYS          — days before an unfunded request is auto-cancelled (default 7)
 */
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

function num(name: string): number | null {
    const raw = process.env[name];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface LendingLimits {
    paused: boolean;
    allowlist: Set<string> | null;
    maxPoolTvlUsd: number | null;
    maxDepositPerWalletUsd: number | null;
    maxLoanUsd: number | null;
    defaultGraceDays: number;
    pendingExpiryDays: number;
}

export function lendingLimits(): LendingLimits {
    const list = (process.env.LENDING_ALLOWLIST || "")
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean)
        .map(canonicalizeWalletAddress);
    return {
        paused: process.env.LENDING_PAUSED === "true",
        allowlist: list.length > 0 ? new Set(list) : null,
        maxPoolTvlUsd: num("LENDING_MAX_POOL_TVL_USD"),
        maxDepositPerWalletUsd: num("LENDING_MAX_DEPOSIT_PER_WALLET_USD"),
        maxLoanUsd: num("LENDING_MAX_LOAN_USD"),
        defaultGraceDays: num("LENDING_DEFAULT_GRACE_DAYS") ?? 3,
        pendingExpiryDays: num("LENDING_PENDING_EXPIRY_DAYS") ?? 7,
    };
}

export function isWalletAllowed(limits: LendingLimits, wallet: string | undefined | null): boolean {
    if (!limits.allowlist) return true;
    return !!wallet && limits.allowlist.has(canonicalizeWalletAddress(wallet));
}

/**
 * Throws if new risk (a deposit, loan or offer) can't be opened right now.
 * Only call this BEFORE any money moves — never after a transfer has landed.
 */
export function assertCanOpenPosition(limits: LendingLimits, wallet: string | undefined | null): void {
    if (limits.paused) throw new Error("Lending is temporarily paused — no new deposits, loans or offers. Repayments still work.");
    if (!isWalletAllowed(limits, wallet)) throw new Error("Lending is in a closed beta and this wallet isn't on the allowlist yet.");
}
