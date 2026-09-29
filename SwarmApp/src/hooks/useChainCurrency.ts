/**
 * Hook that returns the native currency symbol based on the
 * connected wallet's chain. Defaults to "ETH" (Ethereum mainnet)
 * when no chain is connected; token-style chains (HBAR/AVAX/FIL)
 * display their symbol, others fall back to "$" (USD display).
 */

"use client";

import { useWallet } from "@/lib/wallet";
import { getCurrencySymbol } from "@/lib/chains";

export function useChainCurrency() {
  const chainId = useWallet().chainId ?? undefined;
  const symbol = getCurrencySymbol(chainId);
  const isHedera = chainId === 295 || chainId === 296;

  /** Format a numeric value with the correct currency prefix/suffix */
  const fmt = (value: number | string, decimals = 2): string => {
    const num = typeof value === "string" ? parseFloat(value) || 0 : value;
    const formatted = num.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
    // Token symbols go after the number; fiat-style uses $ prefix
    if (symbol === "HBAR" || symbol === "AVAX" || symbol === "FIL") {
      return `${formatted} ${symbol}`;
    }
    return `$${formatted}`;
  };

  return { symbol, isHedera, chainId, fmt };
}
