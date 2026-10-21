"use client";

import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, Check, CircleAlert, Info, LoaderCircle, type LucideProps } from "lucide-react";

// The Robinhood panel's UI kit — the same tokens as the Ethereum and Solana
// panels (shadcn CSS variables), trimmed to what this panel uses. Kept
// in-mod so the mod doesn't depend on another mod being installed.

export type Icon = ComponentType<LucideProps>;
export type Tone = "neutral" | "success" | "danger" | "warning" | "info";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export const muted = "text-[hsl(var(--muted-foreground))]";
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]";

export const inputClass = cx(
  "h-9 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 text-sm",
  "placeholder:text-[hsl(var(--muted-foreground))]/70 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  ring,
);

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ variant = "secondary", loading, icon: IconC, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: Icon;
}) {
  return (
    <button type="button" disabled={disabled || loading} aria-busy={loading || undefined} {...rest}
      className={cx(
        "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        ring,
        variant === "primary" && "bg-[hsl(var(--primary))] text-white shadow-sm hover:bg-[hsl(var(--primary))]/90",
        variant === "secondary" && "border border-[hsl(var(--input))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]",
        variant === "ghost" && "hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]",
        variant === "danger" && "border border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300",
        className,
      )}>
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : IconC && <IconC className="h-4 w-4" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--card-foreground))]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold">{title}</h3>}
            {description && <p className={cx("mt-0.5 text-xs", muted)}>{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONE: Record<Tone, string> = {
  neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
  success: "bg-green-500/10 text-green-700 dark:text-green-400",
  danger: "bg-red-500/10 text-red-700 dark:text-red-400",
  warning: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  info: "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>{children}</span>;
}

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

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-[hsl(var(--border))] px-3 py-2.5">
      <div className={cx("text-[11px] font-medium uppercase tracking-wider", muted)}>{label}</div>
      <div className="mt-1 truncate font-mono text-sm tabular-nums">{value}</div>
      {sub && <div className={cx("mt-0.5 truncate text-[11px]", muted)}>{sub}</div>}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} autoComplete="off" className={cx(inputClass, className)} {...rest} />;
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-3 font-mono text-xs leading-relaxed">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Fetches JSON and throws the API's `error` message on a non-2xx. */
export async function json<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
  return d as T;
}

export const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  return s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
