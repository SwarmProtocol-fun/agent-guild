/**
 * Agent Guild Compute — Pure Pricing Math
 *
 * No Firestore dependency — safe to import from client components.
 * Split out of billing.ts because billing.ts also pulls in the
 * Admin-SDK-backed ./firestore module, which cannot be bundled client-side.
 */

import type { SizeKey, Region, ProviderKey, PricingSettings } from "./types";
import { PROVIDER_HOURLY_COSTS } from "./types";

export function resolveMarkupPercent(
  settings: PricingSettings,
  sizeKey: SizeKey,
  region: Region,
  provider: string,
): number {
  // Check promo override first (if not expired)
  if (settings.promoOverride) {
    const expires = settings.promoOverride.expiresAt;
    if (!expires || expires.getTime() > Date.now()) {
      return settings.promoOverride.percent;
    }
  }

  // Provider-specific override
  if (settings.providerOverrides[provider] !== undefined) {
    return settings.providerOverrides[provider];
  }

  // Size-specific override
  if (settings.sizeOverrides[sizeKey] !== undefined) {
    return settings.sizeOverrides[sizeKey]!;
  }

  // Region-specific override
  if (settings.regionOverrides[region] !== undefined) {
    return settings.regionOverrides[region]!;
  }

  return settings.defaultMarkupPercent;
}

export function calculateCustomerPrice(
  providerCostCents: number,
  markupPercent: number,
  minimumFloorCents: number,
): { customerPriceCents: number; platformProfitCents: number } {
  const rawPrice = Math.ceil(providerCostCents * (1 + markupPercent / 100));
  const customerPriceCents = Math.max(rawPrice, minimumFloorCents);
  return {
    customerPriceCents,
    platformProfitCents: customerPriceCents - providerCostCents,
  };
}

export function estimateProviderHourlyCost(sizeKey: SizeKey, providerKey: ProviderKey = "e2b"): number {
  const costs = PROVIDER_HOURLY_COSTS[providerKey] || PROVIDER_HOURLY_COSTS.e2b;
  return costs[sizeKey] || costs.small;
}

/**
 * Customer-facing hourly cost (provider cost + markup).
 * Use this for UI display. Call with settings for dynamic pricing.
 */
export function estimateHourlyCost(sizeKey: SizeKey, settings?: PricingSettings, providerKey: ProviderKey = "e2b"): number {
  const providerCost = estimateProviderHourlyCost(sizeKey, providerKey);
  if (!settings) {
    // Default 30% markup when settings not loaded
    return Math.ceil(providerCost * 1.3);
  }
  const markup = resolveMarkupPercent(settings, sizeKey, "us-east", providerKey);
  return calculateCustomerPrice(providerCost, markup, settings.minimumPriceFloorCents).customerPriceCents;
}

export function estimateMonthlyCost(sizeKey: SizeKey, hoursPerDay: number, settings?: PricingSettings, providerKey: ProviderKey = "e2b"): number {
  return estimateHourlyCost(sizeKey, settings, providerKey) * hoursPerDay * 30;
}
