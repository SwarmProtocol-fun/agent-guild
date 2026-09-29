"use client";

/**
 * Solana wallet facade — additive to the core EVM wallet adapter (see
 * ./adapters/walletconnect.tsx). Same AppKit instance and WalletConnect
 * pairing session, just the "solana" namespace alongside "eip155" — a
 * Tangem card with Solana already enabled in-app can connect here too,
 * independently of the EVM identity SIWE auth uses.
 *
 * Deliberately not folded into ./index.ts's WalletAdapter interface: that
 * facade models the single EVM-style identity core/SIWE auth relies on
 * (see docs/wallet-adapters.md). This is a parallel, opt-in surface for
 * anything — like the tagem-wallet mod — that specifically wants Solana.
 */
import { useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { useAppKitConnection } from "@reown/appkit-adapter-solana/react";
import type { Provider } from "@reown/appkit-adapter-solana/react";

export function useSolanaAccount(): { address: string | null; isConnected: boolean } {
  const { address, isConnected } = useAppKitAccount({ namespace: "solana" });
  return { address: address ?? null, isConnected };
}

export function useSolanaConnection() {
  return useAppKitConnection().connection;
}

export function useSolanaProvider() {
  return useAppKitProvider<Provider>("solana").walletProvider;
}
