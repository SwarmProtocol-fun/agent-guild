/**
 * Hook that returns the native currency symbol based on the
 * connected wallet's chain. Defaults to "SOL" (Solana is the
 * primary chain), otherwise → "$" (treated as USD display).
 */

"use client";

import { useWallet } from "@/lib/wallet";
import { getCurrencySymbol, formatChainCurrency } from "@/lib/chains";

export function useChainCurrency() {
  const chainId = useWallet().chainId ?? undefined;
  const symbol = getCurrencySymbol(chainId);
  const isToken = symbol === "SOL" || symbol === "AVAX" || symbol === "FIL";

  /**
   * Format a numeric value with the correct currency prefix/suffix.
   * `decimals`, when passed, overrides the default precision (chain-derived
   * for token amounts, 2dp for the fiat-style "$" display) — shared with
   * market-item-card and crypto-checkout-dialog via `formatChainCurrency`
   * so the same underlying value renders identically across pages.
   */
  const fmt = (value: number | string, decimals?: number): string => {
    const num = typeof value === "string" ? parseFloat(value) || 0 : value;
    const formatted = formatChainCurrency(num, chainId, decimals ?? (isToken ? undefined : 2));
    // Token symbols go after the number; fiat-style uses $ prefix
    return isToken ? `${formatted} ${symbol}` : `$${formatted}`;
  };

  return { symbol, chainId, fmt };
}
