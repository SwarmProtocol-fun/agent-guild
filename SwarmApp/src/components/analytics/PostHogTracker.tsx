/**
 * PostHogTracker — global invisible component that wires up PostHog.
 *
 * Mounted once in layout.tsx, inside SessionProvider (needs useSession()).
 * Renders nothing:
 *  - Initializes posthog-js (no-ops if NEXT_PUBLIC_POSTHOG_KEY is unset)
 *  - Captures a $pageview on every client-side route change (app router
 *    doesn't fire posthog-js's own page-load capture on navigation)
 *  - Identifies the wallet address on login, resets identity on logout
 */
"use client";

import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession } from "@/contexts/SessionContext";
import { initPostHog, capturePageview, identifyWallet, resetIdentity } from "@/lib/posthog-client";

function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    const query = searchParams?.toString();
    capturePageview(query ? `${pathname}?${query}` : pathname);
  }, [pathname, searchParams]);

  return null;
}

function PostHogIdentity() {
  const { authenticated, address, role } = useSession();
  const identifiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (authenticated && address) {
      if (identifiedRef.current !== address) {
        identifyWallet(address, { role });
        identifiedRef.current = address;
      }
    } else if (identifiedRef.current) {
      resetIdentity();
      identifiedRef.current = null;
    }
  }, [authenticated, address, role]);

  return null;
}

export default function PostHogTracker() {
  useEffect(() => {
    initPostHog();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      <PostHogIdentity />
    </>
  );
}
