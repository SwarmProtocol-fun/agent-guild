/**
 * Wallet adapter contract — the extension point for wallet/auth providers.
 *
 * Core only talks to this interface. WalletConnect (Reown AppKit) is the
 * first-party adapter; a third-party mod can ship its own (Privy, Dynamic,
 * Solana wallet-adapter, a mock wallet for tests…) by implementing it and
 * registering in `adapters/index.ts`.
 *
 * The active adapter is fixed at module load (NEXT_PUBLIC_WALLET_PROVIDER),
 * so the hooks below are safe to call unconditionally in components.
 */
import type { ComponentType, ReactNode } from "react";

export type WalletStatus = "connected" | "connecting" | "disconnected";

export interface WalletState {
  /** Connected account address, or null. */
  address: string | null;
  /** EVM chain id of the connected wallet, or null. */
  chainId: number | null;
  status: WalletStatus;
}

export interface ConnectButtonProps {
  label?: string;
  className?: string;
}

export interface WalletAdapter {
  /** Unique id, matched against NEXT_PUBLIC_WALLET_PROVIDER. */
  id: string;
  name: string;
  /** Mounts provider context (wagmi, query client, modal…). */
  Provider: ComponentType<{ children: ReactNode }>;
  useWallet(): WalletState;
  /** Returns a personal_sign function for SIWE login messages. */
  useSignMessage(): (message: string) => Promise<string>;
  useDisconnect(): () => Promise<void> | void;
  ConnectButton: ComponentType<ConnectButtonProps>;
  /** localStorage key prefixes to purge on logout so the wallet doesn't auto-reconnect. */
  storagePrefixes: string[];
}
