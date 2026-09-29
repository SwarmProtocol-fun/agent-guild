/**
 * SessionContext — React context for server-backed session state.
 *
 * Provides the frontend with durable session info (address, role, authenticated status)
 * fetched from the httpOnly cookie via /api/auth/session.
 *
 * Auth flow: Wallet connect → SIWE sign → POST /api/auth/verify → session cookie.
 * The wallet connection is still used for signing transactions, but the *session*
 * is what determines auth state.
 */
"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { signOut as firebaseSignOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { clearWalletStorage } from "@/lib/wallet";
import { debug } from "@/lib/debug";

export type UserRole = "operator" | "org_admin" | "platform_admin";

export interface Session {
  authenticated: boolean;
  address: string | null;
  role: UserRole | null;
  sessionId: string | null;
}

interface SessionContextValue extends Session {
  /** Whether the initial session check is still loading */
  loading: boolean;
  /** Re-fetch session from server */
  refresh: () => Promise<void>;
  /** Destroy the current session */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  authenticated: false,
  address: null,
  role: null,
  sessionId: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({
    authenticated: false,
    address: null,
    role: null,
    sessionId: null,
  });
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  // Debug: log session state changes
  useEffect(() => {
    debug.log("[Agent Guild:Session] State updated:", session);
  }, [session]);

  const fetchSession = useCallback(async () => {
    debug.log("[Agent Guild:Session] Fetching session...");
    try {
      const res = await fetch("/api/auth/session", { credentials: "include" });
      debug.log("[Agent Guild:Session] Session response:", res.status);
      if (!res.ok) {
        debug.log("[Agent Guild:Session] Not authenticated");
        setSession({
          authenticated: false,
          address: null,
          role: null,
          sessionId: null,
        });
        return;
      }

      const data = await res.json();
      debug.log("[Agent Guild:Session] Session data:", data);
      const newSession = {
        authenticated: data.authenticated ?? false,
        address: data.address ?? null,
        role: data.role ?? null,
        sessionId: data.sessionId ?? null,
      };
      debug.log("[Agent Guild:Session] Setting session state to:", newSession);
      setSession(newSession);
    } catch (err) {
      debug.error("[Agent Guild:Session] Fetch error:", err);
      setSession({
        authenticated: false,
        address: null,
        role: null,
        sessionId: null,
      });
    } finally {
      setLoading(false);
      debug.log("[Agent Guild:Session] Loading complete");
    }
  }, []);

  // Fetch session on mount
  useEffect(() => {
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchSession();
    }
  }, [fetchSession]);

  // If session check completes as NOT authenticated, clear any stale
  // wallet state from localStorage. This prevents the wallet adapter from
  // auto-reconnecting and re-triggering SIWE when the user cleared cookies
  // externally (not through our logout flow).
  const cleanedRef = useRef(false);
  useEffect(() => {
    if (loading || session.authenticated || cleanedRef.current) return;
    cleanedRef.current = true;
    const removed = clearWalletStorage();
    if (removed > 0) debug.log("[Agent Guild:Session] Not authenticated — cleared stale wallet state:", removed, "keys");
  }, [loading, session.authenticated]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      // Clear Firebase Auth session (client-side Firestore access)
      await firebaseSignOut(auth).catch(() => {});
    } finally {
      // Clear persisted wallet state so the wallet doesn't auto-reconnect
      // and re-trigger SIWE on next load.
      clearWalletStorage();

      setSession({
        authenticated: false,
        address: null,
        role: null,
        sessionId: null,
      });
    }
  }, []);

  return (
    <SessionContext.Provider
      value={{
        ...session,
        loading,
        refresh: fetchSession,
        logout,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
