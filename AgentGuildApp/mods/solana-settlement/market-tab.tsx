"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Card, ErrorNote, Skeleton, Stat, cx, mono, muted, timeAgo } from "./ui";

// Market data pieces used by the Trade view: what agents see through
// solana_token_price and solana_swap_quote. Mainnet data from Jupiter,
// read-only — the same numbers an agent reasons with before it acts.

export type Api = (path: string, init?: RequestInit) => Promise<Response>;

interface Price { mint: string; symbol: string | null; usdPrice: number | null; priceChange24hPct: number | null }
export interface Quote {
  inUi: string; outUi: string; minOutUi: string; rate: number; priceImpactPct: number;
  slippageBps: number; usdValue: number | null; route: string[]; inputMint: string; outputMint: string;
  inSymbol: string | null; outSymbol: string | null;
}

/** Tokens offered as one-click picks; any other symbol or mint address works too. */
export const TOKENS = ["USDC", "SOL", "USDT", "JUP", "BONK"];

export async function getJson<T>(api: Api, path: string): Promise<T> {
  const res = await api(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function usd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1) return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  if (n === 0) return "$0";
  // Small prices: keep 4 significant digits so BONK doesn't read as $0.00.
  return `$${n.toPrecision(4).replace(/0+$/, "")}`;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

/** Live USD prices for the common tokens, refreshed every 30s. */
export function PricesCard({ api }: { api: Api }) {
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pricedAt, setPricedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(() => {
    setError(null);
    getJson<{ prices: Price[] }>(api, `market/price?mints=${TOKENS.join(",")}`)
      .then((d) => { setPrices(d.prices); setPricedAt(Date.now()); })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    const clock = setInterval(() => tick((n) => n + 1), 10_000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load]);

  return (
    <Card title="Prices" description={pricedAt ? `Mainnet, via Jupiter · updated ${timeAgo(pricedAt)}` : "Mainnet, via Jupiter"}
      actions={<Button className="h-8" variant="ghost" icon={RefreshCw} onClick={load}>Refresh</Button>}>
      {error ? <ErrorNote message={error} onRetry={load} /> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {(prices ?? TOKENS.map(() => null)).map((p, i) => p ? (
            <Stat key={p.mint} label={p.symbol ?? p.mint.slice(0, 6)} value={usd(p.usdPrice)}
              sub={<span className={cx(p.priceChange24hPct != null && p.priceChange24hPct > 0 && "text-green-600 dark:text-green-400", p.priceChange24hPct != null && p.priceChange24hPct < 0 && "text-red-600 dark:text-red-400")}>{pct(p.priceChange24hPct)} 24h</span>} />
          ) : <Skeleton key={i} className="h-[68px]" />)}
        </div>
      )}
    </Card>
  );
}

/** Up to 6 significant digits, so a quote never wraps mid-number. */
const sig = (n: number) => n.toLocaleString(undefined, { maximumSignificantDigits: 6 });

/** What a swap would fill at right now: output, rate, slippage floor, impact, route. */
export function QuoteSummary({ q }: { q: Quote }) {
  const inLabel = q.inSymbol ?? `${q.inputMint.slice(0, 4)}…`;
  const outLabel = q.outSymbol ?? `${q.outputMint.slice(0, 4)}…`;
  const impactTone = q.priceImpactPct >= 1 ? "danger" : q.priceImpactPct >= 0.3 ? "warning" : "success";
  return (
    <div className="space-y-3 rounded-lg border border-[hsl(var(--border))] p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cx("text-xs", muted)}>You get about</span>
        <span className="font-mono text-xl font-semibold tabular-nums">{sig(Number(q.outUi))}</span>
        <span className="text-sm">{outLabel}</span>
        <span className={cx("text-xs", muted)}>for {q.inUi} {inLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat wrap label="Rate" value={q.rate >= 1 || q.rate <= 0 ? `1 ${inLabel} = ${sig(q.rate)} ${outLabel}` : `1 ${outLabel} = ${sig(1 / q.rate)} ${inLabel}`} />
        <Stat label="At least" value={sig(Number(q.minOutUi))} sub={`after ${q.slippageBps / 100}% slippage`} />
        <Stat label="Price impact" value={<Badge tone={impactTone}>{q.priceImpactPct < 0.01 ? "<0.01%" : `${q.priceImpactPct.toFixed(2)}%`}</Badge>} />
        <Stat label="Value" value={usd(q.usdValue)} />
      </div>
      <div className={cx("flex flex-wrap items-center gap-1.5 text-xs", muted)}>
        <span>Route</span>
        {q.route.length ? q.route.map((r, i) => <span key={i} className="flex items-center gap-1.5">{i > 0 && <span aria-hidden>›</span>}<Badge>{r}</Badge></span>) : <span className={mono}>direct</span>}
      </div>
    </div>
  );
}
