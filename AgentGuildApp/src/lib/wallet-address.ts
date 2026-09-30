/**
 * Wallet address canonicalization — chain-aware.
 *
 * EVM addresses are case-insensitive (checksummed hex), so they're safe to
 * lowercase for storage/comparison keys. Solana addresses are case-sensitive
 * base58 — lowercasing one silently produces a *different* address, not the
 * same one in a different format. Every place that keys/compares a wallet
 * address for identity (sessions, org ownership, admin lists, profiles,
 * analytics) must go through this instead of a bare `.toLowerCase()`.
 */
import { isAddress, getAddress } from "viem";

export function canonicalizeWalletAddress(address: string): string {
  return isAddress(address, { strict: false }) ? getAddress(address).toLowerCase() : address;
}
