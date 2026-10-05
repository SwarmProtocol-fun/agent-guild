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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { defineChain, toHex, type EIP1193Provider } from "viem";
import { WagmiProvider, useAccount, useSignMessage as useWagmiSignMessage } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
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

// EVM chains selectable in the wallet modal — kept short on purpose so the
// network picker stays out of the way. Ethereum first: it's the network the
// embedded wallet switches to for its EVM login account (EmbeddedEvmSync).
// Other registry chains (Base, Avalanche, …) are still used server-side and by
// the crypto checkout, which talks to the injected wallet directly.
const WALLET_EVM_CHAINS = ["ethereum", "hyperliquid"] as const;
const evmNetworks = WALLET_EVM_CHAINS
  .map((key) => CHAIN_CONFIGS[key])
  .filter((c) => c && c.chainId > 0)
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

// Email/social (embedded) wallets only connect the namespace that's active at
// sign-in — Solana, the default network — but the embedded wallet's EVM
// account is this app's login identity (see useWallet). So when an embedded
// wallet connects on Solana, switch to an EVM network once to connect its EVM
// account, then switch back so Solana stays the active network — each
// namespace keeps its own account, so both stay connected. While that's
// pending useWallet reports "connecting" so auto-login doesn't sign in with
// the Solana address first. If the EVM account can't be connected (or drops
// on the way back), fall back to Solana.
type EvmSyncState = "idle" | "pending" | "failed";
let evmSyncState: EvmSyncState = "idle";
const evmSyncListeners = new Set<() => void>();
function setEvmSyncState(next: EvmSyncState) {
  evmSyncState = next;
  evmSyncListeners.forEach((l) => l());
}
function useEvmSyncState() {
  return useSyncExternalStore(
    (l) => {
      evmSyncListeners.add(l);
      return () => evmSyncListeners.delete(l);
    },
    () => evmSyncState,
    () => "idle" as EvmSyncState,
  );
}


function EmbeddedEvmSync() {
  const evm = useAppKitAccount({ namespace: "eip155" });
  const solana = useAppKitAccount({ namespace: "solana" });
  const { switchNetwork, caipNetwork } = useAppKitNetwork();
  // idle → toEvm (connecting the EVM account) → toSolana (switching back) → done
  const phaseRef = useRef<"idle" | "toEvm" | "toSolana" | "done">("idle");
  const embedded = Boolean(
    (evm.isConnected && evm.embeddedWalletInfo) || (solana.isConnected && solana.embeddedWalletInfo),
  );
  const solanaEmbedded = Boolean(solana.embeddedWalletInfo);
  const activeNamespace = caipNetwork?.chainNamespace;

  useEffect(() => {
    if (!embedded) {
      // Disconnected (or not an embedded wallet) — reset so a later sign-in retries.
      phaseRef.current = "idle";
      if (evmSyncState !== "idle") setEvmSyncState("idle");
      return;
    }

    if (!evm.isConnected) {
      if (!solanaEmbedded) return;
      if (phaseRef.current === "idle") {
        phaseRef.current = "toEvm";
        setEvmSyncState("pending");
        switchNetwork(evmNetworks[0]).catch((err) => {
          console.warn("[wallet] Could not connect embedded EVM account; using Solana:", err);
          setEvmSyncState("failed");
        });
      } else if (phaseRef.current !== "toEvm" && evmSyncState !== "failed") {
        // EVM account dropped after switching back — don't loop, use Solana.
        console.warn("[wallet] Embedded EVM account disconnected; using Solana");
        setEvmSyncState("failed");
      }
      return;
    }

    // Just connected the EVM account, or a restored session reopened on an
    // EVM network — make Solana the active network (once per session, so a
    // later deliberate switch to EVM isn't undone).
    if (phaseRef.current === "toEvm" || (phaseRef.current === "idle" && activeNamespace && activeNamespace !== "solana")) {
      phaseRef.current = "toSolana";
      setEvmSyncState("idle");
      switchNetwork(solanaDevnet)
        .catch((err) => console.warn("[wallet] Could not switch back to Solana:", err))
        .finally(() => {
          phaseRef.current = "done";
        });
    } else if (phaseRef.current === "idle" && activeNamespace) {
      phaseRef.current = "done"; // Already on Solana.
    }
  }, [embedded, solanaEmbedded, evm.isConnected, activeNamespace, switchNetwork]);

  return null;
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
            <WalletModalProvider>
              {projectId && <EmbeddedEvmSync />}
              {children}
            </WalletModalProvider>
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
  const evmSync = useEvmSyncState();
  const awaitingEvm = Boolean(solanaAccount.embeddedWalletInfo) && evmSync !== "failed";

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
    if (!solanaProvider || awaitingEvm) return { address: null, chainId: null, status: "connecting" };
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

const shorten = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// Connected → our own account menu (addresses, copy, disconnect) instead of
// AppKit's account view, so users never land on its network picker.
// Disconnected → AppKit's connect modal.
function ConfiguredButton({ label = "Connect", className }: ConnectButtonProps) {
  const { open } = useAppKit();
  const { address } = useWallet();
  if (!address) {
    return (
      <Button className={className} onClick={() => open()}>
        {label}
      </Button>
    );
  }
  return <AccountMenu address={address} className={className} />;
}

function AccountMenu({ address, className }: { address: string; className?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { disconnect } = useAppKitDisconnect();
  const solana = useAppKitAccount({ namespace: "solana" });
  // Embedded wallets also hold a Solana account — show it when it isn't the
  // login address itself.
  const solanaAddress = solana.isConnected && solana.address !== address ? solana.address : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? null : c)), 1500);
    } catch {
      // Clipboard unavailable — nothing to do.
    }
  };

  const rows = [
    { label: solanaAddress ? "EVM" : "Address", value: address },
    ...(solanaAddress ? [{ label: "Solana", value: solanaAddress }] : []),
  ];

  return (
    <div className="relative" ref={menuRef}>
      <Button
        className={className}
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={address}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <span className="font-mono">{shorten(address)}</span>
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg py-1 z-50 min-w-[220px]"
        >
          {rows.map((row) => (
            <button
              key={row.value}
              role="menuitem"
              onClick={() => copy(row.value)}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-muted/50"
              title={`Copy ${row.value}`}
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-mono">{copied === row.value ? "Copied" : shorten(row.value)}</span>
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              disconnect();
            }}
            className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-muted/50"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
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
