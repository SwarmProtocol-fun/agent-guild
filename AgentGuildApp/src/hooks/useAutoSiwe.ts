/**
 * useAutoSiwe — Auto-trigger SIWE login when a wallet connects.
 *
 * Watches the wallet adapter (src/lib/wallet). When a wallet connects and
 * the user is NOT yet authenticated (no server session), this hook:
 *   1. POST /api/auth/payload  → get SIWE payload + message
 *   2. Sign the message with the wallet
 *   3. POST /api/auth/verify   → verify signature, create session
 *   4. Refresh SessionContext
 *
 * Guards:
 *   - Waits for session loading to complete
 *   - Skips if already authenticated
 *   - Prevents duplicate concurrent logins via signingRef
 *   - Detects wallet changes via lastAddressRef
 */
"use client";

import { useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useSession } from "@/contexts/SessionContext";
import { useWallet, useWalletSignMessage, useDisconnectWallet, clearWalletStorage } from "@/lib/wallet";
import { debug } from "@/lib/debug";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

/** How long to wait for the wallet to return a signature before giving up. */
export const SIGN_TIMEOUT_MS = 60_000;

export type AutoLoginPhase = "idle" | "signing" | "verifying" | "failed";
export interface AutoLoginStatus {
  phase: AutoLoginPhase;
  /** Last failure message, when phase is "failed". */
  error: string | null;
  /**
   * Logged in, but no Firebase Auth session — client Firestore reads/writes
   * will fail with "Missing or insufficient permissions" until re-login.
   */
  warning?: string | null;
}

// Module-level so the landing page (and anything else) can show what the
// globally-mounted auto-login is doing, instead of an endless spinner.
let status: AutoLoginStatus = { phase: "idle", error: null };
let retryNonce = 0;
// Session addresses already logged out once for a stale Firebase uid.
const staleUidResets = new Set<string>();
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function setStatus(next: AutoLoginStatus) {
  status = next;
  emit();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const IDLE: AutoLoginStatus = { phase: "idle", error: null };
const FIREBASE_WARNING =
  "You're signed in, but the database connection couldn't be established, so some actions will fail. Sign in again to fix it.";

/** Current auto-login phase and last error. */
export function useAutoLoginStatus(): AutoLoginStatus {
  return useSyncExternalStore(subscribe, () => status, () => IDLE);
}

/** Retry a failed login for the connected wallet. */
export function retryAutoLogin() {
  retryNonce += 1;
  staleUidResets.clear();
  setStatus(IDLE);
}

function useRetryNonce() {
  return useSyncExternalStore(subscribe, () => retryNonce, () => 0);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function useAutoSiwe() {
  const { address, chainId, status: walletStatus } = useWallet();
  const signMessage = useWalletSignMessage();
  const { authenticated, address: sessionAddress, loading, refresh, logout } = useSession();
  const disconnectWallet = useDisconnectWallet();
  const signingRef = useRef(false);
  // Address whose login attempt failed — don't retry it in a loop; the user
  // has to reconnect (clears it) before we try again.
  const failedAddressRef = useRef<string | null>(null);
  const lastAddressRef = useRef<string | null>(null);
  const retry = useRetryNonce();
  const lastRetryRef = useRef(retry);

  const triggerLogin = useCallback(
    async (walletAddress: string, walletChainId: number | null) => {
      if (signingRef.current) {
        debug.log("[Agent Guild:autoLogin] Already signing, skipping");
        return;
      }

      signingRef.current = true;
      setStatus({ phase: "signing", error: null });
      debug.log("[Agent Guild:autoLogin] Triggering auto-login for", walletAddress);

      try {
        // 1. Get SIWE payload + message from server
        const payloadRes = await fetch("/api/auth/payload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: walletAddress, chainId: walletChainId ?? undefined }),
        });

        if (!payloadRes.ok) {
          const err = await payloadRes.json().catch(() => ({}));
          throw new Error(err.error || `Payload request failed: ${payloadRes.status}`);
        }

        const { payload, message } = await payloadRes.json();

        // 2. Sign the SIWE message with the connected wallet
        const signature = await withTimeout(
          signMessage(message),
          SIGN_TIMEOUT_MS,
          "The wallet didn't return a signature. Open your wallet and try again.",
        );
        debug.log("[Agent Guild:autoLogin] Message signed");
        setStatus({ phase: "verifying", error: null });

        // 3. Verify signature and create session
        const verifyRes = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ payload, signature }),
        });

        if (!verifyRes.ok) {
          const err = await verifyRes.json().catch(() => ({}));
          throw new Error(err.error || `Verify request failed: ${verifyRes.status}`);
        }

        // 4. Establish a real Firebase Auth session (uid = wallet address)
        // so the client SDK's Firestore rules checks (request.auth) work.
        // Failure here doesn't fail the login (the session cookie still
        // serves server-side routes), but it's surfaced: without it every
        // client Firestore call is denied.
        const { firebaseToken } = await verifyRes.json().catch(() => ({}));
        let warning: string | null = null;
        if (!firebaseToken) {
          warning = FIREBASE_WARNING;
          debug.error("[Agent Guild:autoLogin] Server returned no Firebase token");
        } else {
          try {
            await signInWithCustomToken(auth, firebaseToken);
          } catch (err) {
            warning = FIREBASE_WARNING;
            debug.error("[Agent Guild:autoLogin] Firebase sign-in failed:", err);
          }
        }

        // 5. Refresh session context to pick up the new cookie
        await refresh();
        setStatus({ ...IDLE, warning });
      } catch (err) {
        debug.error("[Agent Guild:autoLogin] Login failed:", err);
        failedAddressRef.current = walletAddress.toLowerCase();
        setStatus({ phase: "failed", error: String((err as Error)?.message ?? err) || "Login failed" });
        // "Signer mismatch" (Magic embedded wallet): the remembered wagmi
        // connection no longer matches the live social-login session.
        // Drop it (and the persisted connection that would restore it on
        // reload) so the user can reconnect cleanly.
        if (/signer mismatch/i.test(String((err as Error)?.message ?? err))) {
          try {
            await disconnectWallet();
          } catch (disconnectErr) {
            debug.error("[Agent Guild:autoLogin] Disconnect failed:", disconnectErr);
          }
          clearWalletStorage();
        }
      } finally {
        signingRef.current = false;
      }
    },
    [refresh, signMessage, disconnectWallet]
  );

  // A valid server session skips SIWE, so the Firebase Auth user restored
  // from IndexedDB is never re-minted. If its uid isn't the canonical session
  // address (e.g. a Solana uid lowercased by an older /api/auth/verify),
  // isOrgMember() denies every client write with "Missing or insufficient
  // permissions". Drop the session so auto-login mints a fresh token.
  useEffect(() => {
    if (loading || !authenticated || !sessionAddress) return;
    let cancelled = false;
    Promise.resolve(auth.authStateReady?.())
      .then(() => {
        const uid = auth.currentUser?.uid;
        const expected = canonicalizeWalletAddress(sessionAddress);
        if (cancelled || !uid || uid === expected) return;
        // Once per address: if a fresh login still yields a mismatched uid
        // (sign-in failed, or a server minting the old format), logging out
        // again would loop the user through wallet prompts forever.
        if (staleUidResets.has(expected)) {
          debug.error("[Agent Guild:autoLogin] Firebase uid still doesn't match session after re-login:", uid);
          return;
        }
        staleUidResets.add(expected);
        debug.log("[Agent Guild:autoLogin] Firebase uid doesn't match session, re-authenticating");
        logout();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loading, authenticated, sessionAddress, logout]);

  useEffect(() => {
    // Wait for session check to complete
    if (loading) return;

    // retryAutoLogin() → allow another attempt for the failed address.
    if (retry !== lastRetryRef.current) {
      lastRetryRef.current = retry;
      failedAddressRef.current = null;
    }

    // Wallet disconnected → log out if we were authenticated
    if (!address) {
      failedAddressRef.current = null;
      if (status.phase === "failed") setStatus(IDLE);
      // Don't treat an in-flight reconnect as a disconnect
      if (walletStatus === "connecting") return;
      if (lastAddressRef.current && authenticated) {
        debug.log("[Agent Guild:autoLogin] Wallet disconnected, logging out");
        lastAddressRef.current = null;
        logout();
      }
      return;
    }

    // Wallet changed → log out the old session first
    const currentAddress = address.toLowerCase();
    if (lastAddressRef.current && lastAddressRef.current !== currentAddress && authenticated) {
      lastAddressRef.current = currentAddress;
      logout();
      return;
    }
    lastAddressRef.current = currentAddress;

    // Session belongs to a different address than the connected wallet (e.g.
    // an embedded wallet signed in with its Solana account before its EVM
    // account connected) — replace it with one for the current wallet.
    if (authenticated && sessionAddress && sessionAddress.toLowerCase() !== currentAddress) {
      debug.log("[Agent Guild:autoLogin] Session address differs from wallet, re-authenticating");
      logout();
      return;
    }

    if (authenticated || signingRef.current) return;
    if (failedAddressRef.current === currentAddress) return;

    triggerLogin(address, chainId);
  }, [address, chainId, walletStatus, loading, authenticated, sessionAddress, retry, triggerLogin, logout]);
}
