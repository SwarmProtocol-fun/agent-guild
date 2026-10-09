"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";

// ── Types (mirrors of the server's JSON) ─────────────────────────────────────

interface Outcome { name: string; tokenId: string; price: number }
interface Market {
  conditionId: string;
  slug: string;
  question: string;
  eventTitle: string | null;
  groupItemTitle: string | null;
  description: string;
  endDate: string | null;
  image: string | null;
  outcomes: Outcome[];
  volume24hr: number;
  liquidity: number;
  acceptingOrders: boolean;
  closed: boolean;
  fee: { rate: number; exponent: number } | null;
}
interface PmEvent { id: string; slug: string; title: string; image: string | null; volume24hr: number; markets: Market[] }
interface BookLevel { price: number; size: number }
interface Book { bids: BookLevel[]; asks: BookLevel[]; tickSize: number; minOrderSize: number }
interface PricePoint { t: number; p: number }

interface MyAgent { agentId: string; name: string; orgId: string; orgName: string; mode: "paper" | "live"; liveAddress: string | null; isOwner: boolean }
interface Risk { maxOrderUsd: number; maxExposureUsd: number; maxDailyLossUsd: number }
interface Position {
  tokenId: string; conditionId: string; question: string; outcome: string; outcomeIndex: number; shares: number; avgPrice: number;
  mark: number | null; value: number | null; unrealizedPnl: number | null; endDate: string | null; redeemable: boolean;
}
interface AccountView {
  account: { mode: "paper" | "live"; paperCash: number; paperStartCash: number; live: { address: string } | null; risk: Risk };
  cash: number | null;
  equity: number | null;
  pnl: number | null;
  dailyRealizedPnl: number;
  positions: Position[];
  wallet: { address: string; pusd: number; pol: number; approvals: { label: string; ok: boolean }[]; ready: boolean } | null;
  geo?: { blocked: boolean; country: string | null; region: string | null };
}
interface Trade {
  id: string; mode: string; question: string; outcome: string; side: "buy" | "sell" | "resolve"; shares: number; price: number;
  notional: number; fee: number; realizedPnl: number; status: string; createdAt: string | null; strategyId: string | null;
}
interface Bot {
  id: string; type: "ai" | "mid-price" | "streak-fade" | "price-trigger"; enabled: boolean; sizeUsd: number;
  market: { conditionId: string; question: string; outcomes: { name: string }[] } | null; params: Record<string, unknown>;
  lastReason: string | null; lastEvalAt: number | null; waitingOnAgent: boolean; lastRunAt: string | null;
}
interface BotLog { id: string; kind: string; reason: string; createdAt: string | null }
interface OpenOrder { id: string; tokenId: string; side: string; price: number; size: number; filled: number }

// ── Formatting & primitives (same visual language as the Hyperliquid terminal) ──

const mutedClass = "text-[hsl(var(--muted-foreground))]";
const monoClass = "font-mono tabular-nums";
const panelClass = "rounded-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))]";
const labelClass = `block text-[11px] font-medium uppercase tracking-wide ${mutedClass} mb-1`;
const inputClass =
  "w-full rounded-sm border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";

/** Price in cents; keeps the decimal for sub-cent ticks (0.355 → 35.5¢) so distinct book levels never print alike. */
const cents = (p: number | null | undefined) => {
  if (p == null) return "—";
  const c = p * 100;
  return `${Math.abs(c - Math.round(c)) < 1e-6 ? Math.round(c) : c.toFixed(1)}¢`;
};
const usd = (n: number | null | undefined, dp = 2) => (n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const compact = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const pnlClass = (n: number) => (n > 0 ? "text-green-600 dark:text-green-400" : n < 0 ? "text-red-600 dark:text-red-400" : "");
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function timeLeft(endDate: string | null): string {
  if (!endDate) return "";
  const ms = Date.parse(endDate) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "ended";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.floor((ms % 60_000) / 1000)}s left`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h left` : `${Math.floor(h / 24)}d left`;
}

function buttonClass(kind: "primary" | "secondary" | "danger" = "secondary", extra = "") {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))] ";
  const tone = {
    primary: "bg-[hsl(var(--primary))] text-white hover:bg-[hsl(var(--primary))]/90",
    secondary: "border border-[hsl(var(--input))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]",
    danger: "border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10",
  }[kind];
  return `${base}${tone} ${extra}`;
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 overflow-hidden rounded-sm border border-[hsl(var(--border))]">
      {options.map((o) => (
        <button
          key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
          className={
            "px-3 py-1 text-xs font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))] " +
            (value === o.id ? "bg-[hsl(var(--primary))] text-white" : `${mutedClass} hover:text-[hsl(var(--foreground))]`)
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Badge({ tone, children }: { tone: "neutral" | "success" | "danger" | "warning"; children: ReactNode }) {
  const toneClass = {
    neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
    success: "bg-green-600/10 text-green-700 dark:text-green-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  }[tone];
  return <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneClass}`}>{children}</span>;
}

function Section({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`${panelClass} flex min-w-0 flex-col ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
        {right}
      </div>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </div>
  );
}

function Note({ tone = "neutral", children }: { tone?: "neutral" | "danger" | "warning" | "success"; children: ReactNode }) {
  const cls = {
    neutral: `bg-[hsl(var(--muted))] ${mutedClass}`,
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    warning: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
    success: "bg-green-600/10 text-green-700 dark:text-green-400",
  }[tone];
  return <div className={`rounded-sm px-3 py-2 text-xs ${cls}`} role={tone === "danger" ? "alert" : undefined}>{children}</div>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] uppercase tracking-wide ${mutedClass}`}>{label}</div>
      <div className={`${monoClass} whitespace-nowrap text-xs`}>{children}</div>
    </div>
  );
}

// ── Price chart (probability of the first outcome over time) ─────────────────

function ProbabilityChart({ points }: { points: PricePoint[] }) {
  const W = 600;
  const H = 180;
  if (points.length < 2) return <div className={`flex h-[180px] items-center justify-center text-xs ${mutedClass}`}>No price history yet</div>;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 40);
  const y = (p: number) => 8 + (1 - p) * (H - 24);
  const path = points.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[180px] w-full" role="img" aria-label={`Price history, now ${cents(last.p)}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={0} x2={W - 40} y1={y(p)} y2={y(p)} className="stroke-[hsl(var(--border))]" strokeWidth={1} />
          <text x={W - 34} y={y(p) + 4} fontSize={11} fontFamily="ui-monospace, monospace" className="fill-[hsl(var(--muted-foreground))]">{p * 100}%</text>
        </g>
      ))}
      <path d={path} fill="none" className="stroke-[hsl(var(--primary))]" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={x(last.t)} cy={y(last.p)} r={3} className="fill-[hsl(var(--primary))]" />
      <text x={4} y={H - 4} fontSize={10} className="fill-[hsl(var(--muted-foreground))]">{new Date(t0).toLocaleString()}</text>
    </svg>
  );
}

function OrderBook({ book, onPick }: { book: Book | null; onPick: (p: number) => void }) {
  if (!book) return <div className={`py-6 text-center text-xs ${mutedClass}`}>Loading book…</div>;
  const asks = book.asks.slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  const max = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const spread = book.asks[0] && book.bids[0] ? book.asks[0].price - book.bids[0].price : null;
  const Row = ({ l, side }: { l: BookLevel; side: "bid" | "ask" }) => (
    <button
      type="button" onClick={() => onPick(l.price)} title="Use this price"
      className="relative grid w-full grid-cols-3 px-2 py-[3px] text-[11px] hover:bg-[hsl(var(--accent))]/60 focus-visible:bg-[hsl(var(--accent))] focus-visible:outline-none"
    >
      <span
        className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-green-500/10" : "bg-red-500/10"}`}
        style={{ width: `${(l.size / max) * 100}%` }} aria-hidden="true"
      />
      <span className={`relative text-left ${monoClass} ${side === "bid" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{cents(l.price)}</span>
      <span className={`relative text-right ${monoClass}`}>{l.size.toFixed(0)}</span>
      <span className={`relative text-right ${monoClass} ${mutedClass}`}>{usd(l.size * l.price, 0)}</span>
    </button>
  );
  return (
    <div>
      <div className={`grid grid-cols-3 px-2 pb-1 text-[10px] uppercase tracking-wide ${mutedClass}`}>
        <span>Price</span><span className="text-right">Shares</span><span className="text-right">Total</span>
      </div>
      {asks.length ? asks.map((l) => <Row key={`a${l.price}`} l={l} side="ask" />) : <div className={`px-2 text-[11px] ${mutedClass}`}>No asks</div>}
      <div className={`border-y border-[hsl(var(--border))] px-2 py-1 text-[11px] ${mutedClass}`}>Spread {spread != null ? cents(spread) : "—"}</div>
      {bids.length ? bids.map((l) => <Row key={`b${l.price}`} l={l} side="bid" />) : <div className={`px-2 text-[11px] ${mutedClass}`}>No bids</div>}
    </div>
  );
}

// ── Order estimate (client-side preview of what the server will do) ─────────

function estimateBuy(asks: BookLevel[], amount: number, limit: number | null) {
  let left = amount;
  let shares = 0;
  let cost = 0;
  for (const l of asks) {
    if (left <= 0 || (limit != null && l.price > limit)) break;
    const take = Math.min(l.size, left / l.price);
    shares += take;
    cost += take * l.price;
    left -= take * l.price;
  }
  return { shares, cost, avg: shares ? cost / shares : 0 };
}

function estimateSell(bids: BookLevel[], qty: number, limit: number | null) {
  let left = qty;
  let shares = 0;
  let proceeds = 0;
  for (const l of bids) {
    if (left <= 0 || (limit != null && l.price < limit)) break;
    const take = Math.min(l.size, left);
    shares += take;
    proceeds += take * l.price;
    left -= take;
  }
  return { shares, proceeds, avg: shares ? proceeds / shares : 0 };
}

const BOT_LABELS: Record<Bot["type"], string> = {
  ai: "AI Predictor",
  "mid-price": "BTC 5m · Mid-price continuation",
  "streak-fade": "BTC 5m · Streak fader",
  "price-trigger": "Price trigger",
};

const BOT_HELP: Record<Bot["type"], string> = {
  ai: "Each round your agent's own model reads the market and answers BUY_YES, BUY_NO, SELL or HOLD. It runs on the agent's daemon (agent-guild daemon); no platform inference.",
  "mid-price": "Once BTC is ≥0.05% through the window's strike, buys the leading side only while its ask is 40–55¢, in the first 3 minutes. Never chases above 55¢. Holds to resolution.",
  "streak-fade": "After 4+ same-direction 5-minute windows that moved more than 3× the hourly ATR, buys the reversal side at ≤52¢ in the window's first minute. Thin edge by design.",
  "price-trigger": "Buys the chosen outcome when its ask crosses your price, then optionally sells at a take-profit or stop-loss.",
};

type Tab = "positions" | "trades" | "bots" | "orders" | "settings";
type Browse = "trending" | "btc" | "search";

// ── Panel ───────────────────────────────────────────────────────────────────

function PolymarketPanel({ api }: PanelProps) {
  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const resp = await api(path, init);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
    return data as T;
  }, [api]);
  const postJson = useCallback(<T,>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [call]);

  // Agents
  const [agents, setAgents] = useState<MyAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const agent = agents?.find((a) => a.agentId === agentId) ?? null;

  const loadAgents = useCallback(() => {
    setAgentsError(null);
    call<{ agents: MyAgent[] }>("my-agents")
      .then(({ agents }) => {
        setAgents(agents);
        setAgentId((cur) => cur || (() => { try { return localStorage.getItem("pm.agent") ?? ""; } catch { return ""; } })() || agents[0]?.agentId || "");
      })
      .catch((e: Error) => setAgentsError(e.message));
  }, [call]);
  useEffect(loadAgents, [loadAgents]);
  useEffect(() => { try { if (agentId) localStorage.setItem("pm.agent", agentId); } catch { /* storage unavailable */ } }, [agentId]);

  // Account
  const [account, setAccount] = useState<AccountView | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const loadAccount = useCallback(() => {
    if (!agentId) return;
    call<AccountView>(`account/${agentId}`).then((a) => { setAccount(a); setAccountError(null); }).catch((e: Error) => setAccountError(e.message));
  }, [agentId, call]);
  useEffect(() => {
    setAccount(null);
    loadAccount();
    const t = setInterval(loadAccount, 15_000);
    return () => clearInterval(t);
  }, [loadAccount]);

  // Market browser
  const [browse, setBrowse] = useState<Browse>("trending");
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<PmEvent[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [market, setMarket] = useState<Market | null>(null);

  const loadEvents = useCallback((q?: string) => {
    setEvents(null);
    setBrowseError(null);
    call<{ events: PmEvent[] }>(q ? `markets?q=${encodeURIComponent(q)}` : "markets")
      .then(({ events }) => {
        setEvents(events);
        setMarket((cur) => cur ?? events[0]?.markets[0] ?? null);
      })
      .catch((e: Error) => setBrowseError(e.message));
  }, [call]);

  const loadBtc = useCallback(() => {
    call<{ market: Market | null }>("markets/btc-5m")
      .then(({ market }) => { if (market) setMarket(market); else setBrowseError("Polymarket hasn't listed this BTC window yet"); })
      .catch((e: Error) => setBrowseError(e.message));
  }, [call]);

  useEffect(() => {
    if (browse === "trending") loadEvents();
    if (browse === "btc") {
      loadBtc();
      // Roll to the next window at each 5-minute boundary.
      const ms = 300_000 - (Date.now() % 300_000) + 1500;
      const t = setTimeout(function roll() { loadBtc(); }, ms);
      return () => clearTimeout(t);
    }
  }, [browse, loadEvents, loadBtc]);

  // Selected outcome, book, history
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  // Both outcomes' live books: Gamma's listed prices lag, and on a 5-minute market that's the whole game.
  const [books, setBooks] = useState<Record<string, Book>>({});
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [, setClock] = useState(0);
  const token = market?.outcomes[outcomeIndex]?.tokenId;
  const book = token ? books[token] ?? null : null;
  const tokens = market?.outcomes.map((o) => o.tokenId).join(",") ?? "";

  useEffect(() => { setOutcomeIndex(0); }, [market?.conditionId]);
  useEffect(() => {
    if (!tokens) return;
    let live = true;
    const load = () => Promise.all(tokens.split(",").map((t) =>
      call<{ book: Book }>(`book/${t}`).then(({ book }) => [t, book] as const).catch(() => null),
    )).then((rows) => {
      if (live) setBooks(Object.fromEntries(rows.filter((r): r is readonly [string, Book] => r !== null)));
    });
    setBooks({});
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [tokens, call]);
  useEffect(() => {
    const first = market?.outcomes[0]?.tokenId;
    if (!first) return;
    const short = market!.slug.startsWith("btc-updown-5m");
    call<{ history: PricePoint[] }>(`history/${first}?interval=${short ? "1h" : "1w"}&fidelity=${short ? 1 : 60}`)
      .then(({ history }) => setHistory(history)).catch(() => setHistory([]));
  }, [market, call]);
  useEffect(() => { const t = setInterval(() => setClock((c) => c + 1), 1000); return () => clearInterval(t); }, []);

  // Ticket
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("10");
  const [limit, setLimit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [orderMsg, setOrderMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const held = account?.positions.find((p) => p.tokenId === token) ?? null;
  const amountNum = Number(amount) || 0;
  const limitNum = limit ? Number(limit) / 100 : null;
  const estimate = useMemo(() => {
    if (!book) return null;
    if (side === "buy") {
      const e = estimateBuy(book.asks, amountNum, kind === "limit" ? limitNum : null);
      return { shares: e.shares, avg: e.avg, usd: e.cost, payout: e.shares };
    }
    const e = estimateSell(book.bids, amountNum, kind === "limit" ? limitNum : null);
    return { shares: e.shares, avg: e.avg, usd: e.proceeds, payout: null };
  }, [book, side, amountNum, kind, limitNum]);

  const mode = account?.account.mode ?? agent?.mode ?? "paper";
  const liveBlocked = mode === "live" && account?.geo?.blocked;

  async function submitOrder(e: FormEvent) {
    e.preventDefault();
    if (!market || !agentId) return;
    if (mode === "live" && !window.confirm(`Place a LIVE ${side} on Polymarket with real funds?\n\n${market.question}\n${market.outcomes[outcomeIndex].name}: ${side === "buy" ? usd(amountNum) : `${amountNum} shares`}`)) return;
    setSubmitting(true);
    setOrderMsg(null);
    try {
      const r = await postJson<{ shares: number; avgPrice: number; outcome: string; status: string; mode: string; realizedPnl: number }>("order", {
        agentId, conditionId: market.conditionId, outcomeIndex, side, kind,
        ...(side === "buy" ? { usd: amountNum } : { shares: amountNum }),
        ...(limitNum != null ? { limitPrice: limitNum } : {}),
      });
      setOrderMsg({
        tone: "success",
        text: r.shares > 0
          ? `${r.mode === "paper" ? "Paper " : ""}${side === "buy" ? "Bought" : "Sold"} ${r.shares.toFixed(2)} ${r.outcome} @ ${cents(r.avgPrice)}${side === "sell" ? ` · PnL ${signed(r.realizedPnl)}` : ""}`
          : `Order ${r.status} (resting on the book)`,
      });
      loadAccount();
      setTradesKey((k) => k + 1);
    } catch (err) {
      setOrderMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  // Bottom tabs
  const [tab, setTab] = useState<Tab>("positions");
  const [tradesKey, setTradesKey] = useState(0);

  if (agentsError) return <div className="p-4"><Note tone="danger">{agentsError} <button className="underline" onClick={loadAgents}>Retry</button></Note></div>;
  if (!agents) return <div className={`p-4 text-sm ${mutedClass}`}>Loading your agents…</div>;
  if (!agents.length) return <div className="p-4"><Note>Create an agent first. Polymarket trading runs per agent, from the agent&apos;s own account.</Note></div>;

  return (
    <div className="mx-auto max-w-[1440px] space-y-2 p-2 text-sm sm:p-3">
      {/* Header */}
      <div className={`${panelClass} flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2`}>
        <span className="text-xs font-semibold uppercase tracking-wide">Polymarket</span>
        <label className="flex min-w-0 items-center gap-2">
          <span className="sr-only">Agent</span>
          <select className={`${inputClass} max-w-[240px] py-1`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name} · {a.orgName}</option>)}
          </select>
        </label>
        <Badge tone={mode === "live" ? "warning" : "neutral"}>{mode === "live" ? "Live" : "Paper"}</Badge>
        {liveBlocked && <Badge tone="danger">Geoblocked</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1">
          <Stat label={mode === "live" ? "pUSD" : "Paper cash"}>{usd(account?.cash)}</Stat>
          <Stat label="Equity">{usd(account?.equity)}</Stat>
          {account?.pnl != null && <Stat label="Total PnL"><span className={pnlClass(account.pnl)}>{signed(account.pnl)}</span></Stat>}
          <Stat label="Today">{account ? <span className={pnlClass(account.dailyRealizedPnl)}>{signed(account.dailyRealizedPnl)}</span> : "—"}</Stat>
        </div>
      </div>
      {accountError && <Note tone="danger">{accountError}</Note>}
      {liveBlocked && (
        <Note tone="danger">
          Polymarket blocks order placement from this server&apos;s location ({[account?.geo?.region, account?.geo?.country].filter(Boolean).join(", ")}). Live orders will be refused. Switch to paper in Settings.
        </Note>
      )}

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-12">
        {/* Market browser */}
        <Section
          title="Markets" className="lg:col-span-4 lg:max-h-[640px]"
          right={<Segmented label="Browse" value={browse} onChange={setBrowse} options={[{ id: "trending", label: "Hot" }, { id: "btc", label: "BTC 5m" }, { id: "search", label: "Search" }]} />}
        >
          {browse === "search" && (
            <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (query.trim()) loadEvents(query.trim()); }}>
              <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Election, Fed, Bitcoin…" aria-label="Search markets" />
              <button className={buttonClass("secondary")} type="submit">Go</button>
            </form>
          )}
          {browseError && <Note tone="danger">{browseError}</Note>}
          {browse === "btc" ? (
            <div className="space-y-2 text-xs">
              <p className={mutedClass}>The live BTC 5-minute Up/Down window. It rolls to the next one automatically. It resolves on Chainlink&apos;s BTC/USD TWAP over the window&apos;s last minute vs. the price at its start.</p>
              {market?.slug.startsWith("btc-updown-5m") && (
                <div className={`${panelClass} p-2`}>
                  <div className="font-medium">{market.question}</div>
                  <div className={`${mutedClass} mt-1`}>{timeLeft(market.endDate)}</div>
                </div>
              )}
            </div>
          ) : !events && !browseError ? (
            <div className={`text-xs ${mutedClass}`}>Loading markets…</div>
          ) : (
            <ul className="-mx-3 max-h-[560px] overflow-y-auto">
              {events?.map((ev) => (
                <li key={ev.id} className="border-b border-[hsl(var(--border))] px-3 py-2 last:border-0">
                  <div className="flex items-start gap-2">
                    {ev.image && <img src={ev.image} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded-sm object-cover" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium leading-snug">{ev.title}</div>
                      <div className={`text-[11px] ${mutedClass}`}>{compact(ev.volume24hr)} 24h vol</div>
                    </div>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {ev.markets.slice(0, 6).map((m) => (
                      <button
                        key={m.conditionId} type="button" onClick={() => setMarket(m)}
                        className={`flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-1 text-left text-[11px] hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] ${market?.conditionId === m.conditionId ? "bg-[hsl(var(--accent))]" : ""}`}
                      >
                        <span className="min-w-0 truncate">{m.groupItemTitle || m.question}</span>
                        <span className={`${monoClass} shrink-0`}>{m.outcomes[0]?.name} {cents(m.outcomes[0]?.price)}</span>
                      </button>
                    ))}
                    {ev.markets.length > 6 && <div className={`px-1.5 text-[11px] ${mutedClass}`}>+{ev.markets.length - 6} more; search to narrow</div>}
                  </div>
                </li>
              ))}
              {events?.length === 0 && <li className={`px-3 text-xs ${mutedClass}`}>No markets found</li>}
            </ul>
          )}
        </Section>

        {/* Market detail */}
        <Section title="Market" className="lg:col-span-5">
          {!market ? (
            <div className={`text-xs ${mutedClass}`}>Pick a market</div>
          ) : (
            <div className="space-y-3">
              <div>
                {market.eventTitle && market.eventTitle !== market.question && <div className={`text-[11px] ${mutedClass}`}>{market.eventTitle}</div>}
                <h3 className="text-base font-semibold leading-snug">{market.question}</h3>
                <div className={`mt-0.5 flex flex-wrap gap-x-3 text-[11px] ${mutedClass}`}>
                  <span>{timeLeft(market.endDate)}</span>
                  <span>{compact(market.volume24hr)} 24h</span>
                  <span>{market.fee ? `Taker fee up to ${(market.fee.rate * 25).toFixed(2)}%` : "No fees"}</span>
                  {!market.acceptingOrders && <span className="text-red-600 dark:text-red-400">Not accepting orders</span>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Outcome">
                {market.outcomes.map((o, i) => {
                  const b = books[o.tokenId];
                  const ask = b?.asks[0]?.price ?? null;
                  const bid = b?.bids[0]?.price ?? null;
                  return (
                    <button
                      key={o.tokenId} type="button" role="radio" aria-checked={outcomeIndex === i} onClick={() => setOutcomeIndex(i)}
                      className={`rounded-sm border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] ${
                        outcomeIndex === i ? (i === 0 ? "border-green-600 bg-green-600/10" : "border-red-500 bg-red-500/10") : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
                      }`}
                    >
                      <div className="text-xs font-medium">{o.name}</div>
                      <div className={`${monoClass} text-lg font-semibold`}>{b ? cents(ask) : cents(o.price)}</div>
                      <div className={`${monoClass} text-[11px] ${mutedClass}`}>{b ? `ask · bid ${cents(bid)}` : "last listed"}</div>
                    </button>
                  );
                })}
              </div>
              <ProbabilityChart points={history} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide">Book · {market.outcomes[outcomeIndex]?.name}</div>
                  <OrderBook book={book} onPick={(p) => { setKind("limit"); setLimit((p * 100).toFixed(1).replace(/\.0$/, "")); }} />
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide">Resolution rules</summary>
                  <p className={`mt-1 whitespace-pre-line ${mutedClass}`}>{market.description || "None published."}</p>
                </details>
              </div>
            </div>
          )}
        </Section>

        {/* Ticket */}
        <Section title="Order" className="lg:col-span-3">
          {!market ? <div className={`text-xs ${mutedClass}`}>Pick a market</div> : (
            <form className="space-y-3" onSubmit={submitOrder}>
              <div className="grid grid-cols-2 gap-1 rounded-sm bg-[hsl(var(--muted))] p-0.5" role="radiogroup" aria-label="Side">
                {(["buy", "sell"] as const).map((s) => (
                  <button
                    key={s} type="button" role="radio" aria-checked={side === s}
                    onClick={() => { setSide(s); setAmount(s === "sell" && held ? String(held.shares) : "10"); }}
                    className={`rounded-sm py-1.5 text-xs font-semibold uppercase tracking-wide ${side === s ? (s === "buy" ? "bg-green-600 text-white" : "bg-red-600 text-white") : mutedClass}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <Segmented label="Order type" value={kind} onChange={setKind} options={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]} />
              <div>
                <label className={labelClass} htmlFor="pm-amount">{side === "buy" ? "Amount (USD)" : "Shares"}</label>
                <input id="pm-amount" className={`${inputClass} ${monoClass}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {side === "sell" && <div className={`mt-1 text-[11px] ${mutedClass}`}>You hold {held ? held.shares.toFixed(2) : "0"} {market.outcomes[outcomeIndex]?.name}</div>}
              </div>
              <div>
                <label className={labelClass} htmlFor="pm-limit">{kind === "limit" ? "Limit price (¢)" : "Worst price (¢, optional)"}</label>
                <input id="pm-limit" className={`${inputClass} ${monoClass}`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={kind === "limit" ? "e.g. 42" : "no cap"} />
                {kind === "limit" && mode === "paper" && <div className={`mt-1 text-[11px] ${mutedClass}`}>Paper limit orders fill what the book offers at your price, then cancel the rest. They don&apos;t rest.</div>}
              </div>
              {estimate && (
                <dl className={`space-y-1 text-xs ${monoClass}`}>
                  <div className="flex justify-between"><dt className={mutedClass}>Est. shares</dt><dd>{estimate.shares.toFixed(2)}</dd></div>
                  <div className="flex justify-between"><dt className={mutedClass}>Avg price</dt><dd>{cents(estimate.avg || null)}</dd></div>
                  <div className="flex justify-between"><dt className={mutedClass}>{side === "buy" ? "Cost" : "Proceeds"}</dt><dd>{usd(estimate.usd)}</dd></div>
                  {estimate.payout != null && <div className="flex justify-between"><dt className={mutedClass}>Pays if {market.outcomes[outcomeIndex]?.name}</dt><dd className="text-green-600 dark:text-green-400">{usd(estimate.payout)}</dd></div>}
                </dl>
              )}
              <button
                type="submit" disabled={submitting || !amountNum || !market.acceptingOrders || !!liveBlocked}
                className={buttonClass("primary", `w-full ${side === "buy" ? "!bg-green-600 hover:!bg-green-700" : "!bg-red-600 hover:!bg-red-700"}`)}
              >
                {submitting ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${market.outcomes[outcomeIndex]?.name}${mode === "paper" ? " (paper)" : ""}`}
              </button>
              {orderMsg && <Note tone={orderMsg.tone}>{orderMsg.text}</Note>}
              {account && <p className={`text-[11px] ${mutedClass}`}>Limits: {usd(account.account.risk.maxOrderUsd, 0)}/order · {usd(account.account.risk.maxExposureUsd, 0)} open · {usd(account.account.risk.maxDailyLossUsd, 0)} daily loss</p>}
            </form>
          )}
        </Section>
      </div>

      {/* Bottom tabs */}
      <div className={panelClass}>
        <div className="flex flex-wrap gap-1 border-b border-[hsl(var(--border))] px-2 pt-2" role="tablist">
          {([
            ["positions", `Positions${account ? ` (${account.positions.length})` : ""}`],
            ["trades", "Trades"],
            ["bots", "Bots"],
            ...(mode === "live" ? [["orders", "Open orders"]] : []),
            ["settings", "Settings"],
          ] as [Tab, string][]).map(([id, label]) => (
            <button
              key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wide ${tab === id ? "border-[hsl(var(--primary))]" : `border-transparent ${mutedClass} hover:text-[hsl(var(--foreground))]`}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="p-3">
          {tab === "positions" && <PositionsTab account={account} onSelect={(conditionId) => call<{ market: Market }>(`market/${conditionId}`).then(({ market }) => setMarket(market)).catch(() => {})} />}
          {tab === "trades" && agentId && <TradesTab key={`${agentId}-${tradesKey}`} agentId={agentId} call={call} />}
          {tab === "bots" && agentId && <BotsTab key={agentId} agentId={agentId} market={market} outcomeIndex={outcomeIndex} call={call} postJson={postJson} maxOrderUsd={account?.account.risk.maxOrderUsd ?? 25} />}
          {tab === "orders" && agentId && <OrdersTab key={agentId} agentId={agentId} call={call} />}
          {tab === "settings" && agent && <SettingsTab agent={agent} account={account} postJson={postJson} onChange={() => { loadAccount(); loadAgents(); }} />}
        </div>
      </div>

      <p className={`text-[11px] ${mutedClass}`}>
        Prediction markets are risky; bots here are experiments, not money printers. The BTC 5-minute bots are based on rules Moon Dev published with their own results; they have thin edges and lose after slippage as often as not. Start on paper.
      </p>
    </div>
  );
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;
type PostJson = <T>(path: string, body: unknown) => Promise<T>;

function PositionsTab({ account, onSelect }: { account: AccountView | null; onSelect: (conditionId: string) => void }) {
  if (!account) return <div className={`text-xs ${mutedClass}`}>Loading…</div>;
  if (!account.positions.length) return <div className={`text-xs ${mutedClass}`}>No open positions.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className={`text-left ${mutedClass}`}>
          <tr><th className="pb-1 font-medium">Market</th><th className="pb-1 font-medium">Outcome</th><th className="pb-1 text-right font-medium">Shares</th><th className="pb-1 text-right font-medium">Avg</th><th className="pb-1 text-right font-medium">Mark</th><th className="pb-1 text-right font-medium">Value</th><th className="pb-1 text-right font-medium">PnL</th></tr>
        </thead>
        <tbody className={monoClass}>
          {account.positions.map((p) => (
            <tr key={p.tokenId} className="border-t border-[hsl(var(--border))]">
              <td className="max-w-[320px] py-1.5 font-sans">
                <button type="button" className="truncate text-left hover:underline" onClick={() => onSelect(p.conditionId)}>{p.question}</button>
                {p.redeemable && <Badge tone="success">Redeemable</Badge>}
              </td>
              <td className="font-sans">{p.outcome}</td>
              <td className="text-right">{p.shares.toFixed(2)}</td>
              <td className="text-right">{cents(p.avgPrice)}</td>
              <td className="text-right">{cents(p.mark)}</td>
              <td className="text-right">{usd(p.value)}</td>
              <td className={`text-right ${pnlClass(p.unrealizedPnl ?? 0)}`}>{p.unrealizedPnl == null ? "—" : signed(p.unrealizedPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {account.account.mode === "paper" && <p className={`mt-2 text-[11px] ${mutedClass}`}>Paper positions pay out automatically when their market resolves.</p>}
      {account.account.mode === "live" && <p className={`mt-2 text-[11px] ${mutedClass}`}>Live winnings are redeemed on-chain. Redeem redeemable positions on polymarket.com with the agent&apos;s wallet.</p>}
    </div>
  );
}

function TradesTab({ agentId, call }: { agentId: string; call: Call }) {
  const [data, setData] = useState<{ trades: Trade[]; stats: { realizedPnl: number; wins: number; losses: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call<typeof data>(`trades/${agentId}`).then(setData).catch((e: Error) => setError(e.message)); }, [agentId, call]);
  if (error) return <Note tone="danger">{error}</Note>;
  if (!data) return <div className={`text-xs ${mutedClass}`}>Loading…</div>;
  if (!data.trades.length) return <div className={`text-xs ${mutedClass}`}>No trades yet.</div>;
  return (
    <div className="space-y-2">
      <div className="flex gap-5">
        <Stat label="Realized PnL"><span className={pnlClass(data.stats.realizedPnl)}>{signed(data.stats.realizedPnl)}</span></Stat>
        <Stat label="Wins / losses">{data.stats.wins} / {data.stats.losses}</Stat>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className={`text-left ${mutedClass}`}><tr><th className="pb-1 font-medium">Time</th><th className="pb-1 font-medium">Market</th><th className="pb-1 font-medium">Side</th><th className="pb-1 text-right font-medium">Shares</th><th className="pb-1 text-right font-medium">Price</th><th className="pb-1 text-right font-medium">Fee</th><th className="pb-1 text-right font-medium">PnL</th></tr></thead>
          <tbody className={monoClass}>
            {data.trades.map((t) => (
              <tr key={t.id} className="border-t border-[hsl(var(--border))]">
                <td className="whitespace-nowrap py-1">{t.createdAt ? new Date(t.createdAt).toLocaleString() : "—"}</td>
                <td className="max-w-[280px] truncate font-sans">{t.question} · {t.outcome}{t.mode === "paper" ? " · paper" : ""}{t.strategyId ? " · bot" : ""}</td>
                <td className="font-sans">{t.side === "resolve" ? <Badge tone={t.status === "won" ? "success" : "danger"}>{t.status}</Badge> : t.side}</td>
                <td className="text-right">{t.shares.toFixed(2)}</td>
                <td className="text-right">{cents(t.price)}</td>
                <td className="text-right">{usd(t.fee)}</td>
                <td className={`text-right ${pnlClass(t.side === "buy" ? 0 : t.realizedPnl)}`}>{t.side === "buy" ? "—" : signed(t.realizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OrdersTab({ agentId, call }: { agentId: string; call: Call }) {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { call<{ orders: OpenOrder[] }>(`orders/${agentId}`).then(({ orders }) => setOrders(orders)).catch((e: Error) => setError(e.message)); }, [agentId, call]);
  useEffect(load, [load]);
  if (error) return <Note tone="danger">{error}</Note>;
  if (!orders) return <div className={`text-xs ${mutedClass}`}>Loading…</div>;
  if (!orders.length) return <div className={`text-xs ${mutedClass}`}>No resting orders.</div>;
  return (
    <table className="w-full text-xs">
      <thead className={`text-left ${mutedClass}`}><tr><th className="pb-1 font-medium">Side</th><th className="pb-1 text-right font-medium">Price</th><th className="pb-1 text-right font-medium">Filled</th><th /></tr></thead>
      <tbody className={monoClass}>
        {orders.map((o) => (
          <tr key={o.id} className="border-t border-[hsl(var(--border))]">
            <td className="py-1">{o.side}</td><td className="text-right">{cents(o.price)}</td><td className="text-right">{o.filled}/{o.size}</td>
            <td className="text-right"><button className={buttonClass("danger", "py-0.5 text-xs")} onClick={() => call(`orders/${agentId}/${o.id}`, { method: "DELETE" }).then(load).catch((e: Error) => setError(e.message))}>Cancel</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BotsTab({ agentId, market, outcomeIndex, call, postJson, maxOrderUsd }: {
  agentId: string; market: Market | null; outcomeIndex: number; call: Call; postJson: PostJson; maxOrderUsd: number;
}) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<Bot["type"]>("mid-price");
  const [size, setSize] = useState("5");
  const [aiTarget, setAiTarget] = useState<"market" | "btc-5m">("btc-5m");
  const [aiHours, setAiHours] = useState("1");
  const [when, setWhen] = useState<"ask-below" | "ask-above">("ask-below");
  const [trigger, setTrigger] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [busy, setBusy] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [log, setLog] = useState<BotLog[] | null>(null);

  const load = useCallback(() => { call<{ bots: Bot[] }>(`bots/${agentId}`).then(({ bots }) => setBots(bots)).catch((e: Error) => setError(e.message)); }, [agentId, call]);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!openLog) return;
    setLog(null);
    call<{ log: BotLog[] }>(`bots/${openLog}/log`).then(({ log }) => setLog(log)).catch(() => setLog([]));
  }, [openLog, call]);

  const needsMarket = type === "price-trigger" || (type === "ai" && aiTarget === "market");

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const pct = (s: string) => (s ? Number(s) / 100 : undefined);
    const params =
      type === "ai" ? { target: aiTarget, intervalMs: Math.round(Number(aiHours) * 3_600_000) }
      : type === "price-trigger" ? { outcomeIndex, when, price: pct(trigger), takeProfit: pct(tp), stopLoss: pct(sl) }
      : {};
    try {
      await postJson("bots", { agentId, type, sizeUsd: Number(size), conditionId: needsMarket ? market?.conditionId : undefined, params });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <form className="space-y-2 lg:col-span-2" onSubmit={create}>
        <div>
          <label className={labelClass} htmlFor="pm-bot-type">Bot</label>
          <select id="pm-bot-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value as Bot["type"])}>
            {(Object.keys(BOT_LABELS) as Bot["type"][]).map((t) => <option key={t} value={t}>{BOT_LABELS[t]}</option>)}
          </select>
          <p className={`mt-1 text-[11px] ${mutedClass}`}>{BOT_HELP[type]}</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="pm-bot-size">USD per trade (max {usd(maxOrderUsd, 0)})</label>
          <input id="pm-bot-size" className={`${inputClass} ${monoClass}`} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
        {type === "ai" && (
          <>
            <Segmented label="AI target" value={aiTarget} onChange={setAiTarget} options={[{ id: "btc-5m", label: "Each BTC 5m window" }, { id: "market", label: "Selected market" }]} />
            {aiTarget === "market" && (
              <div>
                <label className={labelClass} htmlFor="pm-ai-hours">Decide every (hours)</label>
                <input id="pm-ai-hours" className={`${inputClass} ${monoClass}`} inputMode="decimal" value={aiHours} onChange={(e) => setAiHours(e.target.value)} />
              </div>
            )}
          </>
        )}
        {type === "price-trigger" && (
          <>
            <Segmented label="Trigger" value={when} onChange={setWhen} options={[{ id: "ask-below", label: "Ask ≤" }, { id: "ask-above", label: "Ask ≥" }]} />
            <div className="grid grid-cols-3 gap-2">
              <div><label className={labelClass} htmlFor="pm-trig">Price ¢</label><input id="pm-trig" className={`${inputClass} ${monoClass}`} value={trigger} onChange={(e) => setTrigger(e.target.value)} /></div>
              <div><label className={labelClass} htmlFor="pm-tp">TP ¢</label><input id="pm-tp" className={`${inputClass} ${monoClass}`} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="opt." /></div>
              <div><label className={labelClass} htmlFor="pm-sl">SL ¢</label><input id="pm-sl" className={`${inputClass} ${monoClass}`} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="opt." /></div>
            </div>
          </>
        )}
        {needsMarket && (
          <Note>{market ? <>On: <b>{market.question}</b>{type === "price-trigger" && <> · {market.outcomes[outcomeIndex]?.name}</>}</> : "Pick a market above first."}</Note>
        )}
        <button className={buttonClass("primary", "w-full")} disabled={busy || (needsMarket && !market)}>{busy ? "Creating…" : "Start bot"}</button>
        {error && <Note tone="danger">{error}</Note>}
      </form>

      <div className="space-y-2 lg:col-span-3">
        {!bots ? <div className={`text-xs ${mutedClass}`}>Loading…</div> : !bots.length ? <div className={`text-xs ${mutedClass}`}>No bots yet.</div> : bots.map((b) => (
          <div key={b.id} className={`${panelClass} p-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">{BOT_LABELS[b.type]}</span>
              <Badge tone={b.enabled ? "success" : "neutral"}>{b.enabled ? "On" : "Off"}</Badge>
              {b.waitingOnAgent && <Badge tone="warning">Waiting on agent</Badge>}
              <span className={`${monoClass} text-xs ${mutedClass}`}>{usd(b.sizeUsd)}/trade</span>
              <div className="ml-auto flex gap-1">
                <button className={buttonClass("secondary", "py-0.5 text-xs")} onClick={() => setOpenLog(openLog === b.id ? null : b.id)}>{openLog === b.id ? "Hide log" : "Log"}</button>
                <button className={buttonClass("secondary", "py-0.5 text-xs")} onClick={() => postJson(`bots/${b.id}/toggle`, { enabled: !b.enabled }).then(load).catch((e: Error) => setError(e.message))}>{b.enabled ? "Stop" : "Start"}</button>
                <button className={buttonClass("danger", "py-0.5 text-xs")} onClick={() => { if (window.confirm("Delete this bot and its log?")) call(`bots/${b.id}`, { method: "DELETE" }).then(load).catch((e: Error) => setError(e.message)); }}>Delete</button>
              </div>
            </div>
            {b.market && <div className="mt-1 truncate text-xs">{b.market.question}</div>}
            {b.lastReason && <div className={`mt-1 text-[11px] ${mutedClass}`}>Last check: {b.lastReason}</div>}
            {openLog === b.id && (
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto border-t border-[hsl(var(--border))] pt-2 text-[11px]">
                {!log ? <li className={mutedClass}>Loading…</li> : !log.length ? <li className={mutedClass}>Nothing logged yet.</li> : log.map((l) => (
                  <li key={l.id} className="flex gap-2">
                    <span className={`${monoClass} shrink-0 ${mutedClass}`}>{l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : ""}</span>
                    <Badge tone={l.kind === "entry" || l.kind === "exit" ? "success" : l.kind === "error" ? "danger" : "neutral"}>{l.kind}</Badge>
                    <span className="min-w-0 break-words">{l.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({ agent, account, postJson, onChange }: { agent: MyAgent; account: AccountView | null; postJson: PostJson; onChange: () => void }) {
  const risk = account?.account.risk;
  const [form, setForm] = useState({ maxOrderUsd: "", maxExposureUsd: "", maxDailyLossUsd: "" });
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (risk) setForm({ maxOrderUsd: String(risk.maxOrderUsd), maxExposureUsd: String(risk.maxExposureUsd), maxDailyLossUsd: String(risk.maxDailyLossUsd) });
  }, [risk?.maxOrderUsd, risk?.maxExposureUsd, risk?.maxDailyLossUsd]);

  const run = async (label: string, path: string, body: unknown, done: string) => {
    setBusy(label);
    setMsg(null);
    try {
      await postJson(path, body);
      setMsg({ tone: "success", text: done });
      onChange();
    } catch (err) {
      setMsg({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const mode = account?.account.mode ?? agent.mode;
  const liveAddr = account?.account.live?.address ?? agent.liveAddress;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <form
        className="space-y-2"
        onSubmit={(e) => { e.preventDefault(); run("risk", "risk", { agentId: agent.agentId, ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])) }, "Risk limits saved"); }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide">Risk limits</h3>
        <div className="grid grid-cols-3 gap-2">
          {([["maxOrderUsd", "Max order $"], ["maxExposureUsd", "Max open $"], ["maxDailyLossUsd", "Daily loss $"]] as const).map(([k, label]) => (
            <div key={k}>
              <label className={labelClass} htmlFor={`pm-${k}`}>{label}</label>
              <input id={`pm-${k}`} className={`${inputClass} ${monoClass}`} inputMode="decimal" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <p className={`text-[11px] ${mutedClass}`}>Apply to the panel, the agent&apos;s own orders and every bot. Only people can change them; the agent can&apos;t.</p>
        <button className={buttonClass("primary")} disabled={busy === "risk"}>Save limits</button>

        <h3 className="pt-3 text-xs font-semibold uppercase tracking-wide">Paper account</h3>
        <p className={`text-[11px] ${mutedClass}`}>Paper orders fill against the real Polymarket book with real fees, and pay out when markets resolve.</p>
        <button
          type="button" className={buttonClass("secondary")} disabled={!!busy}
          onClick={() => { if (window.confirm("Reset paper cash to $1,000 and clear paper positions?")) run("reset", "paper/reset", { agentId: agent.agentId }, "Paper account reset to $1,000"); }}
        >
          Reset paper account
        </button>
        {mode === "live" && (
          <button type="button" className={buttonClass("secondary", "ml-2")} disabled={!!busy} onClick={() => run("mode", "mode", { agentId: agent.agentId, mode: "paper" }, "Switched to paper")}>
            Switch to paper
          </button>
        )}
      </form>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide">Live trading</h3>
        <p className={`text-[11px] ${mutedClass}`}>
          Live orders are signed by this agent&apos;s own wallet on Polygon (pUSD collateral) on Polymarket&apos;s international exchange. Polymarket blocks some regions, including the US. In a blocked region every live order is refused.
        </p>
        {account?.geo && (
          <Note tone={account.geo.blocked ? "danger" : "success"}>
            This server: {account.geo.blocked ? "blocked by Polymarket" : "allowed"} ({[account.geo.region, account.geo.country].filter(Boolean).join(", ") || "unknown"})
          </Note>
        )}
        {!liveAddr ? (
          agent.isOwner ? (
            <button
              className={buttonClass("primary")} disabled={!!busy}
              onClick={() => { if (window.confirm("Turn on live trading for this agent? It will sign Polymarket orders with its own wallet, within the risk limits.")) run("live", "live/enable", { agentId: agent.agentId }, "Live trading on. Fund the wallet with pUSD and a little POL, then run approvals."); }}
            >
              Set up live trading
            </button>
          ) : <Note>Only the org owner can turn on live trading.</Note>
        ) : (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className={mutedClass}>Wallet</span>
              <code className={monoClass} title={liveAddr}>{shortAddr(liveAddr)}</code>
              <button className="underline" type="button" onClick={() => navigator.clipboard?.writeText(liveAddr)}>Copy</button>
              <Badge tone={mode === "live" ? "warning" : "neutral"}>{mode === "live" ? "Active" : "Inactive (paper)"}</Badge>
            </div>
            {account?.wallet && (
              <>
                <div className="flex gap-5"><Stat label="pUSD">{usd(account.wallet.pusd)}</Stat><Stat label="POL (gas)">{account.wallet.pol.toFixed(3)}</Stat></div>
                <ul className="space-y-0.5">
                  {account.wallet.approvals.map((a) => <li key={a.label} className="flex justify-between"><span>{a.label}</span><Badge tone={a.ok ? "success" : "warning"}>{a.ok ? "OK" : "Needed"}</Badge></li>)}
                </ul>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {agent.isOwner && account?.wallet && !account.wallet.ready && (
                <button className={buttonClass("primary")} disabled={!!busy} onClick={() => run("approve", "live/approve", { agentId: agent.agentId }, "Approvals sent")}>
                  {busy === "approve" ? "Sending approvals…" : "Run approvals"}
                </button>
              )}
              {agent.isOwner && mode !== "live" && (
                <button className={buttonClass("secondary")} disabled={!!busy} onClick={() => run("mode", "mode", { agentId: agent.agentId, mode: "live" }, "Switched to live")}>Switch to live</button>
              )}
              <button className={buttonClass("danger")} disabled={!!busy} onClick={() => { if (window.confirm("Turn off live trading and unlink the wallet? Funds stay in the wallet.")) run("off", "live/disable", { agentId: agent.agentId }, "Live trading off"); }}>
                Turn off live
              </button>
            </div>
          </div>
        )}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { trading: PolymarketPanel } });
