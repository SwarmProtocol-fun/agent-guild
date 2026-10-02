/**
 * Wallet facade — the only wallet import app code should use.
 *
 * Resolves the active adapter once at module load and re-exports its
 * hooks/components under stable names, so swapping providers never
 * touches call sites.
 */
"use client";

import { walletAdapters, DEFAULT_WALLET_ADAPTER } from "./adapters";
import type { WalletAdapter } from "./types";

export type { WalletAdapter, WalletState, WalletStatus, SolanaSender, SolanaMessageSigner } from "./types";

const requested = process.env.NEXT_PUBLIC_WALLET_PROVIDER || DEFAULT_WALLET_ADAPTER;
const adapter: WalletAdapter = walletAdapters[requested] ?? walletAdapters[DEFAULT_WALLET_ADAPTER];

if (!walletAdapters[requested]) {
  console.warn(`[wallet] Unknown NEXT_PUBLIC_WALLET_PROVIDER "${requested}", using "${adapter.id}".`);
}

export const WalletProvider = adapter.Provider;
export const ConnectWalletButton = adapter.ConnectButton;
export const useWallet = adapter.useWallet;
export const useWalletSignMessage = adapter.useSignMessage;
export const useDisconnectWallet = adapter.useDisconnect;
/** Connected Solana wallet that can send a transaction, or null (none connected / adapter has no Solana). */
export const useSolanaSender = adapter.useSolanaSender ?? (() => null);
/** The user's Solana account as a message signer, or null (none connected / adapter has no Solana). */
export const useSolanaMessageSigner = adapter.useSolanaMessageSigner ?? (() => null);

/** Drop-in for the old `useActiveAccount()`: `{ address }` or undefined. */
export function useWalletAccount(): { address: string } | undefined {
  const { address } = adapter.useWallet();
  return address ? { address } : undefined;
}

/** connected | connecting | disconnected */
export function useWalletConnectionStatus() {
  return adapter.useWallet().status;
}

/** Remove persisted wallet state so the wallet doesn't auto-reconnect. */
export function clearWalletStorage(): number {
  try {
    const keys = Object.keys(localStorage).filter((k) =>
      adapter.storagePrefixes.some((p) => k.startsWith(p)),
    );
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch {
    return 0; // localStorage unavailable
  }
}
