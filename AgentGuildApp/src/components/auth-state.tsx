/** AuthState — Contextual loading/error/reconnecting states for the auth flow.
 *  Replaces generic spinners with informative, branded UI. */
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ConnectWalletButton } from "@/lib/wallet";
import {
  WifiOff,
  LogOut,
  Building2,
  Sparkles,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export type AuthPhase =
  | 'initializing'
  | 'reconnecting'
  | 'disconnected'
  | 'loading-org'
  | 'no-orgs'
  | 'error';

interface AuthStateProps {
  phase: AuthPhase;
  error?: string | null;
  onRetry?: () => void;
}

export function AuthState({ phase, error, onRetry }: AuthStateProps) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex flex-col items-center gap-4 max-w-sm w-full px-6 animate-in fade-in duration-300">
        {phase === 'initializing' && <InitializingState />}
        {phase === 'reconnecting' && <ReconnectingState />}
        {phase === 'disconnected' && <DisconnectedState />}
        {phase === 'loading-org' && <LoadingOrgState />}
        {phase === 'no-orgs' && <NoOrgsState />}
        {phase === 'error' && <ErrorState error={error} onRetry={onRetry} />}
      </div>
    </div>
  );
}

function InitializingState() {
  return (
    <>
      <Image
        src="/Logo.jpg"
        alt="Agent Guild"
        width={48}
        height={48}
        className="animate-pulse drop-shadow-[0_0_12px_rgba(255,215,0,0.3)]"
      />
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Starting up...</h2>
        <p className="text-sm text-muted-foreground mt-1">Restoring your session</p>
      </div>
      <div className="h-1 w-32 rounded-full bg-muted overflow-hidden">
        <div className="h-full w-1/2 rounded-full bg-amber-500/60 animate-indeterminate" />
      </div>
    </>
  );
}

function ReconnectingState() {
  return (
    <>
      <div className="p-3 rounded-full bg-amber-500/10">
        <WifiOff className="h-6 w-6 text-amber-400 animate-pulse" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Reconnecting...</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your wallet connection dropped briefly. Restoring...
        </p>
      </div>
      <div className="h-1 w-32 rounded-full bg-muted overflow-hidden">
        <div className="h-full w-1/2 rounded-full bg-amber-500/60 animate-indeterminate" />
      </div>
    </>
  );
}

function DisconnectedState() {
  return (
    <>
      <div className="p-3 rounded-full bg-muted">
        <LogOut className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Session ended</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your wallet was disconnected.
        </p>
      </div>
      <ConnectWalletButton />
      <Link
        href="/"
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Back to home
      </Link>
    </>
  );
}

function LoadingOrgState() {
  return (
    <>
      <div className="p-3 rounded-full bg-amber-500/10">
        <Building2 className="h-6 w-6 text-amber-400" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Loading workspace...</h2>
        <p className="text-sm text-muted-foreground mt-1">Fetching your organization</p>
      </div>
      <div className="h-1 w-32 rounded-full bg-muted overflow-hidden">
        <div className="h-full w-1/2 rounded-full bg-amber-500/60 animate-indeterminate" />
      </div>
    </>
  );
}

function NoOrgsState() {
  return (
    <>
      <div className="p-3 rounded-full bg-amber-500/10">
        <Sparkles className="h-6 w-6 text-amber-400" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Welcome to Agent Guild</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create an organization to get started
        </p>
      </div>
      <Link href="/onboarding">
        <Button className="bg-amber-600 hover:bg-amber-700 text-black">
          Create Organization
        </Button>
      </Link>
    </>
  );
}

function ErrorState({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <>
      <div className="p-3 rounded-full bg-red-500/10">
        <AlertTriangle className="h-6 w-6 text-red-400" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">Connection error</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {error || 'Something went wrong while loading your workspace.'}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      )}
      <Link
        href="/"
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Disconnect &amp; go home
      </Link>
    </>
  );
}

/** Slim banner for brief wallet reconnections during active dashboard use. */
export function ReconnectionBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-center text-sm text-amber-400 animate-in slide-in-from-top duration-300">
      <span className="inline-flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        Reconnecting wallet...
      </span>
    </div>
  );
}
