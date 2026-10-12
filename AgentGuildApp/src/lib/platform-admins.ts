/**
 * Shared platform admin address check.
 *
 * Server-side: reads PLATFORM_ADMIN_WALLETS
 * Client-side: reads NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS
 *
 * Both should be comma-separated wallet addresses in .env.
 */

import { canonicalizeWalletAddress } from "./wallet-address";

// Must stay literal `process.env.NEXT_PUBLIC_*` member accesses: a `typeof process`
// guard makes the bundler swap in the process polyfill, which skips build-time
// inlining and leaves the client-side admin set empty.
const envValue =
  process.env.NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS ||
  process.env.PLATFORM_ADMIN_WALLETS ||
  "";

const PLATFORM_ADMIN_SET = new Set(
  envValue
    .split(",")
    .map((a) => canonicalizeWalletAddress(a.trim()))
    .filter(Boolean),
);

/** Check if a wallet address is a platform admin */
export function isPlatformAdmin(address: string | null | undefined): boolean {
  if (!address) return false;
  return PLATFORM_ADMIN_SET.has(canonicalizeWalletAddress(address));
}
