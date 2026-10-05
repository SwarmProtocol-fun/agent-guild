/**
 * Unified WalletConnect adapter (Reown AppKit + wagmi + Solana).
 *
 * One AppKit modal for everything: EVM chains, Tangem (WalletConnect-only,
 * pinned via featuredWalletIds), and Solana wallets (Phantom/Solflare) —
 * two AppKit adapters (`wagmiAdapter` for the `eip155` namespace,
 * `solanaAdapter` for the `solana` namespace) registered on one
 * `createAppKit` call, per Reown's multichain pattern.
 *
 * Needs NEXT_PUBLIC_REOWN_PROJECT_ID (free at https://cloud.reown.com).
 * Without it the provider renders children and the connect button is
 * disabled, so the rest of the app still boots.
 */
"use client";

import { useMemo, type ReactNode } from "react";
import { defineChain, toHex, type EIP1193Provider } from "viem";
import { WagmiProvider, useAccount, useSignMessage as useWagmiSignMessage } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useDisconnect as useAppKitDisconnect,
} from "@reown/appkit/react";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { solanaDevnet } from "@reown/appkit/networks";
import type { Provider as SolanaProvider } from "@reown/appkit-utils/solana";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { ConnectionProvider, WalletProvider as SolanaWalletProviderBase } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Button } from "@/components/ui/button";
import { CHAIN_CONFIGS } from "@/lib/chains";
import { SOLANA_RPC_URL } from "@/lib/solana/client";
import type { WalletAdapter, ConnectButtonProps, WalletState, WalletStatus, SolanaSender, SolanaMessageSigner } from "../types";
import { parseWalletIds } from "./wallet-ids";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

// Every EVM chain in the registry becomes selectable in the wallet modal.
const evmNetworks = Object.values(CHAIN_CONFIGS)
  .filter((c) => c.chainId > 0)
  .map((c) =>
    defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: c.nativeCurrency,
      rpcUrls: { default: { http: [c.rpc] } },
      blockExplorers: { default: { name: c.explorer.name, url: c.explorer.baseUrl } },
    }),
  ) as unknown as [AppKitNetwork, ...AppKitNetwork[]];

// Solana Devnet only — matches this app's existing devnet-only Solana setup
// (chains.ts's `solana` entry). Not overriding its RPC: AppKit's own hosted
// endpoint is what the modal itself uses for balance lookups etc.; this
// app's SIWE verification for Solana never makes an RPC call (Ed25519
// signatures are verified locally — see lib/auth/siwe.ts), so there's
// nothing here that depends on which devnet RPC is used.
const networks = [...evmNetworks, solanaDevnet] as unknown as [AppKitNetwork, ...AppKitNetwork[]];

// Solana is the default network — identity NFTs, escrow and lending all
// settle there. EVM networks stay selectable in the modal.
const defaultNetwork = solanaDevnet;

// Wallets pinned to the top of the connect modal (e.g. Tangem, which is
// WalletConnect-only). Set NEXT_PUBLIC_FEATURED_WALLET_IDS to a comma-separated
// list of WalletConnect Explorer IDs.
const featured = parseWalletIds(process.env.NEXT_PUBLIC_FEATURED_WALLET_IDS);
if (featured.invalid.length > 0) {
  console.warn(
    `[wallet] Ignoring invalid NEXT_PUBLIC_FEATURED_WALLET_IDS entries (expected 64-char hex Explorer IDs): ${featured.invalid.join(", ")}`,
  );
}

const wagmiAdapter = new WagmiAdapter({
  projectId: projectId || "unconfigured",
  networks: evmNetworks,
  ssr: false,
});

// Cast: @reown/appkit-adapter-solana nests its own copy of
// @solana/wallet-adapter-base (0.9.27) instead of deduping against the root
// one (0.9.28) that PhantomWalletAdapter/SolflareWalletAdapter are built
// against — same shape, two structurally-distinct TS types. Runtime-safe.
const solanaAdapter = new SolanaAdapter({
  wallets: [new PhantomWalletAdapter(), new SolflareWalletAdapter()] as unknown as NonNullable<ConstructorParameters<typeof SolanaAdapter>[0]>["wallets"],
});

if (projectId) {
  const origin = typeof window !== "undefined"
    ? window.location.origin
    : `https://${process.env.NEXT_PUBLIC_APP_DOMAIN || "agent-guild.com"}`;
  createAppKit({
    adapters: [wagmiAdapter, solanaAdapter],
    projectId,
    networks,
    defaultNetwork,
    metadata: {
      name: "Agent Guild",
      description: "Enterprise AI fleet orchestration",
      url: origin,
      icons: [`${origin}/logo.png`],
    },
    ...(featured.ids.length > 0 ? { featuredWalletIds: featured.ids } : {}),
    features: { analytics: false },
  });
} else {
  console.warn(
    "⚠️ NEXT_PUBLIC_REOWN_PROJECT_ID is not set. Wallet connect will be unavailable. " +
    "Get a project ID at https://cloud.reown.com.",
  );
}

// Solana-program components (agent registration, gig escrow, useAgentGuildWrite)
// call @solana/wallet-adapter-react hooks directly, which throw without a
// WalletProvider ancestor — so mount one here too, alongside AppKit.
function Provider({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const solanaWallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={SOLANA_RPC_URL}>
          <SolanaWalletProviderBase wallets={solanaWallets} autoConnect>
            <WalletModalProvider>{children}</WalletModalProvider>
          </SolanaWalletProviderBase>
        </ConnectionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function mapAppKitStatus(status: "connected" | "disconnected" | "connecting" | "reconnecting" | undefined): WalletStatus {
  return status === "connected" ? "connected" : status === "disconnected" || status === undefined ? "disconnected" : "connecting";
}

// EVM (eip155) takes precedence if somehow both namespaces are connected at
// once — EVM/SIWE is this app's primary, longer-supported login path.
//
// The EVM address comes from AppKit (falling back to wagmi): for the
// email/social embedded wallet, wagmi can restore a stale account from
// storage that no longer matches the live wallet session, and signing as that
// address fails with "Signer mismatch". AppKit's address is the one the
// embedded wallet actually signs with.
function useEvmAccount() {
  const { address: wagmiAddress, chainId, status } = useAccount();
  const appKitEvm = useAppKitAccount({ namespace: "eip155" });
  const address = (appKitEvm.isConnected && appKitEvm.address) || wagmiAddress;
  return { address, chainId, status };
}

function useWallet(): WalletState {
  const { address, chainId, status } = useEvmAccount();
  const solanaAccount = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: solanaProvider } = useAppKitProvider<SolanaProvider>("solana");

  if (address) {
    // wagmi only sets `address` when status is "connected" or
    // "reconnecting" — "disconnected" can't occur here.
    return {
      address,
      chainId: chainId ?? null,
      status: status === "connected" ? "connected" : "connecting", // reconnecting
    };
  }

  if (solanaAccount.isConnected && solanaAccount.address) {
    // The account can be reported before its provider is ready (and before
    // the embedded wallet's EVM account shows up) — report "connecting" so
    // auto-login doesn't try to sign with no provider.
    if (!solanaProvider) return { address: null, chainId: null, status: "connecting" };
    return {
      address: solanaAccount.address,
      chainId: 0, // Non-EVM sentinel — matches chains.ts's `solana` entry.
      status: mapAppKitStatus(solanaAccount.status),
    };
  }

  return { address: null, chainId: null, status: "disconnected" };
}

function useSignMessage() {
  const { signMessageAsync } = useWagmiSignMessage();
  const { address: evmAddress } = useEvmAccount();
  const { walletProvider: evmProvider } = useAppKitProvider<EIP1193Provider>("eip155");
  const { walletProvider: solanaProvider } = useAppKitProvider<SolanaProvider>("solana");

  return async (message: string) => {
    if (evmAddress) {
      // Sign through AppKit's provider as AppKit's address so the request
      // matches the wallet's live signer (see useEvmAccount).
      if (evmProvider) {
        return evmProvider.request({
          method: "personal_sign",
          params: [toHex(message), evmAddress as `0x${string}`],
        });
      }
      return signMessageAsync({ message, account: evmAddress as `0x${string}` });
    }
    if (!solanaProvider) throw new Error("No wallet connected");
    const signature = await solanaProvider.signMessage(new TextEncoder().encode(message));
    return Buffer.from(signature).toString("base64");
  };
}

function useSolanaSender(): SolanaSender | null {
  const { address, isConnected } = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<SolanaProvider>("solana");
  if (!isConnected || !address || !walletProvider) return null;
  return { address, sendTransaction: (tx, connection) => walletProvider.sendTransaction(tx, connection) };
}

// Email/social sign-in gives the user a Solana account alongside the EVM
// one; this exposes it for signing even when EVM is the login identity.
function useSolanaMessageSigner(): SolanaMessageSigner | null {
  const { address, isConnected } = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<SolanaProvider>("solana");
  if (!isConnected || !address || !walletProvider) return null;
  return {
    address,
    signMessage: async (message) => {
      const signature = await walletProvider.signMessage(new TextEncoder().encode(message));
      return Buffer.from(signature).toString("base64");
    },
  };
}

function useDisconnect() {
  // Only reachable when AppKit was created; unconfigured → nothing to disconnect.
  return projectId ? useConfiguredDisconnect() : () => {};
}

function useConfiguredDisconnect() {
  const { disconnect } = useAppKitDisconnect();
  return () => disconnect();
}

function ConfiguredButton({ label = "Connect", className }: ConnectButtonProps) {
  const { open } = useAppKit();
  const { address } = useWallet();
  return (
    <Button
      className={className}
      variant={address ? "outline" : "default"}
      onClick={() => open(address ? { view: "Account" } : undefined)}
    >
      {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : label}
    </Button>
  );
}

function ConnectButton(props: ConnectButtonProps) {
  if (!projectId) {
    return (
      <Button className={props.className} disabled title="Set NEXT_PUBLIC_REOWN_PROJECT_ID to enable wallet connect">
        {props.label ?? "Connect"}
      </Button>
    );
  }
  return <ConfiguredButton {...props} />;
}

export const walletConnectAdapter: WalletAdapter = {
  id: "walletconnect",
  name: "WalletConnect (Reown)",
  Provider,
  useWallet,
  useSignMessage,
  useDisconnect,
  ConnectButton,
  useSolanaSender,
  useSolanaMessageSigner,
  storagePrefixes: ["wagmi.", "@appkit", "@w3m", "wc@2", "WALLETCONNECT", "walletConnect", "walletName", "solana-wallet-adapter"],
};
