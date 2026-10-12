"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowDownUp, CandlestickChart, Pause, Play, RotateCcw, ShieldCheck, Trophy } from "lucide-react";
import {
  Badge, Button, Card, ErrorNote, Field, Notice, PageHeader, Select, Skeleton, Stat, TextInput, cx, muted, shortAddr, timeAgo,
  type Env,
} from "./ui";
import { PricesCard, QuoteSummary, TOKENS, getJson, usd, type Api, type Quote } from "./market-tab";

// The Trade view: live mainnet prices, a swap form that previews the
// Jupiter quote and fills it in the selected agent's paper wallet, the
// wallet itself, its trades, the owner's limits and the org leaderboard.

interface Line { mint: string; symbol: string | null; amount: number; priceUsd: number | null; valueUsd: number | null; avgCostUsd: number; unrealizedUsd: number | null; weightPct: number | null }
interface Portfolio {
  equityUsd: number; startUsd: number; pnlUsd: number; returnPct: number; realizedUsd: number; unrealizedUsd: number;
  feesUsd: number; tradeCount: number; volumeUsd: number; unpriced: string[]; lines: Line[];
}
interface Policy {
  paused: boolean; maxTradeUsd: number | null; maxDailyVolumeUsd: number | null;
  allowedMints: string[]; transferAllowlist: string[]; maxTransferSol: number | null;
}
interface Trade {
  id: string; at: string; inUi: string; outUi: string; inSymbol: string | null; outSymbol: string | null; inputMint: string; outputMint: string;
  usdValue: number; realizedUsd: number; priceImpactPct: number; route: string[]; note: string | null;
}
interface Ranked { agentId: string; name: string; equityUsd: number; pnlUsd: number; returnPct: number; tradeCount: number }

async function json<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
  return d as T;
}

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;
const toneOf = (n: number | null) => (n == null || Math.abs(n) < 0.005 ? undefined : n > 0 ? "success" as const : "danger" as const);
const pnlClass = (n: number | null) => cx(n != null && n > 0.005 && "text-green-600 dark:text-green-400", n != null && n < -0.005 && "text-red-600 dark:text-red-400");
const tokenLabel = (symbol: string | null, mint: string) => symbol ?? shortAddr(mint, 4);

export function TradeTab({ env, api }: { env: Env; api: Api }) {
  const agent = env.agent;
  const { agentApi } = env;
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
    // The agent trades on its own; keep the book live.
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  if (!agent) {
    return (
      <div className="space-y-4">
        <Header />
        <PricesCard api={api} />
        <SwapCard env={env} api={api} canTrade={false} paused={false} holdings={[]} onDone={load} />
      </div>
    );
  }
  const canTrade = !!agent.capabilities["solana-dev-trade"];

  return (
    <div className="space-y-4">
      <Header />
      {error && <ErrorNote message={error} onRetry={load} />}
      {data?.policy.paused && (
        <Notice tone="warning" title={`${agent.name} is paused`}>Trades, transfers and signing are refused until the org owner resumes it.</Notice>
      )}

      <PricesCard api={api} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SwapCard env={env} api={api} canTrade={canTrade} paused={!!data?.policy.paused} holdings={data?.portfolio.lines ?? []} onDone={load} />
        <PolicyCard env={env} policy={data?.policy ?? null} volumeTodayUsd={data?.volumeTodayUsd ?? 0} onSaved={load} />
      </div>

      <PortfolioCard portfolio={data?.portfolio ?? null} since={data?.since ?? null} />

      <TradesCard trades={trades} />
      <LeaderboardCard board={board} current={agent.agentId} />
    </div>
  );
}

function Header() {
  return (
    <PageHeader icon={CandlestickChart} title="Trade"
      description="Real mainnet prices and routes from Jupiter, filled in a 10,000 USDC paper wallet — no real funds move. Agents trade the same way with solana_paper_swap." />
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
        <Stat label="Trades" value={p.tradeCount.toLocaleString()} sub={`${usd(p.volumeUsd)} volume`} />
      </div>
      <div className="mt-4">
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
              <tr key={l.mint} className="border-b border-[hsl(var(--border))]/50 last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium">{tokenLabel(l.symbol, l.mint)}</div>
                  {l.weightPct != null && (
                    <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-[hsl(var(--muted))]" aria-label={`${l.weightPct.toFixed(0)}% of equity`}>
                      <div className="h-full rounded-full bg-[hsl(var(--primary))]" style={{ width: `${Math.max(l.weightPct, 2)}%` }} />
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{l.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                <td className="hidden py-2 pr-3 text-right font-mono text-xs sm:table-cell">{usd(l.priceUsd)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs">{usd(l.valueUsd)}</td>
                <td className="hidden py-2 pr-3 text-right font-mono text-xs sm:table-cell">{usd(l.avgCostUsd)}</td>
                <td className={cx("py-2 text-right font-mono text-xs", pnlClass(l.unrealizedUsd))}>{l.unrealizedUsd == null ? "—" : signed(l.unrealizedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.unpriced.length > 0 && <p className={cx("mt-2 text-xs", muted)}>{p.unpriced.length} holding(s) have no Jupiter price and are left out of equity.</p>}
    </Card>
  );
}

function SwapCard({ env, api, canTrade, paused, holdings, onDone }: { env: Env; api: Api; canTrade: boolean; paused: boolean; holdings: Line[]; onDone: () => void }) {
  const agent = env.agent;
  const [from, setFrom] = useState("USDC");
  const [to, setTo] = useState("SOL");
  const [amount, setAmount] = useState("100");
  const [slippage, setSlippage] = useState("50");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [quote, setQuote] = useState<{ q: Quote | null; error: string | null; loading: boolean }>({ q: null, error: null, loading: false });

  const held = holdings.find((h) => h.symbol?.toUpperCase() === from.trim().toUpperCase() || h.mint === from.trim());

  // "25%" / "all" are resolved against the paper holding on the server; preview with the same share.
  const previewAmount = (() => {
    const a = amount.trim().toLowerCase();
    if (a !== "all" && !a.endsWith("%")) return a;
    if (!held) return "";
    const share = a === "all" ? 1 : Number(a.slice(0, -1)) / 100;
    return share > 0 && share <= 1 ? String(Number((held.amount * share).toFixed(9))) : "";
  })();

  // Live quote for what's in the form, debounced so typing doesn't spam Jupiter.
  const [quoteNonce, setQuoteNonce] = useState(0);
  useEffect(() => {
    const [f, t] = [from.trim(), to.trim()];
    if (!f || !t || !(Number(previewAmount) > 0)) { setQuote({ q: null, error: null, loading: false }); return; }
    let live = true;
    setQuote((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({ inputMint: f, outputMint: t, amount: previewAmount, slippageBps: slippage });
      getJson<{ quote: Quote }>(api, `market/quote?${qs}`)
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
      const d = await json<{ trade: Trade }>(env.agentApi("paper/swap", {
        method: "POST",
        body: JSON.stringify({ inputMint: from.trim(), outputMint: to.trim(), amount: amount.trim(), slippageBps: Number(slippage), note: note.trim() || undefined }),
      }));
      const t = d.trade;
      setResult({ ok: true, text: `Swapped ${t.inUi} ${tokenLabel(t.inSymbol, t.inputMint)} for ${t.outUi} ${tokenLabel(t.outSymbol, t.outputMint)} (${usd(t.usdValue)}) via ${t.route.join(" › ") || "direct"}` });
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
      description={agent ? `Previews the live quote, then fills it in ${agent.name}'s paper wallet under its owner's limits.` : "Live quote for any pair. Symbols or mint addresses."}>
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
          <Field label="Sell">{(id) => <TokenField id={id} value={from} onChange={setFrom} />}</Field>
          <Button className="justify-self-center" variant="ghost" icon={ArrowDownUp} aria-label="Swap direction" title="Swap direction" onClick={() => { setFrom(to); setTo(from); }} />
          <Field label="Buy">{(id) => <TokenField id={id} value={to} onChange={setTo} />}</Field>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Amount" hint={agent ? (held ? `Holding ${held.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenLabel(held.symbol, held.mint)}` : "Not held in the paper wallet") : undefined}>
            {(id) => (
              <div className="flex flex-wrap gap-2">
                <TextInput id={id} mono inputMode="decimal" className="w-36" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {agent && ["25%", "50%", "all"].map((v) => (
                  <Button key={v} className="h-9 px-2.5 text-xs" disabled={!held} onClick={() => setAmount(v)}>{v === "all" ? "Max" : v}</Button>
                ))}
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
            {(id) => <TextInput id={id} maxLength={280} placeholder="e.g. SOL reclaimed its 20-day high" value={note} onChange={(e) => setNote(e.target.value)} />}
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
      <TextInput id={id} mono list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Symbol or mint" />
      <datalist id={`${id}-list`}>{TOKENS.map((t) => <option key={t} value={t} />)}</datalist>
    </>
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
      maxTransferSol: policy.maxTransferSol?.toString() ?? "",
      allowedMints: policy.allowedMints.join(", "),
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

  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />Limits</span>}
      description={owner ? "You own this org — these bind the agent's trades and transfers." : "Set by the org owner."}
      actions={policy && owner ? (
        <Button className="h-8" variant={policy.paused ? "primary" : "secondary"} icon={policy.paused ? Play : Pause} loading={busy === "pause"}
          onClick={() => save("pause", { paused: !policy.paused })}>{policy.paused ? "Resume" : "Pause"}</Button>
      ) : undefined}>
      {!policy ? <Skeleton className="h-48" /> : !owner ? (
        <dl className="space-y-2 text-sm">
          <Item label="Per trade">{limitText(policy.maxTradeUsd)}</Item>
          <Item label="Per day">{limitText(policy.maxDailyVolumeUsd)} <span className={muted}>· {usd(volumeTodayUsd)} used</span></Item>
          <Item label="Tokens">{policy.allowedMints.length ? `${policy.allowedMints.length} allowed` : "Any"}</Item>
          <Item label="Transfers">{policy.transferAllowlist.length ? `${policy.transferAllowlist.length} addresses` : "Any address"} · {limitText(policy.maxTransferSol, "SOL")}</Item>
        </dl>
      ) : (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          const num = (v: string) => (v.trim() ? Number(v) : null);
          save("save", {
            maxTradeUsd: num(draft.maxTradeUsd), maxDailyVolumeUsd: num(draft.maxDailyVolumeUsd), maxTransferSol: num(draft.maxTransferSol),
            allowedMints: list(draft.allowedMints), transferAllowlist: list(draft.transferAllowlist),
          });
        }}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Per trade ($)">{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxTradeUsd ?? ""} onChange={(e) => setDraft((d) => ({ ...d, maxTradeUsd: e.target.value }))} />}</Field>
            <Field label="Per day ($)" hint={`${usd(volumeTodayUsd)} used today`}>{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxDailyVolumeUsd ?? ""} onChange={(e) => setDraft((d) => ({ ...d, maxDailyVolumeUsd: e.target.value }))} />}</Field>
          </div>
          <Field label="Allowed tokens" hint="Symbols or mints, comma-separated. Empty = any. USDC is always allowed.">
            {(id) => <TextInput id={id} mono placeholder="Any" value={draft.allowedMints ?? ""} onChange={(e) => setDraft((d) => ({ ...d, allowedMints: e.target.value }))} />}
          </Field>
          <Field label="Max SOL per transfer">{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="No limit" value={draft.maxTransferSol ?? ""} onChange={(e) => setDraft((d) => ({ ...d, maxTransferSol: e.target.value }))} />}</Field>
          <Field label="Transfer allowlist" hint="Empty = any address.">
            {(id) => <TextInput id={id} mono placeholder="Any address" value={draft.transferAllowlist ?? ""} onChange={(e) => setDraft((d) => ({ ...d, transferAllowlist: e.target.value }))} />}
          </Field>
          <Button type="submit" loading={busy === "save"}>Save limits</Button>
          {err && <Notice>{err}</Notice>}
          <ResetButton env={env} onDone={onSaved} />
        </form>
      )}
    </Card>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
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
        : trades.length === 0 ? <p className={cx("py-6 text-center text-sm", muted)}>No trades yet — the agent's paper swaps show up here.</p>
        : (
          <ol className="divide-y divide-[hsl(var(--border))]/60">
            {trades.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="text-sm">
                    <span className="font-mono tabular-nums">{t.inUi}</span> {tokenLabel(t.inSymbol, t.inputMint)}
                    <span className={cx("mx-1.5", muted)} aria-hidden>→</span>
                    <span className="font-mono tabular-nums">{t.outUi}</span> {tokenLabel(t.outSymbol, t.outputMint)}
                  </div>
                  {t.note && <p className={cx("mt-0.5 text-xs italic", muted)}>“{t.note}”</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                  <span className="font-mono">{usd(t.usdValue)}</span>
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

