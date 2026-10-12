"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowDownUp, ArrowLeftRight, LineChart, RefreshCw } from "lucide-react";
import {
  Badge, Button, Card, ErrorNote, Field, PageHeader, Select, Skeleton, Stat, TextInput, cx, mono, muted, timeAgo, useRunner,
} from "./ui";

// The Market view: what agents see through solana_token_price and
// solana_swap_quote. Mainnet data from Jupiter, read-only — the same
// numbers an agent reasons with before it acts.

type Api = (path: string, init?: RequestInit) => Promise<Response>;

interface Price { mint: string; symbol: string | null; usdPrice: number | null; priceChange24hPct: number | null }
interface Quote {
  inUi: string; outUi: string; minOutUi: string; rate: number; priceImpactPct: number;
  slippageBps: number; usdValue: number | null; route: string[]; inputMint: string; outputMint: string;
}

const WATCH = ["SOL", "USDC", "USDT", "JUP", "BONK"];
const TOKENS = ["SOL", "USDC", "USDT", "JUP", "BONK"];

async function getJson<T>(api: Api, path: string): Promise<T> {
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

export function MarketTab({ api }: { api: Api }) {
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const [pricedAt, setPricedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  const loadPrices = useCallback(() => {
    setPricesError(null);
    getJson<{ prices: Price[] }>(api, `market/price?mints=${WATCH.join(",")}`)
      .then((d) => { setPrices(d.prices); setPricedAt(Date.now()); })
      .catch((err: Error) => setPricesError(err.message));
  }, [api]);

  useEffect(() => {
    loadPrices();
    const t = setInterval(loadPrices, 30_000);
    const clock = setInterval(() => tick((n) => n + 1), 10_000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [loadPrices]);

  const [from, setFrom] = useState("SOL");
  const [to, setTo] = useState("USDC");
  const [amount, setAmount] = useState("1");
  const [slippage, setSlippage] = useState("50");
  const quote = useRunner<Quote>();

  function onQuote(e?: FormEvent) {
    e?.preventDefault();
    const q = new URLSearchParams({ inputMint: from.trim(), outputMint: to.trim(), amount: amount.trim(), slippageBps: slippage });
    quote.run(async () => (await getJson<{ quote: Quote }>(api, `market/quote?${q}`)).quote);
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={LineChart} title="Market"
        description="Live mainnet prices and swap routes from Jupiter — what agents read with solana_token_price and solana_swap_quote. Read-only; nothing is traded." />

      <Card title="Prices" description={pricedAt ? `Updated ${timeAgo(pricedAt)} · refreshes every 30s` : "Loading…"}
        actions={<Button className="h-8" variant="ghost" icon={RefreshCw} onClick={loadPrices}>Refresh</Button>}>
        {pricesError ? <ErrorNote message={pricesError} onRetry={loadPrices} /> : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {(prices ?? WATCH.map(() => null)).map((p, i) => p ? (
              <Stat key={p.mint} label={p.symbol ?? p.mint.slice(0, 6)} value={usd(p.usdPrice)}
                sub={<span className={cx(p.priceChange24hPct != null && p.priceChange24hPct > 0 && "text-green-600 dark:text-green-400", p.priceChange24hPct != null && p.priceChange24hPct < 0 && "text-red-600 dark:text-red-400")}>{pct(p.priceChange24hPct)} 24h</span>} />
            ) : <Skeleton key={i} className="h-[68px]" />)}
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" aria-hidden />Swap quote</span>}
        description="Best route across Solana DEXes for an exact input amount. Symbols or any mint address.">
        <form className="space-y-3" onSubmit={onQuote}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
            <Field label="Pay">{(id) => <TokenInput id={id} value={from} onChange={setFrom} />}</Field>
            <Button className="justify-self-center" variant="ghost" icon={ArrowDownUp} aria-label="Swap direction" title="Swap direction"
              onClick={() => { setFrom(to); setTo(from); }} />
            <Field label="Receive">{(id) => <TokenInput id={id} value={to} onChange={setTo} />}</Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Amount" className="w-36">{(id) => <TextInput id={id} mono inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
            <Field label="Max slippage">{(id) => (
              <Select id={id} value={slippage} onChange={(e) => setSlippage(e.target.value)}>
                {[["10", "0.1%"], ["50", "0.5%"], ["100", "1%"], ["300", "3%"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            )}</Field>
            <Button type="submit" variant="primary" loading={quote.loading} disabled={!amount.trim() || !from.trim() || !to.trim()}>Get quote</Button>
          </div>
        </form>

        {quote.error && <div className="mt-3"><ErrorNote message={quote.error} onRetry={() => onQuote()} /></div>}
        {quote.data && <QuoteResult q={quote.data} from={from} to={to} />}
      </Card>
    </div>
  );
}

function TokenInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <TextInput id={id} mono list={`${id}-tokens`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="SOL or mint address" />
      <datalist id={`${id}-tokens`}>{TOKENS.map((t) => <option key={t} value={t} />)}</datalist>
    </>
  );
}

function QuoteResult({ q, from, to }: { q: Quote; from: string; to: string }) {
  const label = (v: string) => (v.length > 10 ? `${v.slice(0, 4)}…` : v.toUpperCase());
  const impactTone = q.priceImpactPct >= 1 ? "danger" : q.priceImpactPct >= 0.3 ? "warning" : "success";
  return (
    <div className="mt-4 space-y-3 border-t border-[hsl(var(--border))]/60 pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-semibold tabular-nums">{q.outUi}</span>
        <span className={cx("text-sm", muted)}>{label(to)} for {q.inUi} {label(from)}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rate" value={`1 ${label(from)} = ${q.rate.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`} />
        <Stat label="Minimum received" value={q.minOutUi} sub={`after ${(q.slippageBps / 100).toString()}% slippage`} />
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
