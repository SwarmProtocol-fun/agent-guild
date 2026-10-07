import { describe, it, expect, vi } from "vitest";
import { fakeFieldValue } from "./fake-firestore";

vi.mock("firebase-admin/firestore", () => ({ FieldValue: fakeFieldValue }));

import { normalizeLegacy, legacyMigrationUpdate, hasLegacyFields, LEGACY_FIELDS } from "../legacy-fields";

describe("legacy field mapping", () => {
    it("maps old names to new ones on read and leaves migrated docs untouched", () => {
        const legacy = { principalUsd: 100, principalRemainingUsd: 40, collateralUsd: 50, status: "active" };
        expect(normalizeLegacy("loans", legacy)).toEqual({ principal: 100, principalRemaining: 40, collateral: 50, status: "active" });
        const migrated = { principal: 100, status: "active" };
        expect(normalizeLegacy("loans", migrated)).toBe(migrated);
        expect(hasLegacyFields("loans", migrated)).toBe(false);
    });

    it("sums running totals found under both names, prefers the new name otherwise", () => {
        // An older deployment incremented the old name after migration.
        const pool = { availableLiquidity: 300, availableLiquidityUsd: 50, accruingPerYear: 12, accruingUsdPerYear: 99 };
        expect(normalizeLegacy("lendingPools", pool)).toMatchObject({ availableLiquidity: 350, accruingPerYear: 12 });
    });

    it("builds an update that writes new names and deletes old ones", () => {
        const update = legacyMigrationUpdate("lendingPayouts", { amountUsd: 7, status: "pending" })!;
        expect(update.amount).toBe(7);
        expect(Object.getOwnPropertySymbols(update.amountUsd as object)).toHaveLength(1); // delete sentinel
        expect(update).not.toHaveProperty("status");
        expect(legacyMigrationUpdate("lendingPayouts", { amount: 7 })).toBeNull();
    });

    it("never maps a real-dollar field", () => {
        const all = Object.values(LEGACY_FIELDS).flatMap((m) => Object.keys(m));
        expect(all).not.toContain("principalUsdValue");
        expect(all.every((k) => k.endsWith("Usd") || k.endsWith("UsdPerYear"))).toBe(true);
    });
});
