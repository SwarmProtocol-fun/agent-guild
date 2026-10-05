/**
 * AutoSiwe — Global component that auto-triggers SIWE login.
 *
 * Mounted in layout.tsx inside Web3Provider + SessionProvider.
 * Runs the useAutoSiwe hook so that wallet connections (including OAuth
 * redirect reconnections) automatically trigger SIWE signing and session
 * creation. Renders nothing unless the login left no Firebase Auth session,
 * which would otherwise only show up later as unexplained "Missing or
 * insufficient permissions" errors.
 */
"use client";

import { useAutoSiwe, useAutoLoginStatus, retryAutoLogin } from "@/hooks/useAutoSiwe";
import { useSession } from "@/contexts/SessionContext";
import { Button } from "@/components/ui/button";

export default function AutoSiwe() {
  useAutoSiwe();
  const { warning } = useAutoLoginStatus();
  const { logout } = useSession();
  if (!warning) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-lg border border-destructive/40 bg-background p-3 text-sm shadow-lg"
    >
      <p className="flex-1">{warning}</p>
      <Button
        size="sm"
        onClick={async () => {
          await logout();
          retryAutoLogin();
        }}
      >
        Sign in again
      </Button>
    </div>
  );
}
