"use client";

import { useCallback, useEffect, useId, useState, type ButtonHTMLAttributes, type ComponentType, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AlertTriangle, Check, CircleAlert, Copy, ExternalLink, Info, LoaderCircle, ScanSearch, type LucideProps } from "lucide-react";
import type { Cluster } from "./devtools";

// Shared UI for the Solana panel. Everything is built on the app's shadcn
// CSS variables (--primary is the brand violet), so it follows light/dark
// and the active skin without hardcoded colors.

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
  /** Every Solana wallet the agent has — identity wallet first, then custodial ones. */
  wallets?: AgentSolanaWallet[];
}

export interface AgentSolanaWallet {
  address: string;
  label: string | null;
  /** Platform-held key (agentWallets) vs. the agent's own identity key. */
  custodial: boolean;
}

export interface Env {
  conn: Connection;
  cluster: Cluster;
  customUrl: string;
  explorer: (kind: "tx" | "address", id: string) => string;
  /** Jump to another tool with a value prefilled and run it. */
  go: (tab: Tab, value: string) => void;
  /** The agent the panel is acting as (sidebar switcher), if any. */
  agent: SelectedAgent | null;
  /** This mod's API, with the selected agent's id added to every call. */
  agentApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** Re-fetch the agent list (capabilities, dev wallet) after a change. */
  refreshAgents: () => void;
}

/** Value handed to a tool by cross-tab navigation; `nonce` re-triggers the same value. */
export interface Seed { value: string; nonce: number }

export type Icon = ComponentType<LucideProps>;

// ── Tokens & helpers ─────────────────────────────────────────────────────

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export const muted = "text-[hsl(var(--muted-foreground))]";
export const mono = "font-mono text-xs break-all";
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]";
export const linkClass = cx("text-[hsl(var(--primary))] hover:underline underline-offset-2 rounded-sm", ring);

export const inputClass = cx(
  "h-9 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 text-sm",
  "placeholder:text-[hsl(var(--muted-foreground))]/70 transition-colors",
  "disabled:cursor-not-allowed disabled:opacity-50",
  ring,
);

export const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`;

export const shortAddr = (a: string, n = 4) => (a.length > n * 2 + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

export function timeAgo(iso: string | number): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ── Buttons ──────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost";

export function buttonClass(variant: ButtonVariant | boolean = "secondary", extra = "") {
  const v: ButtonVariant = variant === true ? "primary" : variant === false ? "secondary" : variant;
  return cx(
    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    ring,
    v === "primary" && "bg-[hsl(var(--primary))] text-white shadow-sm hover:bg-[hsl(var(--primary))]/90",
    v === "secondary" && "border border-[hsl(var(--input))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]",
    v === "ghost" && "hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]",
    extra,
  );
}

export function Button({ variant = "secondary", loading, icon: IconC, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: Icon;
}) {
  return (
    <button type="button" className={buttonClass(variant, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : IconC && <IconC className="h-4 w-4" aria-hidden />}
      {children}
    </button>
  );
}

/** Square icon-only button with a real hit area and an accessible name. */
export function IconButton({ label, icon: IconC, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: Icon }) {
  return (
    <button type="button" aria-label={label} title={label}
      className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[hsl(var(--accent))]", muted, "hover:text-[hsl(var(--foreground))]", ring, className)} {...rest}>
      <IconC className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton label={done ? "Copied" : label} icon={done ? Check : Copy}
      className={done ? "text-green-600 dark:text-green-400" : undefined}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })} />
  );
}

// ── Layout ───────────────────────────────────────────────────────────────

/** Title block at the top of each view. */
export function PageHeader({ icon: IconC, title, description, actions }: { icon: Icon; title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]">
          <IconC className="h-[18px] w-[18px]" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight">{title}</h2>
          <p className={cx("mt-0.5 text-sm", muted)}>{description}</p>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className, bodyClassName }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--card-foreground))]", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {description && <p className={cx("mt-0.5 text-xs", muted)}>{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Small uppercase label above a group inside a card. */
export function SubHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h4 className={cx("text-[11px] font-semibold uppercase tracking-wider", muted)}>{children}</h4>
      {right}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      {children(id)}
      {hint && <p className={cx("text-xs", muted)}>{hint}</p>}
    </div>
  );
}

// React 19: `ref` is a plain prop, so it reaches the <input> through ...rest.
export function TextInput({ mono: isMono, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; ref?: React.Ref<HTMLInputElement> }) {
  return <input spellCheck={false} autoComplete="off" className={cx(inputClass, isMono && "font-mono text-xs", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputClass, "w-auto cursor-pointer pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

/** Example values a tool can be tried with — one click fills and runs. */
export function Examples({ items, onPick }: { items: { label: string; value: string }[]; onPick: (value: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cx("text-xs", muted)}>Try</span>
      {items.map((ex) => (
        <button key={ex.label} type="button" onClick={() => onPick(ex.value)}
          className={cx("rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs transition-colors hover:border-[hsl(var(--primary))]/50 hover:bg-[hsl(var(--primary))]/5", ring)}>
          {ex.label}
        </button>
      ))}
    </div>
  );
}

/** The main input of a single-value tool: labelled field, submit, examples. */
export function ToolForm({ label, value, onChange, onSubmit, placeholder, loading, action, examples }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder: string;
  loading: boolean;
  action: string;
  examples?: { label: string; value: string }[];
}) {
  const id = useId();
  return (
    <Card>
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-xs font-medium">{label}</label>
          <div className="flex gap-2">
            <TextInput id={id} mono placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
            <Button type="submit" variant="primary" loading={loading} disabled={!value.trim()} icon={ScanSearch}>{action}</Button>
          </div>
        </div>
        {examples && <Examples items={examples} onPick={(v) => { onChange(v); onSubmit(v); }} />}
      </form>
    </Card>
  );
}

// ── Feedback ─────────────────────────────────────────────────────────────

type Tone = "neutral" | "success" | "danger" | "warning" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
  success: "bg-green-500/10 text-green-700 dark:text-green-400",
  danger: "bg-red-500/10 text-red-700 dark:text-red-400",
  warning: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  info: "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]",
};

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** Inline message with an icon; pass `action` for a recovery step (retry, open settings…). */
export function Notice({ tone = "danger", title, children, action }: { tone?: "danger" | "warning" | "info" | "success"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const IconC = tone === "danger" ? CircleAlert : tone === "warning" ? AlertTriangle : tone === "success" ? Check : Info;
  const color = {
    danger: "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300",
    warning: "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200",
    info: "border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/5 text-[hsl(var(--foreground))]",
    success: "border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-300",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", color)}>
      <IconC className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5 break-words">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={title ? "text-xs opacity-90" : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Kept for call sites that only have a message. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Notice action={onRetry && <Button className="h-7 px-2 text-xs" onClick={onRetry}>Retry</Button>}>{message}</Notice>;
}

export function EmptyState({ icon: IconC, title, children }: { icon: Icon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[hsl(var(--border))] px-6 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--muted))]">
        <IconC className={cx("h-5 w-5", muted)} aria-hidden />
      </div>
      <div className="text-sm font-medium">{title}</div>
      {children && <div className={cx("max-w-md text-xs", muted)}>{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-[hsl(var(--muted))] motion-reduce:animate-none", className)} aria-hidden />;
}

// ── Data display ─────────────────────────────────────────────────────────

export function Stat({ label, value, sub, tone, wrap }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "success" | "danger"; wrap?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-[hsl(var(--border))] px-3 py-2.5">
      <div className={cx("text-[11px] font-medium uppercase tracking-wider", muted)}>{label}</div>
      <div className={cx("mt-1 font-mono text-sm tabular-nums", wrap ? "break-words" : "truncate", tone === "success" && "text-green-600 dark:text-green-400", tone === "danger" && "text-red-600 dark:text-red-400")}>{value}</div>
      {sub && <div className={cx("mt-0.5 truncate text-[11px]", muted)}>{sub}</div>}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b border-[hsl(var(--border))]/60 py-2 text-sm last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <div className={cx("text-xs sm:pt-0.5", muted)}>{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * An address: middle-truncated (full value on hover), opens in the Account
 * inspector, with copy + explorer actions. `full` shows it untruncated.
 */
export function Addr({ value, env, name, full }: { value: string; env: Env; name?: string | null; full?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      <button type="button" title={value} onClick={() => env.go("account", value)}
        className={cx("min-w-0 rounded-sm text-left font-mono text-xs text-[hsl(var(--primary))] hover:underline underline-offset-2", full ? "break-all" : "truncate", ring)}>
        {full ? value : shortAddr(value, 6)}
      </button>
      {name && <span className="ml-1.5"><Badge>{name}</Badge></span>}
      <CopyButton text={value} label="Copy address" />
      <a href={env.explorer("address", value)} target="_blank" rel="noreferrer" aria-label="Open in Solana Explorer" title="Open in Solana Explorer"
        className={cx("inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-[hsl(var(--accent))]", muted, ring)}>
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </span>
  );
}

export function CodeBlock({ code, title, maxHeight = "max-h-80", lineClass, wrap }: { code: string; title?: string; maxHeight?: string; lineClass?: (line: string) => string | undefined; wrap?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] py-0.5 pl-3 pr-1">
        <span className={cx("text-[11px] font-medium", muted)}>{title ?? "Output"}</span>
        <CopyButton text={code} />
      </div>
      <pre className={cx("overflow-auto p-3 font-mono text-xs leading-relaxed", wrap && "whitespace-pre-wrap break-all", maxHeight)}>
        {lineClass ? code.split("\n").map((line, i) => <div key={i} className={lineClass(line)}>{line || " "}</div>) : code}
      </pre>
    </div>
  );
}

export function Json({ value, title }: { value: unknown; title?: string }) {
  return <CodeBlock code={JSON.stringify(value, null, 2)} title={title ?? "JSON"} />;
}

/** Colors Solana program logs: failures red, CU accounting dimmed. */
export const logLineClass = (line: string) =>
  /failed|error/i.test(line) ? "text-red-600 dark:text-red-400" : /consumed \d+ of|^Program \w+ success$/.test(line) ? muted : undefined;

// ── Hooks ────────────────────────────────────────────────────────────────

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

/** Single-input tool state that re-runs when another tool navigates here with a value. */
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
