/**
 * Auth Provider - Re-exports SessionContext for backward compatibility
 *
 * Some pages import from @/components/auth-provider expecting useAuth hook.
 * This file provides that compatibility layer.
 */

'use client';

import { useSession as useSessionContext } from '@/contexts/SessionContext';

export function useAuth() {
  const session = useSessionContext();

  return {
    user: session.address,
    address: session.address,
    authenticated: session.authenticated,
    loading: session.loading || false,
  };
}

// Also export the provider for completeness
export { SessionProvider as AuthProvider } from '@/contexts/SessionContext';
