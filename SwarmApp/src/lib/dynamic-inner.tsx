/** Dynamic Inner — Internal component loaded by the dynamic wrapper after code splitting.
 *  Mounts the active wallet adapter's provider (see src/lib/wallet). */
'use client';
import { WalletProvider } from '@/lib/wallet';

export function Web3ProviderInner({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
