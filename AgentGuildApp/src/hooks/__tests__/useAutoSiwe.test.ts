/**
 * useAutoSiwe — auto-login on wallet connect, re-login when the login account
 * changes (e.g. the EVM/Solana toggle), logout on disconnect, and the
 * "Signer mismatch" recovery path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const s = vi.hoisted(() => ({
  wallet: { address: null as string | null, chainId: null as number | null, status: "disconnected" },
  session: { authenticated: false, address: null as string | null, loading: false },
  signMessage: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  disconnect: vi.fn(),
  clearWalletStorage: vi.fn(),
  signInWithCustomToken: vi.fn(),
  auth: { currentUser: null as { uid: string } | null, authStateReady: async () => {} },
}));

vi.mock("@/lib/wallet", () => ({
  useWallet: () => s.wallet,
  useWalletSignMessage: () => s.signMessage,
  useDisconnectWallet: () => s.disconnect,
  clearWalletStorage: s.clearWalletStorage,
}));
vi.mock("@/contexts/SessionContext", () => ({
  useSession: () => ({ ...s.session, refresh: s.refresh, logout: s.logout }),
}));
vi.mock("firebase/auth", () => ({ signInWithCustomToken: s.signInWithCustomToken }));
vi.mock("@/lib/firebase", () => ({ auth: s.auth }));

import { useAutoSiwe, useAutoLoginStatus, retryAutoLogin, SIGN_TIMEOUT_MS } from "../useAutoSiwe";

const EVM = "0xAbC0000000000000000000000000000000000001";
const SOL = "So1anaAddre55So1anaAddre55So1anaAddre55xyz";

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) });

function serverOk() {
  fetchMock.mockImplementation(async (url: string) =>
    url === "/api/auth/payload"
      ? ok({ payload: { nonce: "n" }, message: "Sign in to Agent Guild" })
      : ok({ firebaseToken: "fb-token" }),
  );
}

function connect(address: string | null, chainId: number | null, status = address ? "connected" : "disconnected") {
  s.wallet = { address, chainId, status };
}

beforeEach(() => {
  connect(null, null);
  s.session = { authenticated: false, address: null, loading: false };
  s.signMessage.mockReset().mockResolvedValue("sig");
  s.refresh.mockReset().mockResolvedValue(undefined);
  s.logout.mockReset();
  s.disconnect.mockReset().mockResolvedValue(undefined);
  s.clearWalletStorage.mockReset();
  s.signInWithCustomToken.mockReset().mockResolvedValue({});
  s.auth.currentUser = null;
  fetchMock.mockReset();
  serverOk();
  vi.stubGlobal("fetch", fetchMock);
  act(() => retryAutoLogin()); // reset module-level status between tests
});

afterEach(() => vi.unstubAllGlobals());

describe("useAutoSiwe", () => {
  describe("stale Firebase Auth uid on an existing session", () => {
    const SOL_REAL = "Pip4XqCgH5J5j5Ra3BjhFtBj8xY5SsWjKxLdNqG4eNv";

    it("logs out when the restored uid is a lowercased Solana address", async () => {
      connect(SOL_REAL, null);
      s.session = { authenticated: true, address: SOL_REAL, loading: false };
      s.auth.currentUser = { uid: SOL_REAL.toLowerCase() };
      renderHook(() => useAutoSiwe());
      await waitFor(() => expect(s.logout).toHaveBeenCalledTimes(1));
    });

    it("only resets once per address, so a persistent mismatch can't loop wallet prompts", async () => {
      connect(SOL_REAL, null);
      s.session = { authenticated: true, address: SOL_REAL, loading: false };
      s.auth.currentUser = { uid: SOL_REAL.toLowerCase() };
      const first = renderHook(() => useAutoSiwe());
      await waitFor(() => expect(s.logout).toHaveBeenCalledTimes(1));
      first.unmount();

      renderHook(() => useAutoSiwe()); // re-login produced the same bad uid
      await act(async () => {});
      expect(s.logout).toHaveBeenCalledTimes(1);
    });

    it("keeps the session when the uid is the exact-case Solana address", async () => {
      connect(SOL_REAL, null);
      s.session = { authenticated: true, address: SOL_REAL, loading: false };
      s.auth.currentUser = { uid: SOL_REAL };
      renderHook(() => useAutoSiwe());
      await act(async () => {});
      expect(s.logout).not.toHaveBeenCalled();
    });

    it("keeps the session when an EVM uid is the lowercased checksummed address", async () => {
      connect(EVM, 1);
      s.session = { authenticated: true, address: EVM, loading: false };
      s.auth.currentUser = { uid: EVM.toLowerCase() };
      renderHook(() => useAutoSiwe());
      await act(async () => {});
      expect(s.logout).not.toHaveBeenCalled();
    });

    it("does nothing when there is no Firebase user (avoids a logout loop)", async () => {
      connect(SOL_REAL, null);
      s.session = { authenticated: true, address: SOL_REAL, loading: false };
      renderHook(() => useAutoSiwe());
      await act(async () => {});
      expect(s.logout).not.toHaveBeenCalled();
    });
  });

  it("logs in with an EVM wallet: payload → sign → verify → firebase → refresh", async () => {
    connect(EVM, 1);
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: EVM, chainId: 1 });
    expect(s.signMessage).toHaveBeenCalledWith("Sign in to Agent Guild");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/verify");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ payload: { nonce: "n" }, signature: "sig" });
    expect(fetchMock.mock.calls[1][1].credentials).toBe("include");
    expect(s.signInWithCustomToken).toHaveBeenCalledWith(s.auth, "fb-token");
  });

  it("logs in with a Solana wallet using the chainId 0 sentinel", async () => {
    connect(SOL, 0);
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: SOL, chainId: 0 });
  });

  it("omits chainId when the wallet reports none", async () => {
    connect(EVM, null);
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: EVM });
  });

  it("waits for the session check to finish", async () => {
    connect(EVM, 1);
    s.session.loading = true;
    renderHook(() => useAutoSiwe());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when already authenticated as the connected wallet", async () => {
    connect(EVM, 1);
    s.session = { authenticated: true, address: EVM.toLowerCase(), loading: false };
    renderHook(() => useAutoSiwe());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.logout).not.toHaveBeenCalled();
  });

  it("does nothing while the wallet is connecting", async () => {
    connect(null, null, "connecting");
    s.session = { authenticated: true, address: EVM, loading: false };
    renderHook(() => useAutoSiwe());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.logout).not.toHaveBeenCalled();
  });

  it("toggling Solana → EVM logs out the Solana session, then signs in with EVM", async () => {
    connect(SOL, 0);
    s.session = { authenticated: true, address: SOL, loading: false };
    const { rerender } = renderHook(() => useAutoSiwe());
    expect(s.logout).not.toHaveBeenCalled();

    connect(EVM, 1);
    rerender();
    expect(s.logout).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    s.session = { authenticated: false, address: null, loading: false };
    rerender();
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: EVM, chainId: 1 });
  });

  it("toggling EVM → Solana re-authenticates as Solana", async () => {
    connect(EVM, 1);
    s.session = { authenticated: true, address: EVM, loading: false };
    const { rerender } = renderHook(() => useAutoSiwe());

    connect(SOL, 0);
    rerender();
    expect(s.logout).toHaveBeenCalledTimes(1);

    s.session = { authenticated: false, address: null, loading: false };
    rerender();
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ address: SOL, chainId: 0 });
  });

  it("stays logged in through the connecting gap mid-switch", async () => {
    connect(SOL, 0);
    s.session = { authenticated: true, address: SOL, loading: false };
    const { rerender } = renderHook(() => useAutoSiwe());
    connect(null, null, "connecting");
    rerender();
    expect(s.logout).not.toHaveBeenCalled();
  });

  it("replaces a session that belongs to a different address on load", async () => {
    connect(EVM, 1);
    s.session = { authenticated: true, address: SOL, loading: false };
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.logout).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compares session and wallet addresses case-insensitively", async () => {
    connect(EVM, 1);
    s.session = { authenticated: true, address: EVM.toUpperCase().replace("0X", "0x"), loading: false };
    renderHook(() => useAutoSiwe());
    await new Promise((r) => setTimeout(r, 20));
    expect(s.logout).not.toHaveBeenCalled();
  });

  it("logs out when the wallet disconnects", async () => {
    connect(EVM, 1);
    s.session = { authenticated: true, address: EVM, loading: false };
    const { rerender } = renderHook(() => useAutoSiwe());
    connect(null, null);
    rerender();
    expect(s.logout).toHaveBeenCalledTimes(1);
  });

  it("does not log out on disconnect when never authenticated", async () => {
    const { rerender } = renderHook(() => useAutoSiwe());
    connect(null, null);
    rerender();
    expect(s.logout).not.toHaveBeenCalled();
  });

  it("on 'Signer mismatch' disconnects and clears persisted wallet state", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("Signer mismatch"));
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.clearWalletStorage).toHaveBeenCalled());
    expect(s.disconnect).toHaveBeenCalled();
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it("still clears storage if the disconnect itself fails", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("signer MISMATCH for account"));
    s.disconnect.mockRejectedValue(new Error("boom"));
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.clearWalletStorage).toHaveBeenCalled());
  });

  it("does not disconnect on other errors (e.g. user rejected)", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("User rejected the request"));
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.signMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(s.clearWalletStorage).not.toHaveBeenCalled();
  });

  it("does not retry a failed address in a loop", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("User rejected the request"));
    const { rerender } = renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.signMessage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.signMessage).toHaveBeenCalledTimes(1);
  });

  it("retries after toggling to the other account", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValueOnce(new Error("User rejected the request"));
    const { rerender } = renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.signMessage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    connect(SOL, 0);
    rerender();
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-2)![1].body)).toEqual({ address: SOL, chainId: 0 });
  });

  it("retries the same address after a reconnect", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValueOnce(new Error("User rejected the request"));
    const { rerender } = renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.signMessage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    connect(null, null);
    rerender();
    connect(EVM, 1);
    rerender();
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
  });

  it("does not refresh when the payload request fails", async () => {
    connect(EVM, 1);
    fetchMock.mockResolvedValue(fail(500, "nonce store down"));
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.signMessage).not.toHaveBeenCalled();
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh when verification fails", async () => {
    connect(EVM, 1);
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/payload" ? ok({ payload: {}, message: "m" }) : fail(401, "Invalid signature"),
    );
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it("still refreshes the session if Firebase sign-in fails", async () => {
    connect(EVM, 1);
    s.signInWithCustomToken.mockRejectedValue(new Error("firebase down"));
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
  });

  it("skips Firebase sign-in when the server returns no token", async () => {
    connect(EVM, 1);
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/payload" ? ok({ payload: {}, message: "m" }) : ok({}),
    );
    renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(s.signInWithCustomToken).not.toHaveBeenCalled();
  });

  it("only signs once while a login is in flight", async () => {
    connect(EVM, 1);
    let release!: (v: string) => void;
    s.signMessage.mockReturnValue(new Promise<string>((r) => (release = r)));
    const { rerender } = renderHook(() => useAutoSiwe());
    await waitFor(() => expect(s.signMessage).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    release("sig");
    await waitFor(() => expect(s.refresh).toHaveBeenCalledTimes(1));
    expect(s.signMessage).toHaveBeenCalledTimes(1);
  });
});

describe("auto-login status", () => {
  const useBoth = () => ({ status: useAutoLoginStatus(), _: useAutoSiwe() });

  it("starts idle", () => {
    const { result } = renderHook(() => useAutoLoginStatus());
    expect(result.current).toEqual({ phase: "idle", error: null });
  });

  it("goes signing → verifying → idle on success", async () => {
    connect(EVM, 1);
    let release!: (v: string) => void;
    s.signMessage.mockReturnValue(new Promise<string>((r) => (release = r)));
    const phases: string[] = [];
    const { result } = renderHook(() => {
      const r = useBoth();
      phases.push(r.status.phase);
      return r;
    });
    await waitFor(() => expect(result.current.status.phase).toBe("signing"));
    await act(async () => release("sig"));
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status.phase).toBe("idle"));
    expect(phases).toContain("verifying");
  });

  it("reports the server's error message on failure", async () => {
    connect(EVM, 1);
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/payload" ? ok({ payload: {}, message: "m" }) : fail(401, "Invalid signature"),
    );
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.status).toEqual({ phase: "failed", error: "Invalid signature" }));
  });

  it("reports a wallet rejection", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("User rejected the request"));
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.status.phase).toBe("failed"));
    expect(result.current.status.error).toBe("User rejected the request");
  });

  it("times out a signature that never comes back instead of hanging", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      connect(EVM, 1);
      s.signMessage.mockReturnValue(new Promise<string>(() => {}));
      const { result } = renderHook(useBoth);
      await waitFor(() => expect(result.current.status.phase).toBe("signing"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS + 10);
      });
      await waitFor(() => expect(result.current.status.phase).toBe("failed"));
      expect(result.current.status.error).toMatch(/didn't return a signature/);
      expect(fetchMock).toHaveBeenCalledTimes(1); // never reached verify
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a signature that arrives in time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      connect(EVM, 1);
      let release!: (v: string) => void;
      s.signMessage.mockReturnValue(new Promise<string>((r) => (release = r)));
      const { result } = renderHook(useBoth);
      await waitFor(() => expect(result.current.status.phase).toBe("signing"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS - 1000);
        release("sig");
      });
      await waitFor(() => expect(s.refresh).toHaveBeenCalled());
      expect(result.current.status.phase).not.toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryAutoLogin signs in again for the same wallet", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValueOnce(new Error("User rejected the request"));
    const { result } = renderHook(useBoth);
    await waitFor(() => expect(result.current.status.phase).toBe("failed"));
    expect(s.signMessage).toHaveBeenCalledTimes(1);

    act(() => retryAutoLogin());
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
    expect(s.signMessage).toHaveBeenCalledTimes(2);
    expect(result.current.status.phase).toBe("idle");
  });

  it("clears a failure when the wallet disconnects", async () => {
    connect(EVM, 1);
    s.signMessage.mockRejectedValue(new Error("nope"));
    const { result, rerender } = renderHook(useBoth);
    await waitFor(() => expect(result.current.status.phase).toBe("failed"));
    connect(null, null);
    rerender();
    await waitFor(() => expect(result.current.status.phase).toBe("idle"));
  });
});

