/**
 * useAuthAddress — Returns the authenticated user's address.
 *
 * Combines wallet connection (useWalletAccount) with server-backed session
 * (SessionContext) so pages don't show "Connect your wallet" when the
 * wallet reconnects slowly but the session is still valid.
 *
 * Priority: wallet address > session address > null
 */
"use client";

import { useWalletAccount } from "@/lib/wallet";
import { useSession } from "@/contexts/SessionContext";

export function useAuthAddress(): string | null {
    const account = useWalletAccount();
    const { authenticated, address: sessionAddress } = useSession();
    return account?.address || (authenticated ? sessionAddress : null) || null;
}
