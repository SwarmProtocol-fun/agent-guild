/** Organization Context — React context providing current org, project selection, and org CRUD operations. */
'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useWalletAccount, useWalletConnectionStatus } from "@/lib/wallet";
import {
  createOrganization,
  getOrganizationsByWallet,
  type Organization
} from '@/lib/firestore';
import { useSession } from './SessionContext';

interface OrgContextValue {
  /** Currently selected organization */
  currentOrg: Organization | null;
  /** All organizations the user belongs to */
  organizations: Organization[];
  /** Whether we're still loading orgs */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Switch to a different org */
  selectOrg: (orgId: string) => void;
  /** Refresh the org list from Firestore */
  refreshOrgs: () => Promise<void>;
  /** Create a new organization */
  createOrg: (name: string, description?: string) => Promise<void>;
}

const OrgContext = createContext<OrgContextValue>({
  currentOrg: null,
  organizations: [],
  loading: true,
  error: null,
  selectOrg: () => { },
  refreshOrgs: async () => { },
  createOrg: async () => { },
});

export function useOrg() {
  return useContext(OrgContext);
}

const ORG_STORAGE_KEY = 'swarm_selected_org_id';

/** Grace period (ms) before clearing state on wallet disconnect.
 *  Must be longer than ProtectedRoute's AUTH_GRACE_MS (3s) to avoid
 *  the redirect seeing empty orgs before reconnection completes. */
const DISCONNECT_GRACE_MS = 6_000;

export function OrgProvider({ children }: { children: ReactNode }) {
  const account = useWalletAccount();
  const connectionStatus = useWalletConnectionStatus();
  const { address: sessionAddress, authenticated } = useSession();
  // Use wallet address if connected, otherwise fall back to session address
  const address = account?.address || (authenticated ? sessionAddress : null) || undefined;

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track the grace-period timer so we can cancel if wallet reconnects
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which address we last fetched for — prevents duplicate fetches
  // when connectionStatus changes but address stays the same.
  const lastFetchedAddress = useRef<string | null>(null);

  const fetchOrgs = useCallback(async (walletAddress: string) => {
    try {
      setError(null);
      const orgs = await getOrganizationsByWallet(walletAddress);
      setOrganizations(orgs);

      // Restore previously selected org
      let savedOrgId: string | null = null;
      try { savedOrgId = localStorage.getItem(ORG_STORAGE_KEY); } catch { /* private browsing */ }
      const savedOrg = orgs.find(o => o.id === savedOrgId);

      if (savedOrg) {
        setCurrentOrg(savedOrg);
      } else if (orgs.length === 1) {
        // Auto-select if only one org
        setCurrentOrg(orgs[0]);
        try { localStorage.setItem(ORG_STORAGE_KEY, orgs[0].id); } catch { /* private browsing */ }
      } else if (orgs.length > 1) {
        // Multiple orgs - select first one as default
        setCurrentOrg(orgs[0]);
        try { localStorage.setItem(ORG_STORAGE_KEY, orgs[0].id); } catch { /* private browsing */ }
      } else {
        // No orgs found
        setCurrentOrg(null);
        try { localStorage.removeItem(ORG_STORAGE_KEY); } catch { /* private browsing */ }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load organizations';
      console.error('Failed to fetch organizations:', err);
      setError(message);
    }
  }, []);

  const refreshOrgs = useCallback(async () => {
    if (!address) {
      setLoading(false);
      return;
    }

    setLoading(true);
    await fetchOrgs(address);
    setLoading(false);
  }, [address, fetchOrgs]);

  const selectOrg = useCallback((orgId: string) => {
    const org = organizations.find(o => o.id === orgId);
    if (org) {
      setCurrentOrg(org);
      try { localStorage.setItem(ORG_STORAGE_KEY, orgId); } catch { /* private browsing */ }
    }
  }, [organizations]);

  const createOrg = useCallback(async (name: string, description?: string) => {
    if (!address) {
      throw new Error('Wallet not connected');
    }

    try {
      setError(null);
      const orgId = await createOrganization({
        name,
        description: description || '',
        ownerAddress: address,
        members: [address], // Owner is also a member
        createdAt: new Date(),
      });

      // Refresh orgs to get the new one
      lastFetchedAddress.current = null; // Force re-fetch
      await refreshOrgs();

      // Auto-select the new org
      const newOrg = organizations.find(o => o.id === orgId) ||
        (await getOrganizationsByWallet(address)).find(o => o.id === orgId);

      if (newOrg) {
        setCurrentOrg(newOrg);
        try { localStorage.setItem(ORG_STORAGE_KEY, orgId); } catch { /* private browsing */ }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create organization';
      console.error('Failed to create organization:', err);
      setError(message);
      throw err;
    }
  }, [address, refreshOrgs, organizations]);

  // Load orgs when address is available (from wallet or session).
  // Only re-fetch when the address actually changes.
  useEffect(() => {
    if (address) {
      // Address available — cancel any pending disconnect timer
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
      // Only fetch if this is a new address
      if (address !== lastFetchedAddress.current) {
        lastFetchedAddress.current = address;
        refreshOrgs();
      }
    } else if (connectionStatus === 'connecting') {
      // Wallet is actively reconnecting — don't clear state yet.
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
    } else if (!authenticated) {
      // No wallet, no session — clear state after grace period
      lastFetchedAddress.current = null;
      if (!disconnectTimer.current) {
        disconnectTimer.current = setTimeout(() => {
          setOrganizations([]);
          setCurrentOrg(null);
          setLoading(false);
          disconnectTimer.current = null;
        }, DISCONNECT_GRACE_MS);
      }
    }

    return () => {
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
    };
  }, [address, connectionStatus, authenticated, refreshOrgs]);

  return (
    <OrgContext.Provider value={{
      currentOrg,
      organizations,
      loading,
      error,
      selectOrg,
      refreshOrgs,
      createOrg,
    }}>
      {children}
    </OrgContext.Provider>
  );
}