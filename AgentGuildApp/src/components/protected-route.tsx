/** Protected Route — HOC that redirects to landing page if no valid session.
 *  Primary auth: server-backed session (httpOnly cookie).
 *  Secondary: wallet connection status (for reconnection UX).
 *  Uses contextual AuthState UI instead of generic spinners. */
'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useWalletAccount, useWalletConnectionStatus } from "@/lib/wallet";
import { useOrg } from '@/contexts/OrgContext';
import { useSession } from '@/contexts/SessionContext';
import { AuthState, ReconnectionBanner, type AuthPhase } from './auth-state';

// Grace period (ms) after first app load before allowing redirects.
// Must be long enough for session check to complete.
const AUTH_GRACE_MS = 1_500;

// Delay before redirecting to onboarding when no orgs found.
const ONBOARDING_REDIRECT_DELAY = 800;

// Delay before redirecting to landing page when session is invalid.
const DISCONNECT_REDIRECT_MS = 1_500;

// Module-level flags — survive across ProtectedRoute re-mounts (sidebar navigation).
let appAuthSettled = false;
let appHadOrgs = false;

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const account = useWalletAccount();
  const connectionStatus = useWalletConnectionStatus();
  const walletConnected = !!account;
  const { organizations, loading: orgLoading, error: orgError, refreshOrgs, agentCount, agentsLoading } = useOrg();
  const { authenticated, loading: sessionLoading } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // The user is considered "logged in" if they have a valid server session
  const isAuthenticated = authenticated;

  // Track whether wallet was ever connected in this mount
  const everConnected = useRef(false);
  if (walletConnected) everConnected.current = true;

  // Track whether we've ever seen orgs
  if (organizations.length > 0) appHadOrgs = true;

  // --- Grace period ---
  const mountTime = useRef(Date.now());
  const [graceOver, setGraceOver] = useState(appAuthSettled);

  useEffect(() => {
    if (appAuthSettled) return;
    const remaining = AUTH_GRACE_MS - (Date.now() - mountTime.current);
    if (remaining <= 0) {
      appAuthSettled = true;
      setGraceOver(true);
      return;
    }
    const timer = setTimeout(() => {
      appAuthSettled = true;
      setGraceOver(true);
    }, remaining);
    return () => clearTimeout(timer);
  }, []);

  // If session becomes valid during grace period, end it early
  useEffect(() => {
    if (isAuthenticated && !graceOver) {
      appAuthSettled = true;
      setGraceOver(true);
    }
  }, [isAuthenticated, graceOver]);

  // Wallet is still being reconnected
  const isReconnecting = connectionStatus === 'connecting';

  useEffect(() => {
    // Don't redirect during grace period or session loading.
    // Allow redirect even during wallet reconnection if session is already valid.
    if (!graceOver || sessionLoading) return;
    if (isReconnecting && !isAuthenticated) return;

    // No valid session — redirect to landing
    if (!isAuthenticated) {
      const delay = (appHadOrgs || everConnected.current)
        ? ONBOARDING_REDIRECT_DELAY
        : DISCONNECT_REDIRECT_MS;

      const timer = setTimeout(() => {
        router.push('/');
      }, delay);
      return () => clearTimeout(timer);
    }

    // Session is valid — check org state
    if (!orgLoading && isAuthenticated) {
      if (organizations.length === 0 && pathname !== '/onboarding') {
        const timer = setTimeout(() => router.push('/onboarding'), ONBOARDING_REDIRECT_DELAY);
        return () => clearTimeout(timer);
      } else if (organizations.length > 0 && !agentsLoading && agentCount === 0 && pathname !== '/onboarding') {
        // Org exists but has no registered agent yet — onboarding isn't
        // complete until the first agent is registered.
        const timer = setTimeout(() => router.push('/onboarding'), ONBOARDING_REDIRECT_DELAY);
        return () => clearTimeout(timer);
      } else if (organizations.length > 0 && agentCount > 0 && pathname === '/onboarding') {
        const timer = setTimeout(() => router.push('/dashboard'), 750);
        return () => clearTimeout(timer);
      }
    }
  }, [isAuthenticated, organizations.length, orgLoading, router, pathname, graceOver, isReconnecting, sessionLoading, agentCount, agentsLoading]);

  // --- Derive auth phase for contextual UI ---
  const authPhase = useMemo((): AuthPhase | null => {
    if (!graceOver || sessionLoading) return 'initializing';
    if (isReconnecting && !isAuthenticated) return everConnected.current ? 'reconnecting' : 'initializing';
    if (!isAuthenticated) return 'disconnected';
    if (orgLoading) return 'loading-org';
    if (orgError && organizations.length === 0) return 'error';
    if (organizations.length === 0 && pathname !== '/onboarding') return 'no-orgs';
    if (organizations.length > 0 && !agentsLoading && agentCount === 0 && pathname !== '/onboarding') return 'no-agents';
    return null;
  }, [graceOver, sessionLoading, isReconnecting, isAuthenticated, orgLoading, orgError, organizations.length, pathname, agentCount, agentsLoading]);

  // Brief reconnection during active session — show children + banner, don't block UI
  const showReconnectionBanner = graceOver && !walletConnected && isAuthenticated && everConnected.current && isReconnecting;

  if (authPhase && !showReconnectionBanner) {
    return (
      <AuthState
        phase={authPhase}
        error={orgError}
        onRetry={orgError ? refreshOrgs : undefined}
      />
    );
  }

  return (
    <>
      {showReconnectionBanner && <ReconnectionBanner visible />}
      {children}
    </>
  );
}
