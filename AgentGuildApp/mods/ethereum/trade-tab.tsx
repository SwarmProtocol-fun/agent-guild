"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownUp, CandlestickChart, Fuel, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, Trophy } from "lucide-react";
import {
  Badge, Button, Card, ErrorNote, Field, Notice, PageHeader, Select, Skeleton, Stat, TextInput, cx, json, mono, muted, shortAddr, timeAgo, usd,
  type Env,
} from "./ui";

// The Trade view: live Ethereum mainnet prices, a swap form that previews
// the KyberSwap quote and fills it in the selected agent's paper wallet
// (paying the route's real gas), the wallet, its trades, the owner's
// limits and the org leaderboard. Market data is mainnet whatever network
// the panel is on — paper trades never touch a chain.

interface Price { token: string; symbol: string | null; usdPrice: number | null; priceChange24hPct: number | null }
interface Quote {
  inputToken: string; outputToken: string; inUi: string; outUi: string; minOutUi: string; rate: number; priceImpactPct: number;
  slippageBps: number; usdValue: number | null; gasUsd: number | null; route: string[]; inSymbol: string | null; outSymbol: string | null;
}
interface Line { token: string; symbol: string | null; amount: number; priceUsd: number | null; valueUsd: number | null; avgCostUsd: number; unrealizedUsd: number | null; weightPct: number | null }
interface Portfolio {
  equityUsd: number; startUsd: number; pnlUsd: number; returnPct: number; realizedUsd: number; unrealizedUsd: number;
  feesUsd: number; tradeCount: number; volumeUsd: number; unpriced: string[]; lines: Line[];
}
interface Policy { paused: boolean; maxTradeUsd: number | null; maxDailyVolumeUsd: number | null; allowedTokens: string[]; transferAllowlist: string[]; maxTransferEth: number | null }
interface Trade {
  id: string; at: string; inUi: string; outUi: string; inSymbol: string | null; outSymbol: string | null; inputToken: string; outputToken: string;
  usdValue: number; gasUsd: number; realizedUsd: number; priceImpactPct: number; route: string[]; note: string | null;
}
interface Ranked { agentId: string; name: string; equityUsd: number; pnlUsd: number; returnPct: number; tradeCount: number }

/** One-click picks; any other symbol or token address works too. */
const TOKENS = ["ETH", "USDC", "WBTC", "LINK", "UNI", "AAVE", "PEPE"];
const ALL_SYMBOLS = ["ETH", "WETH", "USDC", "USDT", "DAI", "WBTC", "LINK", "UNI", "AAVE", "LDO", "PEPE", "SHIB", "STETH"];

/** Prices under $1 keep 4 significant digits so PEPE doesn't read as $0.00. */
const price = (n: number | null) => (n == null ? "—" : n >= 1000 ? usd(n, 0) : n >= 1 || n === 0 ? usd(n) : `$${n.toPrecision(3).replace(/0+$/, "")}`);
const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`);
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;
const toneOf = (n: number | null) => (n == null || Math.abs(n) < 0.005 ? undefined : n > 0 ? "success" as const : "danger" as const);
const pnlClass = (n: number | null) => cx(n != null && n > 0.005 && "text-green-600 dark:text-green-400", n != null && n < -0.005 && "text-red-600 dark:text-red-400");
const tokenLabel = (symbol: string | null, token: string) => symbol ?? shortAddr(token, 4);

export function TradeTab({ env }: { env: Env }) {
  const { agent, agentApi, api } = env;
  const [data, setData] = useState<{ portfolio: Portfolio; policy: Policy; volumeTodayUsd: number; since: string } | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [board, setBoard] = useState<Ranked[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agent) return;
    try {
      const [p, t, l] = await Promise.all([
        json<NonNullable<typeof data>>(agentApi("paper")),
        json<{ trades: Trade[] }>(agentApi("paper/trades?limit=30")),
        json<{ leaderboard: Ranked[] }>(api("paper/leaderboard")).catch(() => ({ leaderboard: [] })),
      ]);
      setData(p);
      setTrades(t.trades);
      setBoard(l.leaderboard);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agent, agentApi, api]);

  useEffect(() => {
    setData(null);
    setTrades(null);
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const header = (
    <PageHeader icon={CandlestickChart} title="Trade"
      description="Real Ethereum mainnet prices and routes from KyberSwap, filled in a 10,000 USDC paper wallet that pays each route's real gas — no funds move. Agents trade the same way with eth_paper_swap." />
  );

  if (!agent) {
    return (
      <div className="space-y-4">
        {header}
        <PricesCard env={env} />
        <SwapCard env={env} canTrade={false} paused={false} holdings={[]} onDone={load} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {error && <ErrorNote message={error} onRetry={load} />}
      {data?.policy.paused && <Notice tone="warning" title={`${agent.name} is paused`}>Trades, transfers and signing are refused until the org owner resumes it.</Notice>}
      <PricesCard env={env} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SwapCard env={env} canTrade={!!agent.capabilities["eth-trade"]} paused={!!data?.policy.paused} holdings={data?.portfolio.lines ?? []} onDone={load} />
        <PolicyCard env={env} policy={data?.policy ?? null} volumeTodayUsd={data?.volumeTodayUsd ?? 0} onSaved={load} />
      </div>
      <PortfolioCard portfolio={data?.portfolio ?? null} since={data?.since ?? null} />
      <TradesCard trades={trades} />
      <LeaderboardCard board={board} current={agent.agentId} />
    </div>
  );
}

function PricesCard({ env }: { env: Env }) {
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pricedAt, setPricedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const { api } = env;

  const load = useCallback(() => {
    setError(null);
    json<{ prices: Price[] }>(api(`market/price?tokens=${TOKENS.join(",")}`))
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
    <Card title="Prices" description={pricedAt ? `Ethereum mainnet, via DefiLlama · updated ${timeAgo(pricedAt)}` : "Ethereum mainnet, via DefiLlama"}
      actions={<Button className="h-8" variant="ghost" icon={RefreshCw} onClick={load}>Refresh</Button>}>
      {error ? <ErrorNote message={error} onRetry={load} /> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {(prices ?? TOKENS.map(() => null)).map((p, i) => p ? (
            <Stat key={p.token} label={p.symbol ?? shortAddr(p.token)} value={price(p.usdPrice)}
              sub={<span className={pnlClass(p.priceChange24hPct)}>{pct(p.priceChange24hPct)} 24h</span>} />
          ) : <Skeleton key={i} className="h-[68px]" />)}
        </div>
      )}
    </Card>
  );
}

/** Up to 6 significant digits, so a quote never wraps mid-number. */
const sig = (n: number) => n.toLocaleString(undefined, { maximumSignificantDigits: 6 });

function QuoteSummary({ q }: { q: Quote }) {
  const inLabel = tokenLabel(q.inSymbol, q.inputToken);
  const outLabel = tokenLabel(q.outSymbol, q.outputToken);
  const impactTone = q.priceImpactPct >= 1 ? "danger" : q.priceImpactPct >= 0.3 ? "warning" : "success";
  const gasShare = q.gasUsd != null && q.usdValue ? (q.gasUsd / q.usdValue) * 100 : null;
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
        <Stat label="Price impact" value={<Badge tone={impactTone}>{q.priceImpactPct < 0.01 ? "<0.01%" : `${q.priceImpactPct.toFixed(2)}%`}</Badge>} sub={usd(q.usdValue)} />
        <Stat label="Gas" value={<span className="inline-flex items-center gap-1"><Fuel className="h-3 w-3" aria-hidden />{q.gasUsd != null ? usd(q.gasUsd, 2) : "—"}</span>}
          sub={gasShare != null ? `${gasShare < 0.01 ? "<0.01" : gasShare.toFixed(2)}% of the swap` : undefined} />
      </div>
      <div className={cx("flex flex-wrap items-center gap-1.5 text-xs", muted)}>
        <span>Route</span>
        {q.route.length ? q.route.map((r, i) => <span key={r} className="flex items-center gap-1.5">{i > 0 && <span aria-hidden>·</span>}<Badge>{r}</Badge></span>) : <span className={mono}>direct</span>}
      </div>
    </div>
  );
}

function SwapCard({ env, canTrade, paused, holdings, onDone }: { env: Env; canTrade: boolean; paused: boolean; holdings: Line[]; onDone: () => void }) {
  const { agent, api } = env;
  const [from, setFrom] = useState("USDC");
  const [to, setTo] = useState("ETH");
  const [amount, setAmount] = useState("500");
  const [slippage, setSlippage] = useState("50");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [quote, setQuote] = useState<{ q: Quote | null; error: string | null; loading: boolean }>({ q: null, error: null, loading: false });
  const [quoteNonce, setQuoteNonce] = useState(0);

  const sym = from.trim().toUpperCase();
  const held = holdings.find((h) => h.symbol?.toUpperCase() === sym || h.token.toLowerCase() === from.trim().toLowerCase());

  // "25%" / "all" resolve against the paper holding on the server; preview with the same share.
  const previewAmount = (() => {
    const a = amount.trim().toLowerCase();
    if (a !== "all" && !a.endsWith("%")) return a;
    if (!held) return "";
    const share = a === "all" ? 1 : Number(a.slice(0, -1)) / 100;
    return share > 0 && share <= 1 ? String(Number((held.amount * share).toFixed(6))) : "";
  })();

  // Live quote for the form, debounced so typing doesn't spam the aggregator.
  useEffect(() => {
    const [f, t] = [from.trim(), to.trim()];
    if (!f || !t || !(Number(previewAmount) > 0)) { setQuote({ q: null, error: null, loading: false }); return; }
    let live = true;
    setQuote((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({ inputToken: f, outputToken: t, amount: previewAmount, slippageBps: slippage });
      json<{ quote: Quote }>(api(`market/quote?${qs}`))
        .then((d) => live && setQuote({ q: d.quote, error: null, loading: false }))
        .catch((err: Error) => live && setQuote({ q: null, error: err.message, loading: false }));
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [api, from, to, previewAmount, slippage, quoteNonce]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { trade: t } = await json<{ trade: Trade }>(env.agentApi("paper/swap", {
        method: "POST",
        body: JSON.stringify({ inputToken: from.trim(), outputToken: to.trim(), amount: amount.trim(), slippageBps: Number(slippage), note: note.trim() || undefined }),
      }));
      setResult({ ok: true, text: `Swapped ${t.inUi} ${tokenLabel(t.inSymbol, t.inputToken)} for ${Number(t.outUi).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenLabel(t.outSymbol, t.outputToken)} (${usd(t.usdValue)}, gas ${usd(t.gasUsd, 2)})` });
      setNote("");
      setQuoteNonce((n) => n + 1);
      onDone();
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const blocker = !agent ? "Pick an agent in the sidebar to trade from its paper wallet — until then this is a quote."
    : !canTrade ? `${agent.name} needs the “Trade (paper)” upgrade — enable it on the Overview tab.`
    : paused ? `${agent.name} is paused by its org owner.`
    : null;

  return (
    <Card title={<span className="flex items-center gap-2"><ArrowDownUp className="h-4 w-4" aria-hidden />Swap</span>}
      description={agent ? `Previews the live quote, then fills it in ${agent.name}'s paper wallet under its owner's limits.` : "Live quote for any pair. Symbols or token addresses."}>
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
          <Field label="Sell">{(id) => <TokenField id={id} value={from} onChange={setFrom} />}</Field>
          <Button className="justify-self-center" variant="ghost" icon={ArrowDownUp} aria-label="Swap direction" title="Swap direction" onClick={() => { setFrom(to); setTo(from); }} />
          <Field label="Buy">{(id) => <TokenField id={id} value={to} onChange={setTo} />}</Field>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Amount" hint={agent ? (held ? `Holding ${held.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenLabel(held.symbol, held.token)}` : "Not held in the paper wallet") : undefined}>
            {(id) => (
              <div className="flex flex-wrap gap-2">
                <TextInput id={id} mono inputMode="decimal" className="w-36" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {agent && ["25%", "50%", "all"].map((v) => <Button key={v} className="h-9 px-2.5 text-xs" disabled={!held} onClick={() => setAmount(v)}>{v === "all" ? "Max" : v}</Button>)}
              </div>
            )}
          </Field>
          <Field label="Max slippage">{(id) => (
            <Select id={id} value={slippage} onChange={(e) => setSlippage(e.target.value)}>
              {[["10", "0.1%"], ["50", "0.5%"], ["100", "1%"], ["300", "3%"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          )}</Field>
        </div>

        {quote.error ? <Notice tone="warning">{quote.error}</Notice>
          : quote.q ? <div className={cx("transition-opacity", quote.loading && "opacity-60")}><QuoteSummary q={quote.q} /></div>
          : quote.loading ? <Skeleton className="h-32" /> : null}

        {agent && (
          <Field label="Why (optional)" hint="Kept with the trade — agents give one with every swap.">
            {(id) => <TextInput id={id} maxLength={280} placeholder="e.g. ETH reclaimed its 20-day high" value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!!blocker || !quote.q || !amount.trim()}>Swap on paper</Button>
          {blocker && <p className={cx("text-xs", muted)}>{blocker}</p>}
        </div>
      </form>
      {result && <div className="mt-3"><Notice tone={result.ok ? "success" : "danger"}>{result.text}</Notice></div>}
    </Card>
  );
}

function TokenField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <TextInput id={id} mono list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Symbol or 0x address" />
      <datalist id={`${id}-list`}>{ALL_SYMBOLS.map((t) => <option key={t} value={t} />)}</datalist>
    </>
  );
}

function PortfolioCard({ portfolio: p, since }: { portfolio: Portfolio | null; since: string | null }) {
  if (!p) return <Card><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px]" />)}</div><Skeleton className="mt-4 h-32" /></Card>;
  return (
    <Card title="Portfolio" description={since ? `Since ${new Date(since).toLocaleDateString()} · started with ${usd(p.startUsd)}` : undefined}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Equity" value={usd(p.equityUsd)} />
        <Stat label="P&L" value={signed(p.pnlUsd)} tone={toneOf(p.pnlUsd)} sub={`${p.returnPct >= 0 ? "+" : ""}${p.returnPct.toFixed(2)}%`} />
        <Stat label="Realized / unrealized" value={<span><span className={pnlClass(p.realizedUsd)}>{signed(p.realizedUsd)}</span> <span className={muted}>/</span> <span className={pnlClass(p.unrealizedUsd)}>{signed(p.unrealizedUsd)}</span></span>} />
        <Stat label="Trades" value={p.tradeCount.toLocaleString()} sub={`${usd(p.volumeUsd)} volume · ${usd(p.feesUsd)} gas`} />
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={cx("border-b border-[hsl(var(--border))] text-left text-[11px] uppercase tracking-wider", muted)}>
              <th className="py-2 pr-3 font-medium">Token</th>
              <th className="py-2 pr-3 text-right font-medium">Amount</th>
              <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Price</th>
              <th className="py-2 pr-3 text-right font-medium">Value</th>
              <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Avg cost</th>
              <th className="py-2 text-right font-medium">Unrealized</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {p.lines.map((l) => (
              <tr key={l.token} className="border-b border-[hsl(var(--border))]/50 last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium">{tokenLabel(l.symbol, l.token)}</div>
                  {l.weightPct != null && (
                    <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-[hsl(var(--muted))]" aria-label={`${l.weightPct.toFixed(0)}% of equity`}>
                      <div className="h-full rounded-full bg-[hsl(var(--primary))]" style={{ width: `${Math.max(l.weightPct, 2)}%` }} />
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{l.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                <td className="hidden py-2 pr-3 text-right font-mono text-xs sm:table-cell">{price(l.priceUsd)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{usd(l.valueUsd)}</td>
                <td className="hidden py-2 pr-3 text-right font-mono text-xs sm:table-cell">{price(l.avgCostUsd)}</td>
                <td className={cx("py-2 text-right font-mono text-xs", pnlClass(l.unrealizedUsd))}>{l.unrealizedUsd == null ? "—" : signed(l.unrealizedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.unpriced.length > 0 && <p className={cx("mt-2 text-xs", muted)}>{p.unpriced.length} holding(s) have no price and are left out of equity.</p>}
    </Card>
  );
}

function PolicyCard({ env, policy, volumeTodayUsd, onSaved }: { env: Env; policy: Policy | null; volumeTodayUsd: number; onSaved: () => void }) {
  const owner = !!env.agent?.isOwner;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!policy) return;
    setDraft({
      maxTradeUsd: policy.maxTradeUsd?.toString() ?? "",
      maxDailyVolumeUsd: policy.maxDailyVolumeUsd?.toString() ?? "",
      maxTransferEth: policy.maxTransferEth?.toString() ?? "",
      allowedTokens: policy.allowedTokens.join(", "),
      transferAllowlist: policy.transferAllowlist.join(", "),
    });
  }, [policy]);

  async function save(label: string, patch: Record<string, unknown>) {
    setBusy(label);
    setErr(null);
    try {
      await json(env.agentApi("policy", { method: "POST", body: JSON.stringify(patch) }));
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const list = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const limitText = (n: number | null, unit = "$") => (n == null ? "No limit" : unit === "$" ? usd(n) : `${n} ${unit}`);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />Limits</span>}
      description={owner ? "You own this org — these bind the agent's trades, transfers and sends." : "Set by the org owner."}
      actions={policy && owner ? (
        <Button className="h-8" variant={policy.paused ? "primary" : "secondary"} icon={policy.paused ? Play : Pause} loading={busy === "pause"}
          onClick={() => save("pause", { paused: !policy.paused })}>{policy.paused ? "Resume" : "Pause"}</Button>
      ) : undefined}>
      {!policy ? <Skeleton className="h-48" /> : !owner ? (
        <dl className="space-y-2 text-sm">
          <Item label="Per trade">{limitText(policy.maxTradeUsd)}</Item>
          <Item label="Per day">{limitText(policy.maxDailyVolumeUsd)} <span className={muted}>· {usd(volumeTodayUsd)} used</span></Item>
          <Item label="Tokens">{policy.allowedTokens.length ? `${policy.allowedTokens.length} allowed` : "Any"}</Item>
          <Item label="Transfers">{policy.transferAllowlist.length ? `${policy.transferAllowlist.length} addresses` : "Any address"} · {limitText(policy.maxTransferEth, "ETH")}</Item>
        </dl>
      ) : (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          const num = (v: string) => (v.trim() ? Number(v) : null);
          save("save", {
            maxTradeUsd: num(draft.maxTradeUsd), maxDailyVolumeUsd: num(draft.maxDailyVolumeUsd), maxTransferEth: num(draft.maxTransferEth),
            allowedTokens: list(draft.allowedTokens), transferAllowlist: list(draft.transferAllowlist),
          });
        }}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Per trade ($)">{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxTradeUsd ?? ""} onChange={set("maxTradeUsd")} />}</Field>
            <Field label="Per day ($)" hint={`${usd(volumeTodayUsd)} used today`}>{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxDailyVolumeUsd ?? ""} onChange={set("maxDailyVolumeUsd")} />}</Field>
          </div>
          <Field label="Allowed tokens" hint="Symbols or addresses, comma-separated. Empty = any. USDC is always allowed.">
            {(id) => <TextInput id={id} mono placeholder="Any" value={draft.allowedTokens ?? ""} onChange={set("allowedTokens")} />}
          </Field>
          <Field label="Max ETH per transaction">{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxTransferEth ?? ""} onChange={set("maxTransferEth")} />}</Field>
          <Field label="Transfer allowlist" hint="Empty = any address.">{(id) => <TextInput id={id} mono placeholder="Any address" value={draft.transferAllowlist ?? ""} onChange={set("transferAllowlist")} />}</Field>
          <Button type="submit" loading={busy === "save"}>Save limits</Button>
          {err && <Notice>{err}</Notice>}
          <ResetButton env={env} onDone={onSaved} />
        </form>
      )}
    </Card>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className={cx("text-xs", muted)}>{label}</dt><dd className="text-right">{children}</dd></div>;
}

function ResetButton({ env, onDone }: { env: Env; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!confirm) {
    return (
      <>
        <Button variant="ghost" className="h-8 w-full text-xs" icon={RotateCcw} onClick={() => { setErr(null); setConfirm(true); }}>Reset paper wallet…</Button>
        {err && <Notice>{err}</Notice>}
      </>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-xs">
      <span className="flex-1">Back to 10,000 USDC? Trade history stays, but stats restart.</span>
      <Button className="h-7 px-2 text-xs" onClick={() => setConfirm(false)}>Cancel</Button>
      <Button className="h-7 px-2 text-xs" variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        await json(env.agentApi("paper/reset", { method: "POST", body: "{}" })).catch((e: Error) => setErr(e.message));
        setBusy(false);
        setConfirm(false);
        onDone();
      }}>Reset</Button>
    </div>
  );
}

function TradesCard({ trades }: { trades: Trade[] | null }) {
  return (
    <Card title="Trades" description="Newest first, with the agent's reason at the time.">
      {trades === null ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        : trades.length === 0 ? <p className={cx("py-6 text-center text-sm", muted)}>No trades yet — the agent&apos;s paper swaps show up here.</p>
        : (
          <ol className="divide-y divide-[hsl(var(--border))]/60">
            {trades.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="text-sm">
                    <span className="font-mono tabular-nums">{t.inUi}</span> {tokenLabel(t.inSymbol, t.inputToken)}
                    <span className={cx("mx-1.5", muted)} aria-hidden>→</span>
                    <span className="font-mono tabular-nums">{Number(t.outUi).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span> {tokenLabel(t.outSymbol, t.outputToken)}
                  </div>
                  {t.note && <p className={cx("mt-0.5 text-xs italic", muted)}>“{t.note}”</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                  <span className="font-mono">{usd(t.usdValue)}</span>
                  <span className={muted} title="Gas paid">⛽ {usd(t.gasUsd, 2)}</span>
                  {Math.abs(t.realizedUsd) >= 0.01 && <Badge tone={t.realizedUsd > 0 ? "success" : "danger"}>{signed(t.realizedUsd)}</Badge>}
                  <time className={cx("w-16 text-right", muted)} dateTime={t.at} title={new Date(t.at).toLocaleString()}>{timeAgo(t.at)}</time>
                </div>
              </li>
            ))}
          </ol>
        )}
    </Card>
  );
}

function LeaderboardCard({ board, current }: { board: Ranked[] | null; current: string }) {
  if (board && board.length < 2) return null;
  return (
    <Card title={<span className="flex items-center gap-2"><Trophy className="h-4 w-4" aria-hidden />Leaderboard</span>} description="Agents in your orgs, by paper return.">
      {!board ? <Skeleton className="h-24" /> : (
        <ol className="space-y-1">
          {board.map((r, i) => (
            <li key={r.agentId} className={cx("flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm", r.agentId === current && "bg-[hsl(var(--primary))]/5")}>
              <span className={cx("w-5 text-right font-mono text-xs tabular-nums", muted)}>{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className={cx("text-xs", muted)}>{r.tradeCount} trades</span>
              <span className="w-24 text-right font-mono text-xs tabular-nums">{usd(r.equityUsd)}</span>
              <span className={cx("w-16 text-right font-mono text-xs tabular-nums", pnlClass(r.returnPct))}>{r.returnPct >= 0 ? "+" : ""}{r.returnPct.toFixed(2)}%</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
