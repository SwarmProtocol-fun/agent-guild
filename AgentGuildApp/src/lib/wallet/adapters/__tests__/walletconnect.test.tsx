/**
 * WalletConnect adapter — login account selection, signing, and the
 * EVM/Solana login-chain toggle. AppKit/wagmi are mocked; each test drives
 * the mocked hook state through `w`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("defaults AppKit to Solana with no saved preference", async () => {
    await loadAdapter();
    expect(w.createAppKit).toHaveBeenCalledWith(expect.objectContaining({ defaultNetwork: SOLANA_DEVNET }));
  });

  it("defaults AppKit to EVM when EVM was chosen before", async () => {
    localStorage.setItem("agentguild.loginChain", "eip155");
    await loadAdapter();
    expect(w.createAppKit.mock.calls[0][0].defaultNetwork).toMatchObject({ id: 1 });
  });

  it("ignores a garbage preference", async () => {
    localStorage.setItem("agentguild.loginChain", "dogechain");
    await loadAdapter();
    expect(w.createAppKit).toHaveBeenCalledWith(expect.objectContaining({ defaultNetwork: SOLANA_DEVNET }));
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
