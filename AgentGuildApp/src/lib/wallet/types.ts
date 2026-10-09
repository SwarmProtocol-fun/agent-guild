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
import type { Connection, Transaction } from "@solana/web3.js";

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

/** A connected Solana wallet that can sign and broadcast a transaction. */
export interface SolanaSender {
  /** Base58 address of the Solana account that will sign. */
  address: string;
  /** Signs and broadcasts `tx` (fee payer and blockhash may be left for the wallet); resolves to its signature. */
  sendTransaction(tx: Transaction, connection: Connection): Promise<string>;
}

/** A connected EVM wallet that can send native ETH. */
export interface EvmSender {
  /** 0x address of the EVM account that will sign. */
  address: string;
  /** Switches the wallet to `chainId` if needed, sends `valueWei` to `to`, and resolves to the tx hash once broadcast (not mined). */
  sendNativeTransfer(input: { to: string; valueWei: bigint; chainId: number }): Promise<string>;
  /**
   * Switches the wallet to `chain` (adding it first if the wallet doesn't know
   * it), sends a contract call, and resolves to the tx hash once broadcast.
   */
  sendContractCall(input: { to: string; data: `0x${string}`; chain: EvmChainParams }): Promise<string>;
}

/** What a wallet needs to switch to (or add) an EVM chain. */
export interface EvmChainParams {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl?: string;
}

/** The user's Solana account, able to sign arbitrary messages (e.g. wallet-link proofs). */
export interface SolanaMessageSigner {
  /** Base58 address of the Solana account. */
  address: string;
  /** Signs `message` (UTF-8) and resolves to the base64 Ed25519 signature. */
  signMessage(message: string): Promise<string>;
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
  /** The connected Solana wallet's sender, or null when none is connected. Omit if the adapter has no Solana support. */
  useSolanaSender?(): SolanaSender | null;
  /** The user's Solana account as a message signer — even when they signed in with EVM — or null. Omit if the adapter has no Solana support. */
  useSolanaMessageSigner?(): SolanaMessageSigner | null;
  /** The connected EVM wallet's sender, or null when none is connected. Omit if the adapter has no EVM support. */
  useEvmSender?(): EvmSender | null;
  /** localStorage key prefixes to purge on logout so the wallet doesn't auto-reconnect. */
  storagePrefixes: string[];
}
