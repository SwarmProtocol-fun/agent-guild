/**
 * Landing page login flow — the "Authenticating" overlay never traps the
 * user (shows the real step, the error, and Retry/Disconnect), and a
 * successful login redirects to /dashboard (or ?redirect=).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const m = vi.hoisted(() => ({
  account: undefined as { address: string } | undefined,
  session: { authenticated: false, loading: false },
  login: { phase: "idle", error: null as string | null },
  search: new URLSearchParams(),
  replace: vi.fn(),
  retry: vi.fn(),
  disconnect: vi.fn(),
  clearWalletStorage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: m.replace, push: vi.fn() }),
  useSearchParams: () => m.search,
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/image", () => ({ default: (p: { alt: string }) => <img alt={p.alt} /> }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/lib/wallet", () => ({
  ConnectWalletButton: ({ label }: { label?: string }) => <button>{label ?? "Connect"}</button>,
  useWalletAccount: () => m.account,
  useDisconnectWallet: () => m.disconnect,
  clearWalletStorage: m.clearWalletStorage,
}));
vi.mock("@/contexts/SessionContext", () => ({ useSession: () => m.session }));
vi.mock("@/hooks/useFeatured", () => ({ useFeatured: () => ({ featured: null, loaded: false }) }));
vi.mock("@/hooks/useAutoSiwe", () => ({
  useAutoLoginStatus: () => m.login,
  retryAutoLogin: m.retry,
}));

import LandingPage from "../page";

const ADDR = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  m.account = undefined;
  m.session = { authenticated: false, loading: false };
  m.login = { phase: "idle", error: null };
  m.search = new URLSearchParams();
  m.replace.mockReset();
  m.retry.mockReset();
  m.disconnect.mockReset().mockResolvedValue(undefined);
  m.clearWalletStorage.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const overlay = () => screen.queryByRole("status");

describe("landing page login", () => {
  it("shows no overlay without a wallet", () => {
    render(<LandingPage />);
    expect(overlay()).toBeNull();
    expect(m.replace).not.toHaveBeenCalled();
  });

  it("shows 'Connecting wallet…' once a wallet connects", () => {
    m.account = { address: ADDR };
    render(<LandingPage />);
    expect(overlay()).toHaveTextContent("Connecting wallet…");
  });

  it("asks the user to approve while signing", () => {
    m.account = { address: ADDR };
    m.login = { phase: "signing", error: null };
    render(<LandingPage />);
    expect(overlay()).toHaveTextContent("Approve the sign-in");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows verifying after the signature", () => {
    m.account = { address: ADDR };
    m.login = { phase: "verifying", error: null };
    render(<LandingPage />);
    expect(overlay()).toHaveTextContent("Signing you in…");
  });

  it("shows the error with Try again and Disconnect on failure", () => {
    m.account = { address: ADDR };
    m.login = { phase: "failed", error: "Invalid signature" };
    render(<LandingPage />);
    expect(overlay()).toHaveTextContent("Sign-in failed");
    expect(overlay()).toHaveTextContent("Invalid signature");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(m.retry).toHaveBeenCalled();
  });

  it("Disconnect drops the wallet and its persisted state", async () => {
    m.account = { address: ADDR };
    m.login = { phase: "failed", error: "nope" };
    render(<LandingPage />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Disconnect" })));
    expect(m.disconnect).toHaveBeenCalled();
    expect(m.clearWalletStorage).toHaveBeenCalled();
  });

  it("still clears storage if disconnect throws", async () => {
    m.account = { address: ADDR };
    m.login = { phase: "failed", error: "nope" };
    m.disconnect.mockRejectedValue(new Error("boom"));
    render(<LandingPage />);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Disconnect" })));
    expect(m.clearWalletStorage).toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("[Agent Guild:Landing] Disconnect failed:", expect.any(Error));
    err.mockRestore();
  });

  it("offers Cancel when sign-in stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    m.account = { address: ADDR };
    m.login = { phase: "signing", error: null };
    render(<LandingPage />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    act(() => vi.advanceTimersByTime(15_000));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await act(async () => fireEvent.click(cancel));
    expect(m.disconnect).toHaveBeenCalled();
    expect(m.clearWalletStorage).toHaveBeenCalled();
  });

  it("redirects to /dashboard once authenticated", async () => {
    m.account = { address: ADDR };
    m.session = { authenticated: true, loading: false };
    render(<LandingPage />);
    await waitFor(() => expect(m.replace).toHaveBeenCalledWith("/dashboard"));
    expect(overlay()).toBeNull();
  });

  it("redirects to ?redirect= when given", async () => {
    m.session = { authenticated: true, loading: false };
    m.search = new URLSearchParams("redirect=/lending");
    render(<LandingPage />);
    await waitFor(() => expect(m.replace).toHaveBeenCalledWith("/lending"));
  });

  it("does not redirect while the session is loading", () => {
    m.session = { authenticated: true, loading: true };
    render(<LandingPage />);
    expect(m.replace).not.toHaveBeenCalled();
  });
});
