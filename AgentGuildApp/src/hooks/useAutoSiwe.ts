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

import { useEffect, useRef, useCallback } from "react";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useSession } from "@/contexts/SessionContext";
import { useWallet, useWalletSignMessage, useDisconnectWallet, clearWalletStorage } from "@/lib/wallet";
import { debug } from "@/lib/debug";

export function useAutoSiwe() {
  const { address, chainId, status } = useWallet();
  const signMessage = useWalletSignMessage();
  const { authenticated, address: sessionAddress, loading, refresh, logout } = useSession();
  const disconnectWallet = useDisconnectWallet();
  const signingRef = useRef(false);
  // Address whose login attempt failed — don't retry it in a loop; the user
  // has to reconnect (clears it) before we try again.
  const failedAddressRef = useRef<string | null>(null);
  const lastAddressRef = useRef<string | null>(null);

  const triggerLogin = useCallback(
    async (walletAddress: string, walletChainId: number | null) => {
      if (signingRef.current) {
        debug.log("[Agent Guild:autoLogin] Already signing, skipping");
        return;
      }

      signingRef.current = true;
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
        const signature = await signMessage(message);
        debug.log("[Agent Guild:autoLogin] Message signed");

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
        const { firebaseToken } = await verifyRes.json().catch(() => ({}));
        if (firebaseToken) {
          try {
            await signInWithCustomToken(auth, firebaseToken);
          } catch (err) {
            debug.error("[Agent Guild:autoLogin] Firebase sign-in failed:", err);
          }
        }

        // 5. Refresh session context to pick up the new cookie
        await refresh();
      } catch (err) {
        debug.error("[Agent Guild:autoLogin] Login failed:", err);
        failedAddressRef.current = walletAddress.toLowerCase();
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

  useEffect(() => {
    // Wait for session check to complete
    if (loading) return;

    // Wallet disconnected → log out if we were authenticated
    if (!address) {
      failedAddressRef.current = null;
      // Don't treat an in-flight reconnect as a disconnect
      if (status === "connecting") return;
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
  }, [address, chainId, status, loading, authenticated, sessionAddress, triggerLogin, logout]);
}
