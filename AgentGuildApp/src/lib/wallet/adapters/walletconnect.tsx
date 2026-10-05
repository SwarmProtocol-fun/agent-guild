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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

// The chain the user logs in with: whichever namespace is active in AppKit
// (toggled from the account menu). The choice is remembered under a key that
// clearWalletStorage doesn't purge, so it survives disconnect/reconnect —
// embedded (email/social) wallets connect the namespace active at sign-in.
// Solana is the fallback — identity NFTs, escrow and lending settle there.
type LoginNamespace = "eip155" | "solana";
const LOGIN_CHAIN_KEY = "agentguild.loginChain";
function readLoginChainPref(): LoginNamespace {
  try {
    return localStorage.getItem(LOGIN_CHAIN_KEY) === "eip155" ? "eip155" : "solana";
  } catch {
    return "solana";
  }
}
function writeLoginChainPref(ns: LoginNamespace) {
  try {
    localStorage.setItem(LOGIN_CHAIN_KEY, ns);
  } catch {
    // localStorage unavailable — preference just isn't remembered.
  }
}
const networkFor = (ns: LoginNamespace) => (ns === "eip155" ? evmNetworks[0] : solanaDevnet);
const defaultNetwork = typeof window !== "undefined" ? networkFor(readLoginChainPref()) : solanaDevnet;

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

// The login account is the active namespace's account, so it's always the
// account the wallet signs with. Embedded (email/social) wallets sign with the
// active chain's account only — asking them to sign as the other namespace's
// address fails with "Signer mismatch".
//
// The EVM address comes from AppKit, falling back to wagmi only while EVM is
// active: wagmi can restore a stale account from storage that no longer
// matches the live embedded-wallet session.
function useLoginAccount() {
  const { address: wagmiAddress, chainId: wagmiChainId, status: wagmiStatus } = useAccount();
  const evm = useAppKitAccount({ namespace: "eip155" });
  const solana = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: solanaProvider } = useAppKitProvider<SolanaProvider>("solana");
  const { caipNetwork } = useAppKitNetwork();
  const active = caipNetwork?.chainNamespace;

  const evmAddress = evm.isConnected ? evm.address : undefined;
  const solanaAddress = solana.isConnected ? solana.address : undefined;

  const evmState = (address: string) => ({
    namespace: "eip155" as const,
    address,
    chainId: wagmiChainId ?? (active === "eip155" ? Number(caipNetwork?.id) || null : null),
    status: (evm.isConnected ? mapAppKitStatus(evm.status) : wagmiStatus === "connected" ? "connected" : "connecting") as WalletStatus,
  });
  // The account can be reported before its provider is ready — report
  // "connecting" so auto-login doesn't try to sign with no provider.
  const solanaState = (address: string) =>
    solanaProvider
      ? { namespace: "solana" as const, address, chainId: 0, status: mapAppKitStatus(solana.status) }
      : { namespace: null, address: null, chainId: null, status: "connecting" as WalletStatus };
  const none = (status: WalletStatus) => ({ namespace: null, address: null, chainId: null, status });

  if (active === "eip155") {
    const address = evmAddress || wagmiAddress;
    if (address) return evmState(address);
    if (evm.status === "connecting" || evm.status === "reconnecting") return none("connecting");
  } else if (active === "solana") {
    if (solanaAddress) return solanaState(solanaAddress);
    if (solana.status === "connecting" || solana.status === "reconnecting") return none("connecting");
  }
  // Active namespace has no account (e.g. mid-switch, or a single-namespace
  // wallet) — use whichever namespace is connected.
  if (evmAddress) return evmState(evmAddress);
  if (solanaAddress) return solanaState(solanaAddress);
  return none("disconnected");
}

function useWallet(): WalletState {
  const { address, chainId, status } = useLoginAccount();
  return { address, chainId, status };
}

function useSignMessage() {
  const { signMessageAsync } = useWagmiSignMessage();
  const { namespace, address } = useLoginAccount();
  const { walletProvider: evmProvider } = useAppKitProvider<EIP1193Provider>("eip155");
  const { walletProvider: solanaProvider } = useAppKitProvider<SolanaProvider>("solana");

  return async (message: string) => {
    if (namespace === "eip155" && address) {
      // Sign through AppKit's provider as the login address so the request
      // matches the wallet's live signer.
      if (evmProvider) {
        return evmProvider.request({
          method: "personal_sign",
          params: [toHex(message), address as `0x${string}`],
        });
      }
      return signMessageAsync({ message, account: address as `0x${string}` });
    }
    if (namespace !== "solana" || !solanaProvider) throw new Error("No wallet connected");
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
  const { address, namespace } = useLoginAccount();
  if (!address) {
    return (
      <Button className={className} onClick={() => open()}>
        {label}
      </Button>
    );
  }
  return <AccountMenu address={address} namespace={namespace!} className={className} />;
}

function AccountMenu({ address, namespace, className }: { address: string; namespace: LoginNamespace; className?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [switching, setSwitching] = useState<LoginNamespace | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { disconnect } = useAppKitDisconnect();
  const { switchNetwork } = useAppKitNetwork();
  const evm = useAppKitAccount({ namespace: "eip155" });
  const solana = useAppKitAccount({ namespace: "solana" });
  const evmAddress = namespace === "eip155" ? address : evm.isConnected ? evm.address : undefined;
  const solanaAddress = namespace === "solana" ? address : solana.isConnected ? solana.address : undefined;
  // Embedded (email/social) wallets hold both accounts and connect the other
  // one on switch; other wallets can only switch to a namespace they're on.
  const embedded = Boolean(evm.embeddedWalletInfo || solana.embeddedWalletInfo);
  const canUse = (ns: LoginNamespace) => embedded || (ns === "eip155" ? Boolean(evmAddress) : Boolean(solanaAddress));

  // Switching the active namespace changes the login account; useAutoSiwe
  // logs out the old session and signs in with the new account.
  const switchTo = async (ns: LoginNamespace) => {
    if (ns === namespace || switching) return;
    writeLoginChainPref(ns);
    setSwitching(ns);
    try {
      await switchNetwork(networkFor(ns));
    } catch (err) {
      console.warn("[wallet] Could not switch login chain:", err);
    } finally {
      setSwitching(null);
    }
  };

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
    ...(evmAddress ? [{ label: "EVM", value: evmAddress }] : []),
    ...(solanaAddress ? [{ label: "Solana", value: solanaAddress }] : []),
  ];
  const chains: { ns: LoginNamespace; label: string }[] = [
    { ns: "eip155", label: "EVM" },
    { ns: "solana", label: "Solana" },
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
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Signed in with</div>
          <div className="mx-3 mb-2 grid grid-cols-2 gap-1 rounded-md bg-muted/40 p-1" role="group" aria-label="Login chain">
            {chains.map(({ ns, label }) => (
              <button
                key={ns}
                type="button"
                aria-pressed={namespace === ns}
                disabled={!canUse(ns) || switching !== null}
                onClick={() => switchTo(ns)}
                title={canUse(ns) ? `Sign in with your ${label} account` : `This wallet has no ${label} account`}
                className={`rounded px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
                  namespace === ns ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {switching === ns ? "Switching…" : label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          {rows.map((row) => (
            <button
              key={row.value}
              role="menuitem"
              onClick={() => copy(row.value)}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-muted/50"
              title={`Copy ${row.value}`}
            >
              <span className="text-muted-foreground">
                {row.label}
                {row.value === address && " · active"}
              </span>
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
