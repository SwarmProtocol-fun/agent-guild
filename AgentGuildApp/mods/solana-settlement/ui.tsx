"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Cluster } from "./devtools";

// Shared UI for the Solana panel's tabs — styling matches the other mods' panels.

export type Tab = "agent" | "tx" | "account" | "idl" | "pda" | "error" | "simulate" | "anchor" | "network" | "settlement";

export interface SelectedAgent {
  agentId: string;
  name: string;
  orgId: string;
  orgName: string;
  /** Only the org owner can enable upgrades (POST /upgrade). */
  isOwner: boolean;
  capabilities: Record<string, boolean>;
  devWallet: string | null;
}

export interface Env {
  conn: Connection;
  cluster: Cluster;
  customUrl: string;
  explorer: (kind: "tx" | "address", id: string) => string;
  /** Jump to another tool with a value prefilled and run it. */
  go: (tab: Tab, value: string) => void;
  /** The agent the panel is acting as (picker in the header), if any. */
  agent: SelectedAgent | null;
  /** This mod's API, with the selected agent's id added to every call. */
  agentApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** Re-fetch the agent list (capabilities, dev wallet) after a change. */
  refreshAgents: () => void;
}

/** Value handed to a tool by cross-tab navigation; `nonce` re-triggers the same value. */
export interface Seed { value: string; nonce: number }

// ── UI primitives (match the other mods' panel styling) ──────────────────

export const mono = "font-mono text-xs break-all";
export const muted = "text-[hsl(var(--muted-foreground))]";
export const inputClass =
  "rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";

export function buttonClass(primary = false, extra = "") {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
    "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] ";
  return base + (primary
    ? "bg-[hsl(var(--primary))] text-white hover:bg-[hsl(var(--primary))]/90 "
    : "border border-[hsl(var(--input))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] ") + extra;
}

export function Section({ title, description, right, children }: { title: string; description?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--card-foreground))]">{title}</h2>
          {description && <p className={`text-xs ${muted} mt-0.5`}>{description}</p>}
        </div>
        {right}
      </div>
      <div className="p-3 space-y-3">{children}</div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "neutral" | "success" | "danger" | "warning"; children: ReactNode }) {
  const toneClass = {
    neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
    success: "bg-green-600/10 text-green-700 dark:text-green-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  }[tone];
  return <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneClass}`}>{children}</span>;
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="rounded-md bg-[hsl(var(--destructive))]/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{message}</div>;
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`text-xs ${muted} hover:text-[hsl(var(--foreground))] underline-offset-2 hover:underline`}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
    >
      {done ? "copied" : label}
    </button>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 border-b border-[hsl(var(--border))]/50 last:border-0 text-sm">
      <div className={`text-xs ${muted} pt-0.5`}>{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** An address with copy + an action to open it in the Account tool. */
export function Addr({ value, env, name }: { value: string; env: Env; name?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={`${mono} text-left text-blue-600 dark:text-blue-400 hover:underline`} onClick={() => env.go("account", value)}>
        {value}
      </button>
      {name && <Badge tone="neutral">{name}</Badge>}
      <CopyButton text={value} />
    </span>
  );
}

export function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <pre className="max-h-80 overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs">{text}</pre>
      <div className="absolute right-2 top-1"><CopyButton text={text} /></div>
    </div>
  );
}

export const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`;

/** Runs one async tool call at a time, keeping loading/error/result together. */
export function useRunner<T>() {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: T | null }>({ loading: false, error: null, data: null });
  const run = useCallback(async (fn: () => Promise<T>) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await fn() });
    } catch (err) {
      setState({ loading: false, error: (err as Error).message, data: null });
    }
  }, []);
  return { ...state, run };
}

/** Single-input tool form: value + submit, re-run when navigated to with a seed. */
export function useSeededInput(seed: Seed | undefined, onRun: (value: string) => void) {
  const [value, setValue] = useState(seed?.value ?? "");
  useEffect(() => {
    if (!seed?.value) return;
    setValue(seed.value);
    onRun(seed.value);
    // Re-run only when a new navigation arrives, not when onRun's identity changes.
  }, [seed?.nonce]);
  return [value, setValue] as const;
}

export function ToolForm({ value, onChange, onSubmit, placeholder, loading, action }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; loading: boolean; action: string;
}) {
  return (
    <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (value.trim()) onSubmit(); }}>
      <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <button type="submit" className={buttonClass(true)} disabled={loading || !value.trim()}>{loading ? "…" : action}</button>
    </form>
  );
}
