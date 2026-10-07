/**
 * WalletConnect adapter — login account selection, signing, and the
 * EVM/Solana login-chain toggle. AppKit/wagmi are mocked; each test drives
 * the mocked hook state through `w`.
 */
import bs58 from "bs58";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

type Ns = "eip155" | "solana";
interface Account {
  isConnected: boolean;
  address?: string;
  status?: "connected" | "disconnected" | "connecting" | "reconnecting";
  embeddedWalletInfo?: object;
}

const w = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID = "test-project";
  return {
    accounts: {} as Record<string, Account>,
    caipNetwork: undefined as undefined | { id: number | string; chainNamespace: string },
    providers: {} as Record<string, unknown>,
    wagmi: { address: undefined as string | undefined, chainId: undefined as number | undefined, status: "disconnected" },
    switchNetwork: vi.fn(),
    open: vi.fn(),
    disconnect: vi.fn(),
    signMessageAsync: vi.fn(),
    createAppKit: vi.fn(),
  };
});

const SOLANA_DEVNET = { id: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", chainNamespace: "solana", name: "Solana Devnet" };
const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;

vi.mock("@reown/appkit/react", () => ({
  createAppKit: w.createAppKit,
  useAppKit: () => ({ open: w.open }),
  useAppKitAccount: ({ namespace }: { namespace: Ns }) => w.accounts[namespace] ?? { isConnected: false, status: "disconnected" },
  useAppKitNetwork: () => ({ caipNetwork: w.caipNetwork, switchNetwork: w.switchNetwork }),
  useAppKitProvider: (ns: Ns) => ({ walletProvider: w.providers[ns] }),
  useDisconnect: () => ({ disconnect: w.disconnect }),
}));
vi.mock("@reown/appkit/networks", () => ({ solanaDevnet: SOLANA_DEVNET }));
vi.mock("@reown/appkit-adapter-wagmi", () => ({ WagmiAdapter: class { wagmiConfig = {}; } }));
vi.mock("@reown/appkit-adapter-solana/react", () => ({ SolanaAdapter: class {} }));
vi.mock("wagmi", () => ({
  WagmiProvider: Pass,
  useAccount: () => w.wagmi,
  useSignMessage: () => ({ signMessageAsync: w.signMessageAsync }),
}));
vi.mock("@solana/wallet-adapter-wallets", () => ({ PhantomWalletAdapter: class {}, SolflareWalletAdapter: class {} }));
vi.mock("@solana/wallet-adapter-react", () => ({ ConnectionProvider: Pass, WalletProvider: Pass }));
vi.mock("@solana/wallet-adapter-react-ui", () => ({ WalletModalProvider: Pass }));
vi.mock("@solana/wallet-adapter-react-ui/styles.css", () => ({}));
vi.mock("@/lib/solana/client", () => ({ SOLANA_RPC_URL: "http://localhost:8899" }));

const EVM = "0x1111111111111111111111111111111111111111";
const STALE_EVM = "0x9999999999999999999999999999999999999999";
const SOL = "So1anaAddre55So1anaAddre55So1anaAddre55xyz";

const solanaProvider = () => ({ signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])), sendTransaction: vi.fn() });
const evmProvider = () => ({ request: vi.fn(async () => "0xsig") });

async function loadAdapter() {
  return (await import("../walletconnect")).walletConnectAdapter;
}

/** Embedded (email/social) wallet: both accounts connected, `active` namespace selected. */
function embeddedBoth(active: Ns) {
  w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected", embeddedWalletInfo: {} };
  w.accounts.solana = { isConnected: true, address: SOL, status: "connected", embeddedWalletInfo: {} };
  w.providers = { eip155: evmProvider(), solana: solanaProvider() };
  w.caipNetwork = active === "eip155" ? { id: 1, chainNamespace: "eip155" } : SOLANA_DEVNET;
  w.wagmi = { address: EVM, chainId: 1, status: "connected" };
}

beforeEach(() => {
  w.accounts = {};
  w.caipNetwork = undefined;
  w.providers = {};
  w.wagmi = { address: undefined, chainId: undefined, status: "disconnected" };
  w.switchNetwork.mockReset().mockResolvedValue(undefined);
  w.open.mockReset();
  w.disconnect.mockReset();
  w.signMessageAsync.mockReset().mockResolvedValue("0xwagmisig");
  localStorage.clear();
});

describe("useWallet — login account", () => {
  it("reports disconnected with no accounts", async () => {
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: null, chainId: null, status: "disconnected" });
  });

  it("uses the Solana account when Solana is active", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected" };
    w.providers.solana = solanaProvider();
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: SOL, chainId: 0, status: "connected" });
  });

  it("reports connecting while the Solana provider isn't ready", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: null, chainId: null, status: "connecting" });
  });

  it("embedded wallet on Solana logs in with Solana even though EVM is connected (no signer mismatch)", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.address).toBe(SOL);
    expect(result.current.chainId).toBe(0);
  });

  it("embedded wallet on EVM logs in with the EVM account", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: EVM, chainId: 1, status: "connected" });
  });

  it("prefers AppKit's EVM address over a stale wagmi one", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected" };
    w.wagmi = { address: STALE_EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.address).toBe(EVM);
  });

  it("falls back to wagmi's address while EVM is active and AppKit hasn't reported it", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.wagmi = { address: EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: EVM, chainId: 1, status: "connected" });
  });

  it("maps wagmi reconnecting to connecting for the fallback address", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.wagmi = { address: EVM, chainId: 1, status: "reconnecting" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.status).toBe("connecting");
  });

  it("ignores a stale wagmi address while Solana is active and reconnecting", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: false, status: "reconnecting" };
    w.wagmi = { address: STALE_EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: null, chainId: null, status: "connecting" });
  });

  it("reports connecting while the active EVM account is connecting", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: false, status: "connecting" };
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected" };
    w.providers.solana = solanaProvider();
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.status).toBe("connecting");
    expect(result.current.address).toBeNull();
  });

  it("keeps the Solana account mid-switch until the EVM account connects", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: false, status: "disconnected" };
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected" };
    w.providers.solana = solanaProvider();
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.address).toBe(SOL);
  });

  it("uses an EVM-only wallet even if Solana is the active network", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: false, status: "disconnected" };
    w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected" };
    w.wagmi = { address: EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.address).toBe(EVM);
  });

  it("does not use a wagmi-only address when the active namespace is Solana and disconnected", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: false, status: "disconnected" };
    w.wagmi = { address: STALE_EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current).toEqual({ address: null, chainId: null, status: "disconnected" });
  });

  it("takes the EVM chainId from the active network when wagmi has none", async () => {
    w.caipNetwork = { id: 999, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useWallet());
    expect(result.current.chainId).toBe(999);
  });
});

describe("useSignMessage", () => {
  it("signs as the EVM login address through AppKit's provider", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useSignMessage());
    await expect(result.current("hello")).resolves.toBe("0xsig");
    expect((w.providers.eip155 as ReturnType<typeof evmProvider>).request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: ["0x68656c6c6f", EVM],
    });
  });

  it("falls back to wagmi signing when AppKit has no EVM provider", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected" };
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useSignMessage());
    await expect(result.current("hello")).resolves.toBe("0xwagmisig");
    expect(w.signMessageAsync).toHaveBeenCalledWith({ message: "hello", account: EVM });
  });

  it("signs with Solana when Solana is active, never asking the EVM signer", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useSignMessage());
    await expect(result.current("hello")).resolves.toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect((w.providers.solana as ReturnType<typeof solanaProvider>).signMessage).toHaveBeenCalledWith(
      new TextEncoder().encode("hello"),
    );
    expect((w.providers.eip155 as ReturnType<typeof evmProvider>).request).not.toHaveBeenCalled();
  });

  describe("WalletConnect Solana session without the active (Devnet) network", () => {
    const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

    // Mirrors @reown/appkit-adapter-solana's SolanaWalletConnectProvider:
    // every method funnels through internalRequest, which resolves the chain
    // from the active AppKit network — undefined when the session lacks it,
    // so UniversalProvider falls back to eip155:1.
    function wcProvider(approved: { id: string }[]) {
      const request = vi.fn(async ({ method }: { method: string; params?: unknown }, chainId?: string) => {
        if (!chainId) throw new Error(`The method "${method}" does not exist / is not available.`);
        return method === "solana_signMessage"
          ? { signature: bs58.encode(new Uint8Array([9, 8, 7])) }
          : { signature: bs58.encode(new Uint8Array(64).fill(1)) };
      });
      const p = {
        provider: { request },
        session: { namespaces: { solana: { accounts: [`${MAINNET}:${SOL}`] } } },
        chains: approved,
        getActiveChain: () => SOLANA_DEVNET,
        internalRequest(method: string, params: unknown) {
          const chain = this.chains.find((c) => this.getActiveChain()?.id === c.id);
          return request({ method, params }, chain ? `solana:${chain.id}` : undefined);
        },
        async signMessage(message: Uint8Array) {
          const r = (await this.internalRequest("solana_signMessage", { message: bs58.encode(message), pubkey: SOL })) as { signature: string };
          return bs58.decode(r.signature);
        },
        async sendTransaction(tx: { serialize: () => Uint8Array }, connection: { sendRawTransaction: (b: Uint8Array) => Promise<string> }) {
          await this.internalRequest("solana_signTransaction", { transaction: "tx" });
          return connection.sendRawTransaction(tx.serialize());
        },
      };
      return { p, request };
    }

    it("signs the login message on the session's mainnet chain", async () => {
      embeddedBoth("solana");
      const { p, request } = wcProvider([]);
      w.providers.solana = p;
      const a = await loadAdapter();
      const { result } = renderHook(() => a.useSignMessage());
      await expect(result.current("hello")).resolves.toBe(Buffer.from([9, 8, 7]).toString("base64"));
      expect(request).toHaveBeenCalledWith(
        { method: "solana_signMessage", params: { message: bs58.encode(new TextEncoder().encode("hello")), pubkey: SOL } },
        MAINNET,
      );
    });

    it("signs transactions on the session chain and broadcasts via the app's connection", async () => {
      embeddedBoth("solana");
      const { p, request } = wcProvider([]);
      w.providers.solana = p;
      const a = await loadAdapter();
      const sender = renderHook(() => a.useSolanaSender!()).result.current!;
      const connection = { sendRawTransaction: vi.fn(async () => "sig123") };
      await expect(sender.sendTransaction({ serialize: () => new Uint8Array([1]) } as never, connection as never)).resolves.toBe("sig123");
      expect(request).toHaveBeenCalledWith({ method: "solana_signTransaction", params: { transaction: "tx" } }, MAINNET);
      expect(connection.sendRawTransaction).toHaveBeenCalled();
    });

    it("leaves routing alone when the session approved the active network", async () => {
      embeddedBoth("solana");
      const { p, request } = wcProvider([SOLANA_DEVNET]);
      w.providers.solana = p;
      const a = await loadAdapter();
      const { result } = renderHook(() => a.useSignMessage());
      await result.current("hello");
      expect(request).toHaveBeenCalledWith(expect.anything(), `solana:${SOLANA_DEVNET.id}`);
    });
  });

  describe("while the AppKit modal is open (embedded wallet just connected)", () => {
    // A fake AppKit whose modal open state the test controls.
    function fakeModal(open: boolean) {
      const listeners = new Set<(s: { open: boolean }) => void>();
      const kit = {
        open,
        isOpen: () => kit.open,
        subscribeState: vi.fn((cb: (s: { open: boolean }) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        setOpen(next: boolean) {
          kit.open = next;
          listeners.forEach((l) => l({ open: next }));
        },
        listenerCount: () => listeners.size,
      };
      return kit;
    }

    // Later tests must not inherit a module bound to a fake (open) modal.
    afterEach(() => vi.resetModules());

    async function loadWithModal(kit: ReturnType<typeof fakeModal>) {
      vi.resetModules();
      w.createAppKit.mockReturnValueOnce(kit);
      return loadAdapter();
    }

    it("holds the signature request until the modal closes", async () => {
      const kit = fakeModal(true);
      const a = await loadWithModal(kit);
      embeddedBoth("eip155");
      const provider = w.providers.eip155 as ReturnType<typeof evmProvider>;
      const { result } = renderHook(() => a.useSignMessage());
      const pending = result.current("hello");
      await Promise.resolve();
      expect(provider.request).not.toHaveBeenCalled();
      kit.setOpen(false);
      await expect(pending).resolves.toBe("0xsig");
      expect(provider.request).toHaveBeenCalledTimes(1);
      expect(kit.listenerCount()).toBe(0);
    });

    it("signs immediately when the modal is closed", async () => {
      const kit = fakeModal(false);
      const a = await loadWithModal(kit);
      embeddedBoth("solana");
      const { result } = renderHook(() => a.useSignMessage());
      await expect(result.current("hello")).resolves.toBe(Buffer.from([1, 2, 3]).toString("base64"));
      expect(kit.subscribeState).not.toHaveBeenCalled();
    });

    it("stops waiting after the cap so a modal left open doesn't block login forever", async () => {
      vi.useFakeTimers();
      try {
        const kit = fakeModal(true);
        const a = await loadWithModal(kit);
        embeddedBoth("eip155");
        const { MODAL_CLOSE_WAIT_MS } = await import("../walletconnect");
        const { result } = renderHook(() => a.useSignMessage());
        const pending = result.current("hello");
        await vi.advanceTimersByTimeAsync(MODAL_CLOSE_WAIT_MS);
        await expect(pending).resolves.toBe("0xsig");
        expect(kit.listenerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("throws with no wallet connected", async () => {
    const a = await loadAdapter();
    const { result } = renderHook(() => a.useSignMessage());
    await expect(result.current("hello")).rejects.toThrow("No wallet connected");
  });
});

describe("Solana sender / message signer", () => {
  it("are null without a Solana account", async () => {
    const a = await loadAdapter();
    expect(renderHook(() => a.useSolanaSender!()).result.current).toBeNull();
    expect(renderHook(() => a.useSolanaMessageSigner!()).result.current).toBeNull();
  });

  it("expose the Solana account even when EVM is the login chain", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    expect(renderHook(() => a.useSolanaSender!()).result.current?.address).toBe(SOL);
    const signer = renderHook(() => a.useSolanaMessageSigner!()).result.current!;
    expect(signer.address).toBe(SOL);
    await expect(signer.signMessage("x")).resolves.toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

describe("ConnectButton / account menu", () => {
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /\.\.\./ }));
  const chainButton = (name: "EVM" | "Solana") =>
    screen.getByRole("group", { name: "Login chain" }).querySelector(`button[title*="${name}"]`) as HTMLButtonElement;

  it("opens the AppKit modal when disconnected", async () => {
    const a = await loadAdapter();
    render(<a.ConnectButton label="Sign in" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(w.open).toHaveBeenCalled();
  });

  it("shows the shortened login address", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    expect(screen.getByRole("button", { name: `${SOL.slice(0, 6)}...${SOL.slice(-4)}` })).toBeInTheDocument();
  });

  it("marks the active chain and lists both addresses", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    expect(chainButton("Solana")).toHaveAttribute("aria-pressed", "true");
    expect(chainButton("EVM")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Solana · active/)).toBeInTheDocument();
    expect(screen.getByTitle(`Copy ${EVM}`)).toHaveTextContent("EVM");
    expect(screen.getByTitle(`Copy ${EVM}`)).not.toHaveTextContent("active");
  });

  it("switching to EVM switches network and remembers the choice", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(chainButton("EVM")));
    expect(w.switchNetwork).toHaveBeenCalledTimes(1);
    expect(w.switchNetwork.mock.calls[0][0]).toMatchObject({ id: 1 });
    expect(localStorage.getItem("agentguild.loginChain")).toBe("eip155");
  });

  it("switching to Solana switches to Solana Devnet", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(chainButton("Solana")));
    expect(w.switchNetwork).toHaveBeenCalledWith(SOLANA_DEVNET);
    expect(localStorage.getItem("agentguild.loginChain")).toBe("solana");
  });

  it("clicking the already-active chain does nothing", async () => {
    embeddedBoth("solana");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(chainButton("Solana")));
    expect(w.switchNetwork).not.toHaveBeenCalled();
  });

  it("shows Switching… and disables the toggle while a switch is in flight", async () => {
    embeddedBoth("solana");
    let resolve!: () => void;
    w.switchNetwork.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(chainButton("EVM")));
    expect(screen.getByText("Switching…")).toBeInTheDocument();
    expect(chainButton("Solana")).toBeDisabled();
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByText("Switching…")).not.toBeInTheDocument());
  });

  it("recovers when the switch fails", async () => {
    embeddedBoth("solana");
    w.switchNetwork.mockRejectedValue(new Error("user rejected"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(chainButton("EVM")));
    await waitFor(() => expect(chainButton("EVM")).not.toBeDisabled());
    expect(warn).toHaveBeenCalledWith("[wallet] Could not switch login chain:", expect.any(Error));
    warn.mockRestore();
  });

  it("disables EVM for a Solana-only (non-embedded) wallet", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected" };
    w.providers.solana = solanaProvider();
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    expect(chainButton("EVM")).toBeDisabled();
    expect(chainButton("Solana")).not.toBeDisabled();
  });

  it("disables Solana for an EVM-only (non-embedded) wallet", async () => {
    w.caipNetwork = { id: 1, chainNamespace: "eip155" };
    w.accounts.eip155 = { isConnected: true, address: EVM, status: "connected" };
    w.wagmi = { address: EVM, chainId: 1, status: "connected" };
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    expect(chainButton("Solana")).toBeDisabled();
  });

  it("allows switching to an unconnected namespace for embedded wallets", async () => {
    w.caipNetwork = SOLANA_DEVNET;
    w.accounts.solana = { isConnected: true, address: SOL, status: "connected", embeddedWalletInfo: {} };
    w.providers.solana = solanaProvider();
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    expect(chainButton("EVM")).not.toBeDisabled();
  });

  it("copies an address", async () => {
    embeddedBoth("eip155");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    await act(async () => fireEvent.click(screen.getByTitle(`Copy ${SOL}`)));
    expect(writeText).toHaveBeenCalledWith(SOL);
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("disconnects and closes the menu", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(w.disconnect).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on Escape", async () => {
    embeddedBoth("eip155");
    const a = await loadAdapter();
    render(<a.ConnectButton />);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("module setup", () => {
  beforeEach(() => {
    vi.resetModules();
    w.createAppKit.mockClear();
  });

  it("defaults AppKit to Ethereum with no saved preference", async () => {
    await loadAdapter();
    expect(w.createAppKit.mock.calls[0][0].defaultNetwork).toMatchObject({ id: 1 });
  });

  it("defaults AppKit to Solana when Solana was chosen before", async () => {
    localStorage.setItem("agentguild.loginChain", "solana");
    await loadAdapter();
    expect(w.createAppKit).toHaveBeenCalledWith(expect.objectContaining({ defaultNetwork: SOLANA_DEVNET }));
  });

  it("ignores a garbage preference", async () => {
    localStorage.setItem("agentguild.loginChain", "dogechain");
    await loadAdapter();
    expect(w.createAppKit.mock.calls[0][0].defaultNetwork).toMatchObject({ id: 1 });
  });

  it("only exposes Ethereum, Hyperliquid and Solana Devnet in the modal", async () => {
    await loadAdapter();
    const ids = w.createAppKit.mock.calls[0][0].networks.map((n: { id: unknown }) => n.id);
    expect(ids[0]).toBe(1);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe(SOLANA_DEVNET.id);
  });

  it("the remembered login chain survives clearWalletStorage", async () => {
    const { clearWalletStorage } = await import("../../index");
    localStorage.setItem("agentguild.loginChain", "eip155");
    localStorage.setItem("@appkit/active_caip_network_id", "eip155:1");
    localStorage.setItem("wagmi.store", "{}");
    expect(clearWalletStorage()).toBe(2);
    expect(localStorage.getItem("agentguild.loginChain")).toBe("eip155");
  });

  it("renders a disabled connect button without a project id", async () => {
    const prev = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await loadAdapter();
      render(<a.ConnectButton label="Connect" />);
      expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
      expect(w.createAppKit).not.toHaveBeenCalled();
    } finally {
      process.env.NEXT_PUBLIC_REOWN_PROJECT_ID = prev;
      warn.mockRestore();
    }
  });
});
