/**
 * WalletConnect adapter (Reown AppKit + wagmi).
 *
 * Needs NEXT_PUBLIC_REOWN_PROJECT_ID (free at https://cloud.reown.com).
 * Without it the provider renders children and the connect button is
 * disabled, so the rest of the app still boots.
 */
"use client";

import { useMemo, type ReactNode } from "react";
import { defineChain } from "viem";
import { WagmiProvider, useAccount, useSignMessage as useWagmiSignMessage } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit, useAppKit, useDisconnect as useAppKitDisconnect } from "@reown/appkit/react";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { Button } from "@/components/ui/button";
import { CHAIN_CONFIGS } from "@/lib/chains";
import type { WalletAdapter, ConnectButtonProps, WalletState } from "../types";
import { parseWalletIds } from "./wallet-ids";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

// Every EVM chain in the registry becomes selectable in the wallet modal.
const networks = Object.values(CHAIN_CONFIGS)
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

const defaultNetwork = networks.find((n) => n.id === 296) ?? networks[0];

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
  networks,
  ssr: false,
});

if (projectId) {
  const origin = typeof window !== "undefined"
    ? window.location.origin
    : `https://${process.env.NEXT_PUBLIC_APP_DOMAIN || "swarmprotocol.fun"}`;
  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks,
    defaultNetwork,
    metadata: {
      name: "Swarm",
      description: "Enterprise AI fleet orchestration",
      url: origin,
      icons: [`${origin}/Logo.jpg`],
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

function Provider({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

function useWallet(): WalletState {
  const { address, chainId, status } = useAccount();
  return {
    address: address ?? null,
    chainId: chainId ?? null,
    status: status === "connected" ? "connected"
      : status === "disconnected" ? "disconnected"
      : "connecting", // connecting | reconnecting
  };
}

function useSignMessage() {
  const { signMessageAsync } = useWagmiSignMessage();
  return (message: string) => signMessageAsync({ message });
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
  storagePrefixes: ["wagmi.", "@appkit", "@w3m", "wc@2", "WALLETCONNECT", "walletConnect"],
};
