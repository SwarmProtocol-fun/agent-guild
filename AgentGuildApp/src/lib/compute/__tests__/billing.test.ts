import { describe, it, expect } from "vitest";
import {
  estimateProviderHourlyCost,
  estimateHourlyCost,
  estimateMonthlyCost,
  resolveMarkupPercent,
  calculateCustomerPrice,
} from "../pricing";
import type { PricingSettings, SizeKey } from "../types";

// ─── Helper ──────────────────────────────────────────────
function makeSettings(overrides?: Partial<PricingSettings>): PricingSettings {
  return {
    id: "test-settings",
    defaultMarkupPercent: 30,
    sizeOverrides: {},
    regionOverrides: {},
    providerOverrides: {},
    minimumPriceFloorCents: 1,
    promoOverride: null,
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// estimateProviderHourlyCost
// ═══════════════════════════════════════════════════════════════

describe("estimateProviderHourlyCost", () => {
  it("returns known costs for each size", () => {
    expect(estimateProviderHourlyCost("small")).toBe(8);
    expect(estimateProviderHourlyCost("medium")).toBe(16);
    expect(estimateProviderHourlyCost("large")).toBe(32);
    expect(estimateProviderHourlyCost("xl")).toBe(64);
  });

  it("falls back to small for unknown size", () => {
    expect(estimateProviderHourlyCost("unknown" as SizeKey)).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════
// resolveMarkupPercent
// ═══════════════════════════════════════════════════════════════

describe("resolveMarkupPercent", () => {
  it("uses default markup when no overrides", () => {
    const settings = makeSettings({ defaultMarkupPercent: 25 });
    expect(resolveMarkupPercent(settings, "small", "us-east", "stub")).toBe(25);
  });

  it("uses size override when present", () => {
    const settings = makeSettings({ sizeOverrides: { large: 50 } });
    expect(resolveMarkupPercent(settings, "large", "us-east", "stub")).toBe(50);
    // Other sizes still use default
    expect(resolveMarkupPercent(settings, "small", "us-east", "stub")).toBe(30);
  });

  it("uses region override when present", () => {
    const settings = makeSettings({ regionOverrides: { "eu-west": 40 } });
    expect(resolveMarkupPercent(settings, "small", "eu-west", "stub")).toBe(40);
  });

  it("uses provider override when present", () => {
    const settings = makeSettings({ providerOverrides: { e2b: 20 } });
    expect(resolveMarkupPercent(settings, "small", "us-east", "e2b")).toBe(20);
  });

  it("provider override takes precedence over size override", () => {
    const settings = makeSettings({
      sizeOverrides: { small: 50 },
      providerOverrides: { e2b: 15 },
    });
    expect(resolveMarkupPercent(settings, "small", "us-east", "e2b")).toBe(15);
  });

  it("uses promo override when not expired", () => {
    const settings = makeSettings({
      promoOverride: {
        percent: 10,
        expiresAt: new Date(Date.now() + 100_000),
      },
    });
    expect(resolveMarkupPercent(settings, "small", "us-east", "stub")).toBe(10);
  });

  it("ignores expired promo override", () => {
    const settings = makeSettings({
      defaultMarkupPercent: 30,
      promoOverride: {
        percent: 10,
        expiresAt: new Date(Date.now() - 100_000),
      },
    });
    expect(resolveMarkupPercent(settings, "small", "us-east", "stub")).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════
// calculateCustomerPrice
// ═══════════════════════════════════════════════════════════════

describe("calculateCustomerPrice", () => {
  it("applies markup correctly", () => {
    const result = calculateCustomerPrice(100, 30, 1);
    expect(result.customerPriceCents).toBe(130);
    expect(result.platformProfitCents).toBe(30);
  });

  it("rounds up fractional cents", () => {
    const result = calculateCustomerPrice(10, 33, 1);
    // 10 * 1.33 = 13.3 → ceil to 14
    expect(result.customerPriceCents).toBe(14);
    expect(result.platformProfitCents).toBe(4);
  });

  it("enforces minimum floor", () => {
    const result = calculateCustomerPrice(1, 10, 50);
    // 1 * 1.10 = 1.1 → ceil to 2, but floor is 50
    expect(result.customerPriceCents).toBe(50);
    expect(result.platformProfitCents).toBe(49);
  });

  it("returns zero profit when cost equals price", () => {
    const result = calculateCustomerPrice(100, 0, 1);
    expect(result.customerPriceCents).toBe(100);
    expect(result.platformProfitCents).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// estimateHourlyCost
// ═══════════════════════════════════════════════════════════════

describe("estimateHourlyCost", () => {
  it("uses default 30% markup when no settings provided", () => {
    // small = 8 cents raw, 8 * 1.3 = 10.4 → ceil 11
    expect(estimateHourlyCost("small")).toBe(11);
    // medium = 16 * 1.3 = 20.8 → ceil 21
    expect(estimateHourlyCost("medium")).toBe(21);
  });

  it("uses settings-based markup when provided", () => {
    const settings = makeSettings({ defaultMarkupPercent: 50 });
    // small = 8 * 1.50 = 12
    expect(estimateHourlyCost("small", settings)).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════
// estimateMonthlyCost
// ═══════════════════════════════════════════════════════════════

describe("estimateMonthlyCost", () => {
  it("multiplies hourly cost by hours per day x 30", () => {
    const hourly = estimateHourlyCost("small"); // 11 cents
    expect(estimateMonthlyCost("small", 8)).toBe(hourly * 8 * 30);
  });
});
