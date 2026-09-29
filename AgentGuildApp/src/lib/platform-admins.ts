/**
 * Shared platform admin address check.
 *
 * Server-side: reads PLATFORM_ADMIN_WALLETS
 * Client-side: reads NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS
 *
 * Both should be comma-separated wallet addresses in .env.
 */

const envValue =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS ||
      process.env.PLATFORM_ADMIN_WALLETS ||
      ""
    : "";

const PLATFORM_ADMIN_SET = new Set(
  envValue
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

/** Check if a wallet address is a platform admin */
export function isPlatformAdmin(address: string | null | undefined): boolean {
  if (!address) return false;
  return PLATFORM_ADMIN_SET.has(address.toLowerCase());
}
