/** Dynamic Import Wrapper — Lazy-loads heavy components to reduce initial bundle size. */
'use client';

import dynamic from 'next/dynamic';
import { type ReactNode } from 'react';

const Web3ProviderInner = dynamic(
  () => import('./dynamic-inner').then(mod => ({ default: mod.Web3ProviderInner })),
  { ssr: false }
);

export function Web3Provider({ children }: { children: ReactNode }) {
  return <Web3ProviderInner>{children}</Web3ProviderInner>;
}
