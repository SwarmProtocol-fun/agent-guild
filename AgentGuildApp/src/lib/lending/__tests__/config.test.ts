import { describe, it, expect, afterEach } from "vitest";
import { lendingLimits, assertCanOpenPosition, isWalletAllowed } from "../config";

const env = { ...process.env };
afterEach(() => {
    process.env = { ...env };
});

describe("lendingLimits", () => {
    it("defaults to open and uncapped", () => {
        for (const k of ["LENDING_PAUSED", "LENDING_ALLOWLIST", "LENDING_MAX_POOL_TVL_USD", "LENDING_MAX_DEPOSIT_PER_WALLET_USD", "LENDING_MAX_LOAN_USD", "LENDING_DEFAULT_GRACE_DAYS", "LENDING_PENDING_EXPIRY_DAYS"]) {
            delete process.env[k];
        }
        const l = lendingLimits();
        expect(l.paused).toBe(false);
        expect(l.allowlist).toBeNull();
        expect(l.maxPoolTvlUsd).toBeNull();
        expect(l.maxLoanUsd).toBeNull();
        expect(l.defaultGraceDays).toBe(3);
        expect(l.pendingExpiryDays).toBe(7);
    });

    it("parses caps and ignores garbage", () => {
        process.env.LENDING_MAX_POOL_TVL_USD = "25000";
        process.env.LENDING_MAX_LOAN_USD = "not-a-number";
        const l = lendingLimits();
        expect(l.maxPoolTvlUsd).toBe(25000);
        expect(l.maxLoanUsd).toBeNull();
    });
});

describe("assertCanOpenPosition", () => {
    it("blocks everything while paused", () => {
        process.env.LENDING_PAUSED = "true";
        expect(() => assertCanOpenPosition(lendingLimits(), "AnyWallet111")).toThrow(/paused/);
    });

    it("enforces the allowlist when set", () => {
        process.env.LENDING_ALLOWLIST = "WalletA111, WalletB222";
        const l = lendingLimits();
        expect(isWalletAllowed(l, "WalletA111")).toBe(true);
        expect(isWalletAllowed(l, "WalletC333")).toBe(false);
        expect(isWalletAllowed(l, null)).toBe(false);
        expect(() => assertCanOpenPosition(l, "WalletC333")).toThrow(/allowlist/);
        expect(() => assertCanOpenPosition(l, "WalletB222")).not.toThrow();
    });
});
