/**
 * Wallet adapter registry. Add a third-party adapter by importing it here
 * and listing it; select it with NEXT_PUBLIC_WALLET_PROVIDER=<id>.
 */
import type { WalletAdapter } from "../types";
import { walletConnectAdapter } from "./walletconnect";
import { solanaWalletAdapter } from "./solana";

export const walletAdapters: Record<string, WalletAdapter> = {
  [walletConnectAdapter.id]: walletConnectAdapter,
  [solanaWalletAdapter.id]: solanaWalletAdapter,
};

export const DEFAULT_WALLET_ADAPTER = walletConnectAdapter.id;
