"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { parseOrder, describeOrder, type ParsedOrder } from "./orders";
import { BacktestPanel, type BotSpec } from "./backtest-panel";
import { activeAssetCtxSubscription, hlWsUrl, parseActiveAssetCtx } from "./oracle";

type Network = "testnet" | "mainnet";

interface Position {
  coin: string;
  size: number;
  notionalUsd: number;
  entryPrice: number;
  unrealizedPnl: number;
}

interface TradeRecord {
  id: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  fillPrice?: number;
  realizedPnl?: number;
  /** opened/closed for live trades; paper fills can also be sl, tp, limit or liquidation. */
  status: string;
}

interface PaperTrade {
  id: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  px: number;
  fee: number;
  realizedPnl: number;
  reduceOnly: boolean;
  reason: "manual" | "limit" | "sl" | "tp" | "liquidation" | "strategy";
}

interface PaperPositionRow {
  coin: string;
  szi: number;
  entryPx: number;
  notionalUsd: number;
  unrealizedPnl: number;
  slPx: number | null;
  tpPx: number | null;
}

interface PaperRestingOrder {
  orderId: string;
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  leverage: number;
  reduceOnly: boolean;
}

interface PaperAccountView {
  balance: number;
  startBalance: number;
  dailyPnl: number;
  equity: number;
  marginUsed: number;
  available: number;
  positions: PaperPositionRow[];
  orders: PaperRestingOrder[];
}

const PAPER_MODE_KEY = "hyperliquid-trading:paper";

interface Strategy {
  id: string;
  type: "dca" | "grid" | "signal" | "sniper" | "ai";
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  pendingSignal: boolean;
  webhookToken: string | null;
  paper?: boolean;
  params?: Record<string, unknown>;
  lastRunAt?: string | null;
}

interface AiDecisionEntry {
  id: string;
  decision: "LONG" | "SHORT" | "CLOSE" | "NOTHING" | null;
  action: string;
  reasoning: string;
  model: string | null;
  price: number | null;
  equity: number | null;
  taskId: string | null;
  error: string | null;
  createdAt: string | null;
}

interface RiskConfig {
  leverage: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
}

interface ReferralStats {
  code: string;
  referredBy: string | null;
  referredCount: number;
  totalVolumeUsd: number;
  rewardUsd: number;
}

interface MyAgent {
  agentId: string;
  name: string;
  orgId: string;
  orgName: string;
  status: string;
  wallet: { network: Network; address: string | null; instant: boolean } | null;
  isOwner: boolean;
}

interface OrderLogEntry {
  id: number;
  summary: string;
  agentName: string;
  taskId?: string;
  status: string;
}

interface AgentConnection {
  agentId: string;
  capabilities: Record<string, boolean>;
  wallet: { configured: boolean; network: Network | null };
  risk: RiskConfig | null;
  pendingStrategies: number;
  readyToTrade: boolean;
}

interface MarketCoin {
  coin: string;
  markPx: number;
  change24hPct: number;
  volume24hUsd: number;
  openInterestUsd: number;
  fundingRatePct: number;
  maxLeverage: number;
}

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BookLevel {
  px: number;
  sz: number;
}

type BottomTab = "positions" | "orders" | "bots" | "backtest" | "history" | "agent";
type MarketSort = "volume" | "price" | "change" | "funding";
type StrategyType = Strategy["type"];

const MARKET_SORTS: { id: MarketSort; label: string }[] = [
  { id: "volume", label: "Vol" },
  { id: "price", label: "Price" },
  { id: "change", label: "24h%" },
  { id: "funding", label: "Funding" },
];

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

const SIZE_PRESETS = [15, 25, 50, 100];

/** Hyperliquid rejects opening orders worth less than this. */
const MIN_ORDER_USD = 10;

const TRAIN_IDEAS: { label: string; coin: string; goal: string }[] = [
  { label: "Fade BTC funding", coin: "BTC", goal: "Fade BTC when hourly funding is extreme. Stay flat when funding is ordinary. One position at a time." },
  { label: "ETH trend only", coin: "ETH", goal: "Practice ETH trend. Go long only while price holds above the 20-bar average. Go flat when it loses that average. Do not short." },
  { label: "SOL back to average", coin: "SOL", goal: "SOL mean reversion. Short stretches well above the 40-bar average and cover back near that average. Stay flat in the middle of the range." },
];

const BOT_KINDS: Record<StrategyType, { label: string; blurb: string }> = {
  ai: { label: "AI Trader", blurb: "Your agent reads the market each round and goes long, short or flat — on its own model." },
  dca: { label: "DCA", blurb: "Buys a fixed amount on a schedule." },
  grid: { label: "Grid", blurb: "Buys low and sells high inside a price range." },
  signal: { label: "Signal", blurb: "Fires from a webhook (TradingView) or by hand." },
  sniper: { label: "Sniper", blurb: "Fires on a new listing or a price trigger." },
};

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "timeout"];

function formatPrice(n: number) {
  return n.toLocaleString(undefined, n >= 1 ? { maximumFractionDigits: 2, minimumFractionDigits: 2 } : { maximumFractionDigits: 6 });
}

function formatCompactUsd(n: number) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatSize(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 2 : 4 });
}

function formatTime(t: number, interval: Interval) {
  const d = new Date(t);
  return interval === "1d" || interval === "4h"
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatEvery(ms: number) {
  if (!ms) return "—";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

const inputClass =
  "w-full rounded-sm border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm placeholder:text-[hsl(var(--muted-foreground))] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]";

const labelClass = "block text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1";

const monoClass = "font-mono tabular-nums";

const mutedClass = "text-[hsl(var(--muted-foreground))]";

const panelClass = "rounded-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))]";

function pnlClass(value: number) {
  return value >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function orderTone(status: string): "success" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (/^(rejected|failed|cancelled|timeout)/.test(status)) return "danger";
  return "neutral";
}

function PulseDot({ tone }: { tone: "live" | "idle" | "danger" }) {
  const color = { live: "bg-green-500", idle: "bg-[hsl(var(--muted-foreground))]/40", danger: "bg-red-500" }[tone];
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
      {tone === "live" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60 motion-reduce:animate-none`} />}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

function primaryButtonClass(extra = "") {
  return (
    "inline-flex items-center justify-center rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white " +
    "transition-colors hover:bg-[hsl(var(--primary))]/90 disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))] " +
    extra
  );
}

function secondaryButtonClass(extra = "") {
  return (
    "inline-flex items-center justify-center rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-1.5 text-sm font-medium " +
    "transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))] " +
    extra
  );
}

/** Two-or-more option toggle, e.g. Market | Limit or the chart intervals. */
function Segmented<T extends string>({ value, options, onChange, label, size = "sm" }: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "xs";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-sm border border-[hsl(var(--border))] overflow-hidden">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={
            (size === "xs" ? "px-2 py-0.5 text-[11px] " : "px-3 py-1 text-xs ") +
            "font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))] " +
            (value === o.id ? "bg-[hsl(var(--primary))] text-white" : `${mutedClass} hover:text-[hsl(var(--foreground))]`)
          }
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Badge({ tone, children }: { tone: "neutral" | "success" | "danger" | "warning"; children: React.ReactNode }) {
  const toneClass = {
    neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
    success: "bg-green-600/10 text-green-700 dark:text-green-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneClass}`}>
      {children}
    </span>
  );
}

function Section({ title, description, dense, right, children }: {
  title: string;
  description?: string;
  dense?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-3 py-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--card-foreground))]">{title}</h2>
          {description && <p className={`text-xs ${mutedClass} mt-0.5`}>{description}</p>}
        </div>
        {right}
      </div>
      <div className={dense ? "p-2 space-y-2" : "p-3 space-y-3"}>{children}</div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className={`flex items-center gap-2 text-sm ${mutedClass} py-4`} role="status">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-[hsl(var(--muted-foreground))]/30 border-t-foreground motion-reduce:animate-none"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-[hsl(var(--destructive))]/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className={secondaryButtonClass("shrink-0")} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] uppercase tracking-wide ${mutedClass}`}>{label}</div>
      <div className={`${monoClass} text-xs text-[hsl(var(--foreground))] whitespace-nowrap`}>{children}</div>
    </div>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────────────

const AXIS_W = 64;
const TIME_H = 18;
const VOL_H = 44;

/** Candlesticks + volume, drawn in SVG. Hover shows the bar's OHLC; dashed lines mark the last price and the open position's entry. */
function CandleChart({ candles: all, interval, entryPx }: { candles: Candle[]; interval: Interval; entryPx: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real pixel size so text stays legible from phone to desktop.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 340 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0) setBox({ w: Math.round(width), h: Math.round(height) });
    };
    const rect = el.getBoundingClientRect();
    measure(rect.width, rect.height);
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const CHART_W = box.w;
  const CHART_H = box.h;
  // Narrow screens show fewer, wider bars.
  const maxBars = Math.max(20, Math.floor((CHART_W - AXIS_W) / 5));
  const candles = all.length > maxBars ? all.slice(-maxBars) : all;
  const plotW = CHART_W - AXIS_W;
  const priceH = CHART_H - TIME_H - VOL_H;

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  if (entryPx) {
    highs.push(entryPx);
    lows.push(entryPx);
  }
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const pad = (hi - lo || hi * 0.01 || 1) * 0.06;
  const top = hi + pad;
  const bottom = lo - pad;
  const y = (p: number) => ((top - p) / (top - bottom)) * priceH;
  const step = plotW / candles.length;
  const bodyW = Math.max(1, step * 0.66);
  const maxVol = Math.max(...candles.map((c) => c.v)) || 1;
  const ticks = Array.from({ length: 5 }, (_, i) => bottom + ((top - bottom) * (i + 0.5)) / 5);
  const timeEvery = Math.max(1, Math.round(candles.length / Math.max(2, Math.floor(plotW / 110))));
  const last = candles[candles.length - 1];
  const shown = hover != null ? candles[hover] : last;
  const shownUp = shown.c >= shown.o;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CHART_W;
    const i = Math.floor(x / step);
    setHover(x < plotW && i >= 0 && i < candles.length ? i : null);
  }

  return (
    <div ref={boxRef} className="absolute inset-1 overflow-hidden">
      <div className={`absolute left-2 top-1 flex flex-wrap gap-x-2 text-[11px] ${monoClass} pointer-events-none`}>
        <span className={mutedClass}>{formatTime(shown.t, interval)}</span>
        <span>O <span className={shownUp ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{formatPrice(shown.o)}</span></span>
        <span>H <span className={shownUp ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{formatPrice(shown.h)}</span></span>
        <span>L <span className={shownUp ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{formatPrice(shown.l)}</span></span>
        <span>C <span className={shownUp ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{formatPrice(shown.c)}</span></span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width={CHART_W} height={CHART_H} className="absolute inset-0 select-none"
        role="img"
        aria-label={`Price chart, last ${formatPrice(last.c)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((p) => (
          <g key={p}>
            <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className="stroke-[hsl(var(--border))]" strokeWidth={1} />
            <text x={plotW + 6} y={y(p) + 4} className="fill-[hsl(var(--muted-foreground))]" fontSize={11} fontFamily="ui-monospace, monospace">
              {formatPrice(p)}
            </text>
          </g>
        ))}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const cx = i * step + step / 2;
          const color = up ? "fill-green-500 stroke-green-500" : "fill-red-500 stroke-red-500";
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyH = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          const volH = (c.v / maxVol) * (VOL_H - 6);
          return (
            <g key={c.t} className={color} opacity={hover == null || hover === i ? 1 : 0.55}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} strokeWidth={1} />
              <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} strokeWidth={0} />
              <rect x={cx - bodyW / 2} y={priceH + VOL_H - volH} width={bodyW} height={volH} strokeWidth={0} opacity={0.3} />
              {i % timeEvery === 0 && cx > 28 && cx < plotW - 28 && (
                <text
                  x={cx} y={CHART_H - 4} textAnchor="middle" className="fill-[hsl(var(--muted-foreground))] stroke-none"
                  fontSize={10} fontFamily="ui-monospace, monospace"
                >
                  {formatTime(c.t, interval)}
                </text>
              )}
            </g>
          );
        })}
        {entryPx != null && (
          <g>
            <line x1={0} x2={plotW} y1={y(entryPx)} y2={y(entryPx)} className="stroke-amber-500" strokeDasharray="2 3" strokeWidth={1} />
            <text x={4} y={y(entryPx) - 4} className="fill-amber-600 dark:fill-amber-400" fontSize={10} fontFamily="ui-monospace, monospace">
              entry {formatPrice(entryPx)}
            </text>
          </g>
        )}
        <line
          x1={0} x2={plotW} y1={y(last.c)} y2={y(last.c)} strokeDasharray="4 3" strokeWidth={1}
          className={last.c >= last.o ? "stroke-green-500" : "stroke-red-500"}
        />
        <rect x={plotW} y={y(last.c) - 9} width={AXIS_W} height={18} className={last.c >= last.o ? "fill-green-600" : "fill-red-600"} />
        <text x={plotW + 6} y={y(last.c) + 4} fill="white" fontSize={11} fontFamily="ui-monospace, monospace">
          {formatPrice(last.c)}
        </text>
        {hover != null && (
          <line
            x1={hover * step + step / 2} x2={hover * step + step / 2} y1={0} y2={priceH + VOL_H}
            className="stroke-[hsl(var(--muted-foreground))]" strokeDasharray="3 3" strokeWidth={1}
          />
        )}
      </svg>
    </div>
  );
}

// ── Order book ────────────────────────────────────────────────────────────────

function OrderBook({ bids, asks, onPick }: { bids: BookLevel[]; asks: BookLevel[]; onPick: (px: number) => void }) {
  const depth = 10;
  const withTotals = (levels: BookLevel[]) => {
    let total = 0;
    return levels.slice(0, depth).map((l) => ({ ...l, total: (total += l.sz) }));
  };
  const askRows = withTotals(asks).reverse();
  const bidRows = withTotals(bids);
  const maxTotal = Math.max(askRows[0]?.total ?? 0, bidRows[bidRows.length - 1]?.total ?? 0) || 1;
  const spread = asks[0] && bids[0] ? asks[0].px - bids[0].px : null;

  const row = (l: BookLevel & { total: number }, side: "ask" | "bid") => (
    <button
      key={`${side}-${l.px}`}
      type="button"
      className="relative grid w-full grid-cols-3 px-2 py-[3px] text-[11px] hover:bg-[hsl(var(--accent))]/60 focus-visible:outline-none focus-visible:bg-[hsl(var(--accent))]"
      onClick={() => onPick(l.px)}
      title="Use this price for a limit order"
    >
      <span
        className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-red-500/10" : "bg-green-500/10"}`}
        style={{ width: `${(l.total / maxTotal) * 100}%` }}
        aria-hidden="true"
      />
      <span className={`relative text-left ${monoClass} ${side === "ask" ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
        {formatPrice(l.px)}
      </span>
      <span className={`relative text-right ${monoClass}`}>{formatSize(l.sz)}</span>
      <span className={`relative text-right ${monoClass} ${mutedClass}`}>{formatSize(l.total)}</span>
    </button>
  );

  return (
    <div>
      <div className={`grid grid-cols-3 px-2 pb-1 text-[10px] uppercase tracking-wide ${mutedClass}`}>
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>
      {askRows.map((l) => row(l, "ask"))}
      <div className={`flex items-center justify-between border-y border-[hsl(var(--border))] px-2 py-1 text-[11px] ${monoClass}`}>
        <span className={mutedClass}>Spread</span>
        <span>
          {spread != null ? formatPrice(spread) : "—"}
          {spread != null && bids[0] && <span className={`ml-2 ${mutedClass}`}>{((spread / bids[0].px) * 100).toFixed(3)}%</span>}
        </span>
      </div>
      {bidRows.map((l) => row(l, "bid"))}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function TradingPanel({ api }: PanelProps) {
  const [orgId, setOrgId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [wallet, setWallet] = useState("");
  const [bottomTab, setBottomTab] = useState<BottomTab>("positions");

  // Shared, in-memory only — never written to localStorage, never sent anywhere
  // but this mod's own API, and re-entered whenever the panel reloads. This is
  // the agent's own passphrase decrypting its own stored Hyperliquid key; the
  // platform never retains it (see server.ts's resolveAgentWallet). Not needed
  // at all once instant trading is on.
  const [masterSecret, setMasterSecret] = useState("");

  // Paper mode: every order, position and new bot goes to the agent's virtual
  // account, filled against the real mainnet book. Remembered per browser.
  const [paperMode, setPaperModeState] = useState(false);
  useEffect(() => {
    try {
      setPaperModeState(localStorage.getItem(PAPER_MODE_KEY) === "1");
    } catch {
      // storage blocked — start in live mode
    }
  }, []);
  function setPaperMode(on: boolean) {
    setPaperModeState(on);
    try {
      localStorage.setItem(PAPER_MODE_KEY, on ? "1" : "0");
    } catch {
      // storage blocked — the toggle still works for this visit
    }
  }

  // ── Agent picker ───────────────────────────────────────────────────────────
  const [myAgents, setMyAgents] = useState<MyAgent[] | "loading" | "error">("loading");

  async function loadMyAgents() {
    setMyAgents((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const resp = await api("my-agents");
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const agents: MyAgent[] = data.agents ?? [];
      setMyAgents(agents);
      // Pre-select when there's an obvious choice: the only agent, or the only one that can trade.
      const ready = agents.filter((a) => a.wallet);
      const only = agents.length === 1 ? agents[0] : ready.length === 1 ? ready[0] : null;
      if (only && !agentId) selectAgent(only);
    } catch {
      setMyAgents("error");
    }
  }

  function selectAgent(a: MyAgent | undefined) {
    setAgentId(a?.agentId ?? "");
    setOrgId(a?.orgId ?? "");
    setWallet(a?.wallet?.address ?? "");
  }

  useEffect(() => {
    loadMyAgents();
  }, []);

  const selectedAgent = Array.isArray(myAgents) ? myAgents.find((a) => a.agentId === agentId) : undefined;

  // ── Wallet setup ───────────────────────────────────────────────────────────
  const [walletStatus, setWalletStatus] = useState<{
    hasWallet: boolean; network: Network | null; instant: boolean; address: string | null;
  } | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletKeyInput, setWalletKeyInput] = useState("");
  const [walletNetwork, setWalletNetwork] = useState<Network>("testnet");
  const [walletFormOpen, setWalletFormOpen] = useState(false);
  const [walletActionStatus, setWalletActionStatus] = useState<string | null>(null);

  async function loadWalletStatus() {
    if (!agentId) return;
    setWalletLoading(true);
    try {
      const resp = await api(`wallet/${agentId}`);
      const data = await resp.json();
      setWalletStatus({
        hasWallet: !!data.hasWallet, network: data.network ?? null, instant: !!data.instant, address: data.address ?? null,
      });
      if (data.address) setWallet(data.address);
    } finally {
      setWalletLoading(false);
    }
  }

  async function saveWallet(e: FormEvent) {
    e.preventDefault();
    if (!agentId || !orgId) return;
    setWalletActionStatus("saving…");
    const resp = await api("wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, privateKey: walletKeyInput, masterSecret, network: walletNetwork }),
    });
    const data = await resp.json();
    if (data.error) {
      setWalletActionStatus(`error: ${data.error}`);
      return;
    }
    setWalletActionStatus("saved");
    setWalletKeyInput("");
    setWalletFormOpen(false);
    loadWalletStatus();
  }

  async function removeWallet() {
    if (!agentId) return;
    if (!confirm("Remove this agent's Hyperliquid wallet? It will need a new key before it can trade again.")) return;
    setWalletActionStatus("removing…");
    await api(`wallet/${agentId}`, { method: "DELETE" });
    setWalletActionStatus(null);
    loadWalletStatus();
  }

  useEffect(() => {
    if (agentId) loadAgentData();
  }, [agentId]);

  // ── Instant trading ────────────────────────────────────────────────────────
  // On: the platform signs with the agent's own platform-held wallet, so no
  // passphrase is needed anywhere. The org owner is already signed in, so
  // their first order switches it on silently (ensureSigner); anyone in the
  // org can turn it off.
  const instant = !!walletStatus?.instant;
  const isOwner = !!selectedAgent?.isOwner;
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [instantNetwork, setInstantNetwork] = useState<Network>("testnet");
  const [instantBusy, setInstantBusy] = useState(false);
  const [instantStatus, setInstantStatus] = useState<string | null>(null);
  useEffect(() => { setUsePassphrase(false); setInstantStatus(null); }, [agentId]);
  // Owners can always act — ensureSigner turns instant trading on as needed.
  // Paper orders need no signer at all.
  const canSign = paperMode || instant || !!masterSecret || (isOwner && !usePassphrase);
  const needsPassphraseInput = !paperMode && !instant && (!isOwner || usePassphrase);
  // Market data follows the network the agent trades on — or, before it
  // trades, the one its owner has picked. Paper always uses mainnet prices.
  const network: Network = paperMode ? "mainnet" : walletStatus?.network ?? instantNetwork;

  async function enableInstant(net: Network = instantNetwork): Promise<string | null> {
    if (!agentId) return null;
    if (net === "mainnet" && !confirm(
      "Trade on MAINNET? Your agent will sign real-money trades from its own wallet, within its risk limits.",
    )) return null;
    setInstantBusy(true);
    setInstantStatus(null);
    try {
      const resp = await api("instant-trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, network: net }),
      });
      const data = await resp.json();
      if (data.error) {
        setInstantStatus(`error: ${data.error}`);
        return null;
      }
      setWalletStatus({ hasWallet: true, network: data.network, instant: true, address: data.address });
      setWallet(data.address);
      setInstantStatus(`Your agent trades from ${data.address} on Hyperliquid ${data.network} — fund it there if it's empty.`);
      loadMyAgents();
      loadRiskConfig();
      return data.address as string;
    } finally {
      setInstantBusy(false);
    }
  }

  /**
   * Called before any trade, close or bot fire. Already signing (instant or
   * passphrase) → go. Owner without instant → switch it on now, on the
   * network picked in the top bar. No prompt on testnet. Resolves to the
   * wallet the agent trades from (state may not have caught up yet), or null.
   */
  async function ensureSigner(): Promise<{ wallet: string } | null> {
    if (instant || masterSecret) return { wallet };
    if (!isOwner || usePassphrase) return null;
    const address = await enableInstant(instantNetwork);
    return address ? { wallet: address } : null;
  }

  async function disableInstant() {
    if (!agentId) return;
    setInstantBusy(true);
    try {
      const resp = await api(`instant-trading/${agentId}`, { method: "DELETE" });
      const data = await resp.json();
      setInstantStatus(data.error ? `error: ${data.error}` : "Off — trades need the passphrase again.");
      if (!data.error) setUsePassphrase(true);
      loadAgentData();
      loadMyAgents();
    } finally {
      setInstantBusy(false);
    }
  }

  // ── Markets ────────────────────────────────────────────────────────────────
  const [coin, setCoin] = useState("ETH");
  const [marketCoins, setMarketCoins] = useState<MarketCoin[] | "loading" | "error" | null>(null);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSort, setMarketSort] = useState<MarketSort>("volume");
  const [marketOpen, setMarketOpen] = useState(false);
  const marketSearchRef = useRef<HTMLInputElement>(null);

  async function loadMarket() {
    setMarketCoins((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const resp = await api(`market?network=${network}`);
      const data = await resp.json();
      if (data.error) {
        setMarketCoins("error");
        return;
      }
      setMarketCoins(data.coins ?? []);
    } catch {
      setMarketCoins("error");
    }
  }

  useEffect(() => {
    loadMarket();
    const id = setInterval(loadMarket, 15000);
    return () => clearInterval(id);
  }, [network]);

  useEffect(() => {
    if (!marketOpen) return;
    marketSearchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMarketOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marketOpen]);

  const filteredMarket = Array.isArray(marketCoins)
    ? marketCoins
        .filter((c) => c.coin.toLowerCase().includes(marketQuery.toLowerCase()))
        .sort((a, b) => {
          if (marketSort === "price") return b.markPx - a.markPx;
          if (marketSort === "change") return b.change24hPct - a.change24hPct;
          if (marketSort === "funding") return b.fundingRatePct - a.fundingRatePct;
          return b.volume24hUsd - a.volume24hUsd;
        })
    : [];

  const coinInfo = Array.isArray(marketCoins) ? marketCoins.find((c) => c.coin === coin) : undefined;
  const markOf = (c: string) => (Array.isArray(marketCoins) ? marketCoins.find((m) => m.coin === c)?.markPx : undefined);

  function pickCoin(c: string) {
    setCoin(c);
    setMarketOpen(false);
    setMarketQuery("");
    setLimitPrice("");
  }

  // ── Live price, chart, book ────────────────────────────────────────────────
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [oraclePx, setOraclePx] = useState<number | null>(null);
  const [markPx, setMarkPx] = useState<number | null>(null);
  const [priceFeed, setPriceFeed] = useState<"ws" | "poll">("poll");
  const [chartInterval, setChartInterval] = useState<Interval>("15m");
  const [candles, setCandles] = useState<Candle[] | "loading" | "error">("loading");
  const [book, setBook] = useState<{ bids: BookLevel[]; asks: BookLevel[] } | null>(null);

  // Live prices: Hyperliquid's `activeAssetCtx` WebSocket pushes mid, mark and
  // the validator oracle price ~1/s. While the socket is down, poll the mod's
  // price + on-chain oracle routes every 5s, and retry the socket.
  useEffect(() => {
    if (!coin) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let retryId: ReturnType<typeof setTimeout> | null = null;
    setLivePrice(null);
    setOraclePx(null);
    setMarkPx(null);
    setPriceFeed("poll");

    async function poll() {
      const [mid, oracle] = await Promise.all([
        api(`price/${coin}?network=${network}`).then((r) => r.json()).catch(() => null),
        api(`oracle/${coin}?network=${network}`).then((r) => r.json()).catch(() => null),
      ]);
      if (cancelled) return;
      setLivePrice(mid?.price ?? null);
      setOraclePx(oracle?.oraclePx ?? null);
      if (oracle?.markPx) setMarkPx(oracle.markPx);
    }
    function startPolling() {
      if (pollId || cancelled) return;
      setPriceFeed("poll");
      poll();
      pollId = setInterval(poll, 5000);
    }
    function stopPolling() {
      if (pollId) clearInterval(pollId);
      pollId = null;
    }
    function connect() {
      if (cancelled || typeof WebSocket === "undefined") return startPolling();
      try {
        ws = new WebSocket(hlWsUrl(network));
      } catch {
        return startPolling();
      }
      ws.onopen = () => ws?.send(JSON.stringify(activeAssetCtxSubscription(coin)));
      ws.onmessage = (e) => {
        let px;
        try {
          px = parseActiveAssetCtx(JSON.parse(e.data));
        } catch {
          return;
        }
        if (!px || cancelled || px.coin !== coin) return;
        stopPolling();
        setPriceFeed("ws");
        setLivePrice(px.midPx ?? px.markPx);
        setOraclePx(px.oraclePx);
        setMarkPx(px.markPx);
      };
      ws.onclose = () => {
        if (cancelled) return;
        startPolling();
        retryId = setTimeout(connect, 5000);
      };
    }
    connect();
    // Show a price right away rather than waiting on the socket handshake.
    poll();
    return () => {
      cancelled = true;
      stopPolling();
      if (retryId) clearTimeout(retryId);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [coin, network, api]);

  useEffect(() => {
    let cancelled = false;
    setCandles("loading");
    async function poll() {
      try {
        const resp = await api(`candles/${coin}?interval=${chartInterval}&network=${network}`);
        const data = await resp.json();
        if (cancelled) return;
        setCandles(data.error ? "error" : data.candles ?? []);
      } catch {
        if (!cancelled) setCandles((prev) => (Array.isArray(prev) ? prev : "error"));
      }
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, chartInterval, network, api]);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    async function poll() {
      try {
        const resp = await api(`book/${coin}?network=${network}`);
        const data = await resp.json();
        if (!cancelled && !data.error) setBook({ bids: data.bids ?? [], asks: data.asks ?? [] });
      } catch {
        // transient — keep the last book
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, network, api]);

  // Keep the last candle in step with the 5s live price between chart polls.
  const chartCandles = Array.isArray(candles) && candles.length > 0 && livePrice != null
    ? [...candles.slice(0, -1), (() => {
        const last = candles[candles.length - 1];
        return { ...last, c: livePrice, h: Math.max(last.h, livePrice), l: Math.min(last.l, livePrice) };
      })()]
    : candles;

  const price = livePrice ?? coinInfo?.markPx ?? null;

  // ── Order ticket ───────────────────────────────────────────────────────────
  const [isBuy, setIsBuy] = useState(true);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [sizeUsd, setSizeUsd] = useState("25");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [tpslOn, setTpslOn] = useState(false);
  const [stopLossPct, setStopLossPct] = useState("");
  const [takeProfitPct, setTakeProfitPct] = useState("");

  const maxLeverage = coinInfo?.maxLeverage ?? 20;
  useEffect(() => {
    if (leverage > maxLeverage) setLeverage(maxLeverage);
  }, [maxLeverage]);

  const sizeNum = Number(sizeUsd) || 0;
  const execPrice = orderType === "limit" ? Number(limitPrice) || null : price;
  const belowMinimum = sizeNum > 0 && sizeNum < MIN_ORDER_USD;
  const ticketReady = !!agentId && canSign && sizeNum >= MIN_ORDER_USD && (orderType === "market" || !!Number(limitPrice));

  function pickBookPrice(px: number) {
    setOrderType("limit");
    setLimitPrice(String(px));
  }

  async function submitTicket(e: FormEvent) {
    e.preventDefault();
    if (!ticketReady) return;
    const lev = leverage > 1 ? ` ${leverage}x` : "";
    const at = orderType === "limit" ? ` @ ${limitPrice}` : "";
    await placeOrder("trade", {
      coin, isBuy, sizeUsd: sizeNum, orderType,
      limitPrice: orderType === "limit" ? Number(limitPrice) : undefined,
      leverage,
      stopLossPct: tpslOn && stopLossPct ? Number(stopLossPct) : undefined,
      takeProfitPct: tpslOn && takeProfitPct ? Number(takeProfitPct) : undefined,
    }, `${isBuy ? "Long" : "Short"} ${coin} $${sizeNum}${lev}${at}`);
  }

  // ── Orders (every trade/close sent from this panel) ───────────────────────
  const [orderLog, setOrderLog] = useState<OrderLogEntry[]>([]);
  const [orderSending, setOrderSending] = useState(false);

  function updateOrder(id: number, patch: Partial<OrderLogEntry>) {
    setOrderLog((log) => log.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }

  /** One path for the ticket, the command line and Close buttons: sign, send, then follow the task. */
  async function placeOrder(kind: "trade" | "close", fields: Record<string, unknown>, summary: string): Promise<boolean> {
    if (!agentId) return false;
    if (paperMode) return placePaperOrder(kind, fields, summary);
    if (!(await ensureSigner())) return false;
    const entry: OrderLogEntry = { id: Date.now(), summary, agentName: selectedAgent?.name ?? agentId, status: "sending…" };
    setOrderLog((log) => [entry, ...log].slice(0, 50));
    setOrderSending(true);
    try {
      const resp = await api(kind, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, agentId, ...(masterSecret ? { masterSecret } : {}), ...fields }),
      });
      const data = await resp.json();
      if (data.error) {
        updateOrder(entry.id, { status: `rejected: ${data.error}` });
        return false;
      }
      updateOrder(entry.id, { taskId: data.taskId, status: "queued" });
      pollOrder(entry.id, data.taskId);
      return true;
    } catch {
      updateOrder(entry.id, { status: "failed to send" });
      return false;
    } finally {
      setOrderSending(false);
    }
  }

  /** Paper orders fill (or rest) within the request — no task to follow. */
  async function placePaperOrder(kind: "trade" | "close", fields: Record<string, unknown>, summary: string): Promise<boolean> {
    const entry: OrderLogEntry = { id: Date.now(), summary: `Paper · ${summary}`, agentName: selectedAgent?.name ?? agentId, status: "sending…" };
    setOrderLog((log) => [entry, ...log].slice(0, 50));
    setOrderSending(true);
    try {
      const resp = await api(`paper/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, agentId, ...fields }),
      });
      const data = await resp.json();
      if (data.error) {
        updateOrder(entry.id, { status: `rejected: ${data.error}` });
        return false;
      }
      const filled = data.filled ? `filled ${formatSize(data.filled.sz)} @ ${formatPrice(data.filled.avgPx)}` : "";
      const resting = data.resting ? `resting ${formatSize(data.resting.sz)} @ ${formatPrice(data.resting.limitPx)}` : "";
      updateOrder(entry.id, { status: [filled, resting].filter(Boolean).join(", ") || "completed" });
      refreshAccount();
      loadHistory();
      return true;
    } catch {
      updateOrder(entry.id, { status: "failed to send" });
      return false;
    } finally {
      setOrderSending(false);
    }
  }

  /** Follows one order's task until the worker finishes it (or ~2 minutes pass). */
  async function pollOrder(id: number, orderTaskId: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const resp = await api(`status/${orderTaskId}`);
        const data = await resp.json();
        const status: string = data.status ?? data.error ?? "unknown";
        updateOrder(id, { status: status === "failed" && data.error ? `failed: ${data.error}` : status });
        if (TERMINAL_STATUSES.includes(status)) {
          if (status === "completed") {
            refreshAccount();
            loadHistory();
          }
          return;
        }
      } catch {
        // transient — keep polling
      }
    }
  }

  const openOrders = orderLog.filter((o) => !TERMINAL_STATUSES.includes(o.status) && !/^(rejected|failed|filled|resting)/.test(o.status));
  const lastOrder = orderLog[0];

  // ── Command line ("long ETH $25 5x sl 3 tp 8") ────────────────────────────
  const [orderText, setOrderText] = useState("");
  const parsedOrder: ParsedOrder | { error: string } | null = orderText.trim() ? parseOrder(orderText) : null;

  async function sendCommand(e: FormEvent) {
    e.preventDefault();
    if (!parsedOrder || "error" in parsedOrder || !agentId || !canSign) return;
    const { kind, ...fields } = parsedOrder;
    const ok = await placeOrder(
      kind,
      kind === "close" ? { ...fields, ...(wallet ? { wallet } : {}) } : fields,
      describeOrder(parsedOrder),
    );
    if (ok) setOrderText("");
  }

  // ── Positions / account ────────────────────────────────────────────────────
  const [positions, setPositions] = useState<Position[] | "loading" | "error" | null>(null);
  const [accountValue, setAccountValue] = useState<number | null>(null);
  const [marginUsed, setMarginUsed] = useState<number | null>(null);
  const [closingCoin, setClosingCoin] = useState<string | null>(null);

  const [paperAccount, setPaperAccount] = useState<PaperAccountView | null>(null);
  const [paperStartInput, setPaperStartInput] = useState("10000");
  const [paperBusy, setPaperBusy] = useState(false);

  async function refreshAccount() {
    if (paperMode) return refreshPaperAccount();
    if (!wallet) return;
    setPositions((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const [posResp, acctResp] = await Promise.all([
        api(`positions/${wallet}?network=${network}`),
        api(`account/${wallet}?network=${network}`),
      ]);
      const posData = await posResp.json();
      const acctData = await acctResp.json();
      if (posData.error) {
        setPositions("error");
        return;
      }
      setPositions(posData.positions ?? []);
      setAccountValue(acctData.accountValue ?? null);
      setMarginUsed(acctData.marginUsed ?? null);
    } catch {
      setPositions("error");
    }
  }

  async function refreshPaperAccount() {
    if (!agentId) return;
    setPositions((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const resp = await api(`paper/${agentId}`);
      const data = await resp.json();
      if (data.error) {
        setPositions("error");
        return;
      }
      setPaperAccount(data);
      setPositions((data.positions as PaperPositionRow[]).map((p) => ({
        coin: p.coin, size: p.szi, notionalUsd: p.notionalUsd, entryPrice: p.entryPx, unrealizedPnl: p.unrealizedPnl,
      })));
      setAccountValue(data.equity);
      setMarginUsed(data.marginUsed);
    } catch {
      setPositions("error");
    }
  }

  async function resetPaper() {
    const startBalance = Number(paperStartInput);
    if (!confirm(`Reset ${selectedAgent?.name ?? "this agent"}'s paper account to $${startBalance.toLocaleString()}? Open paper positions and orders are dropped; history is kept.`)) return;
    setPaperBusy(true);
    try {
      const resp = await api("paper/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, agentId, startBalance }),
      });
      const data = await resp.json();
      if (data.error) alert(data.error);
      refreshPaperAccount();
    } finally {
      setPaperBusy(false);
    }
  }

  async function cancelPaperOrder(orderId: string) {
    await api(`paper/orders/${orderId}/cancel`, { method: "POST" });
    refreshPaperAccount();
  }

  useEffect(() => {
    setPositions(null);
    setAccountValue(null);
    setMarginUsed(null);
    setPaperAccount(null);
    if (paperMode ? !agentId : !wallet) return;
    refreshAccount();
    const id = setInterval(refreshAccount, 10000);
    return () => clearInterval(id);
  }, [wallet, network, paperMode, agentId]);

  useEffect(() => {
    if (agentId) loadHistory();
  }, [paperMode]);

  async function closePosition(positionCoin: string) {
    setClosingCoin(positionCoin);
    try {
      await placeOrder("close", { coin: positionCoin, ...(wallet ? { wallet } : {}) }, `Close ${positionCoin}`);
    } finally {
      setClosingCoin(null);
    }
  }

  const positionList = Array.isArray(positions) ? positions : [];
  const coinPosition = positionList.find((p) => p.coin === coin);
  const totalUpnl = positionList.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // ── Risk config ────────────────────────────────────────────────────────────
  const [riskMaxPosition, setRiskMaxPosition] = useState("100");
  const [riskMaxDailyLoss, setRiskMaxDailyLoss] = useState("20");
  const [riskLeverage, setRiskLeverage] = useState("1");
  const [riskConfig, setRiskConfigState] = useState<RiskConfig | null>(null);
  const [riskStatus, setRiskStatus] = useState<string | null>(null);

  async function loadRiskConfig() {
    if (!agentId) return;
    const resp = await api(`risk-config/${agentId}`);
    const data = await resp.json();
    setRiskConfigState(data.config ?? null);
    if (data.config) {
      setRiskMaxPosition(String(data.config.maxPositionUsd));
      setRiskMaxDailyLoss(String(data.config.maxDailyLossUsd));
      setRiskLeverage(String(data.config.leverage));
      setLeverage(Math.max(1, Math.min(data.config.leverage, maxLeverage)));
    }
  }

  async function saveRiskConfig(e: FormEvent) {
    e.preventDefault();
    setRiskStatus("saving…");
    const resp = await api("risk-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId, agentId,
        leverage: Number(riskLeverage),
        maxPositionUsd: Number(riskMaxPosition),
        maxDailyLossUsd: Number(riskMaxDailyLoss),
      }),
    });
    const data = await resp.json();
    setRiskStatus(data.error ? `error: ${data.error}` : "saved");
    if (!data.error) loadRiskConfig();
  }

  const overLeverageCap = riskConfig != null && leverage > riskConfig.leverage;
  const overSizeCap = riskConfig != null && sizeNum > riskConfig.maxPositionUsd;

  // ── Referral ───────────────────────────────────────────────────────────────
  const [referral, setReferral] = useState<ReferralStats | "loading" | "error" | null>(null);
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralStatus, setReferralStatus] = useState<string | null>(null);

  async function loadReferral() {
    if (!agentId) return;
    setReferral("loading");
    try {
      const resp = await api(`referral/${agentId}?orgId=${encodeURIComponent(orgId)}`);
      const data = await resp.json();
      setReferral(data);
    } catch {
      setReferral("error");
    }
  }

  async function applyReferral(e: FormEvent) {
    e.preventDefault();
    setReferralStatus("applying…");
    const resp = await api("referral/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, referralCode: referralCodeInput }),
    });
    const data = await resp.json();
    setReferralStatus(data.error ? `error: ${data.error}` : "applied");
    if (!data.error) {
      setReferralCodeInput("");
      loadReferral();
    }
  }

  // ── History ─────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<{ trades: TradeRecord[]; stats: { totalPnl: number; winRate: number; count: number } } | "loading" | "error" | null>(null);

  async function loadHistory() {
    if (!agentId) return;
    setHistory((prev) => (prev && prev !== "loading" && prev !== "error" ? prev : "loading"));
    try {
      const resp = await api(paperMode ? `paper/history/${agentId}` : `history/${agentId}`);
      const data = await resp.json();
      if (data.error) {
        setHistory("error");
        return;
      }
      if (!paperMode) {
        setHistory(data);
        return;
      }
      const label: Record<PaperTrade["reason"], string | null> = {
        manual: null, strategy: null, limit: "limit fill", sl: "stop loss", tp: "take profit", liquidation: "liquidated",
      };
      setHistory({
        stats: data.stats,
        trades: (data.trades as PaperTrade[]).map((t) => {
          const closes = t.reduceOnly || t.realizedPnl !== 0;
          return {
            id: t.id, coin: t.coin, isBuy: t.isBuy, sizeUsd: Number(t.sizeUsd.toFixed(2)), fillPrice: t.px,
            realizedPnl: closes ? t.realizedPnl - t.fee : undefined,
            status: label[t.reason] ?? (closes ? "closed" : "opened"),
          };
        }),
      });
    } catch {
      setHistory("error");
    }
  }

  // ── Bots (strategies) ──────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState<Strategy[] | "loading" | "error" | null>(null);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [strategyType, setStrategyType] = useState<StrategyType>("ai");
  const [aiIntervalMin, setAiIntervalMin] = useState("60");
  const [aiMaxDrawdown, setAiMaxDrawdown] = useState("50");
  const [backtestInitial, setBacktestInitial] = useState<BotSpec | null>(null);
  const [backtestKey, setBacktestKey] = useState(0);
  const [decisionsOpen, setDecisionsOpen] = useState<string | null>(null);
  const [aiDecisions, setAiDecisions] = useState<Record<string, AiDecisionEntry[] | "loading" | "error">>({});
  const [strategyCoin, setStrategyCoin] = useState("ETH");
  const [strategySizeUsd, setStrategySizeUsd] = useState("15");
  const [dcaIntervalMin, setDcaIntervalMin] = useState("60");
  const [gridLower, setGridLower] = useState("");
  const [gridUpper, setGridUpper] = useState("");
  const [gridLevels, setGridLevels] = useState("5");
  const [sniperMode, setSniperMode] = useState<"new-listing" | "price-above" | "price-below">("new-listing");
  const [sniperTargetPrice, setSniperTargetPrice] = useState("");
  const [strategyStatus, setStrategyStatus] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [webhookBusyId, setWebhookBusyId] = useState<string | null>(null);
  const [trainGoal, setTrainGoal] = useState("");
  const [trainCoin, setTrainCoin] = useState("");
  const [trainSize, setTrainSize] = useState("25");
  const [trainEvery, setTrainEvery] = useState("1");
  const [trainStop, setTrainStop] = useState("10");
  const [trainBusy, setTrainBusy] = useState(false);

  async function loadStrategies() {
    if (!agentId) return;
    setStrategies((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const resp = await api(`strategy/${agentId}`);
      const data = await resp.json();
      if (data.error) {
        setStrategies("error");
        return;
      }
      setStrategies(data.strategies ?? []);
    } catch {
      setStrategies("error");
    }
  }

  function openNewBot() {
    setStrategyCoin(coin);
    setNewBotOpen(true);
    setBottomTab("bots");
  }

  /** Creates a bot — from the New bot form or a backtest's "Start this bot live". */
  async function createBot(spec: { type: StrategyType; coin: string; sizeUsd: number; params: Record<string, unknown> }): Promise<boolean> {
    // A paper bot trades the paper account, so it needs no wallet or signer.
    const signer = paperMode ? { wallet } : await ensureSigner();
    if (!signer) return false;
    setStrategyStatus("creating…");
    const resp = await api("strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, wallet: signer.wallet || wallet, ...spec, ...(paperMode ? { paper: true } : {}) }),
    });
    const data = await resp.json();
    setStrategyStatus(data.error ? `error: ${data.error}` : null);
    if (data.error) return false;
    loadStrategies();
    return true;
  }

  async function createStrategy(e: FormEvent) {
    e.preventDefault();
    const params =
      strategyType === "ai" ? { intervalMs: (paperMode ? Number(aiIntervalMin) : Math.max(15, Number(aiIntervalMin))) * 60_000, maxDrawdownPct: Number(aiMaxDrawdown), ...(leverage > 1 ? { leverage } : {}) } :
      strategyType === "dca" ? { intervalMs: Number(dcaIntervalMin) * 60_000 } :
      strategyType === "grid" ? { lowerPrice: Number(gridLower), upperPrice: Number(gridUpper), levels: Number(gridLevels) } :
      strategyType === "sniper" ? { mode: sniperMode, ...(sniperMode !== "new-listing" ? { targetPrice: Number(sniperTargetPrice) } : {}) } :
      {};
    const botCoin = strategyType === "sniper" && sniperMode === "new-listing" ? strategyCoin || "ANY" : strategyCoin;
    if (await createBot({ type: strategyType, coin: botCoin, sizeUsd: Number(strategySizeUsd), params })) setNewBotOpen(false);
  }

  async function startPaperTraining(e: FormEvent) {
    e.preventDefault();
    if (!agentId || !orgId) {
      setStrategyStatus("Pick an agent first.");
      return;
    }
    setPaperMode(true);
    setTrainBusy(true);
    setStrategyStatus("Starting paper training…");
    try {
      const resp = await api("paper/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          agentId,
          coin: (trainCoin || coin).trim().toUpperCase(),
          goal: trainGoal.trim(),
          sizeUsd: Number(trainSize),
          intervalMs: Number(trainEvery) * 60_000,
          maxDrawdownPct: Number(trainStop),
        }),
      });
      const data = await resp.json();
      if (data.error) {
        setStrategyStatus(`error: ${data.error}`);
        return;
      }
      const who = selectedAgent?.name ?? "The agent";
      setStrategyStatus(
        data.firstRound === "asked"
          ? `${who} has the first ${data.coin} question. The paper fill lands when its daemon answers.`
          : `${who} is training on ${data.coin} paper. The next round goes out within a minute.`,
      );
      setTrainGoal("");
      setBottomTab("bots");
      loadStrategies();
    } catch {
      setStrategyStatus("error: couldn't start paper training");
    } finally {
      setTrainBusy(false);
    }
  }

  async function startBotFromBacktest(spec: BotSpec): Promise<boolean> {
    const ok = await createBot(spec);
    if (ok) setStrategyStatus(`${paperMode ? "Paper " : ""}${BOT_KINDS[spec.type].label} bot started on ${spec.coin}.`);
    return ok;
  }

  /** Opens the Backtest tab prefilled with a bot's settings. */
  function backtestBot(s: Strategy) {
    if (s.type === "signal") return;
    setBacktestInitial({ type: s.type, coin: s.coin === "ANY" ? coin : s.coin, sizeUsd: s.sizeUsd, params: s.params ?? {} });
    setBacktestKey((k) => k + 1);
    setBottomTab("backtest");
  }

  async function loadAiDecisions(id: string) {
    setAiDecisions((prev) => ({ ...prev, [id]: Array.isArray(prev[id]) ? prev[id] : "loading" }));
    try {
      const resp = await api(`strategy/${id}/decisions`);
      const data = await resp.json();
      setAiDecisions((prev) => ({ ...prev, [id]: data.error ? "error" : data.decisions ?? [] }));
    } catch {
      setAiDecisions((prev) => ({ ...prev, [id]: "error" }));
    }
  }

  async function toggleStrategy(id: string, enabled: boolean) {
    await api(`strategy/${id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    loadStrategies();
  }

  /** A paper bot fires without a signer; a live one needs the instant wallet or the passphrase. */
  async function botSigner(id: string) {
    return strategyList.find((x) => x.id === id)?.paper ? true : !!(await ensureSigner());
  }

  async function fireSignal(id: string) {
    if (!(await botSigner(id))) return;
    setStrategyStatus(`firing ${id}…`);
    const resp = await api(`strategy/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(masterSecret ? { masterSecret } : {}),
    });
    const data = await resp.json();
    setStrategyStatus(data.error ? `error: ${data.error}` : `fired — task ${data.taskId}`);
  }

  async function issueWebhook(id: string) {
    setWebhookBusyId(id);
    try {
      const resp = await api(`strategy/${id}/webhook-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, agentId }),
      });
      const data = await resp.json();
      if (data.error) {
        setStrategyStatus(`error: ${data.error}`);
        return;
      }
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setWebhookUrls((prev) => ({ ...prev, [id]: `${origin}${data.path}` }));
    } finally {
      setWebhookBusyId(null);
    }
  }

  async function revokeWebhook(id: string) {
    setWebhookBusyId(id);
    try {
      await api(`strategy/${id}/webhook-token`, { method: "DELETE" });
      setWebhookUrls((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setWebhookBusyId(null);
    }
  }

  async function executePending(id: string) {
    if (!(await botSigner(id))) return;
    setExecutingId(id);
    setStrategyStatus(null);
    try {
      const resp = await api(`strategy/${id}/execute-pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(masterSecret ? { masterSecret } : {}),
      });
      const data = await resp.json();
      setStrategyStatus(data.error ? `error: ${data.error}` : `executed — task ${data.taskId}`);
      loadStrategies();
    } finally {
      setExecutingId(null);
    }
  }

  const strategyList = Array.isArray(strategies) ? strategies : [];
  const aiBotIds = strategyList.filter((s) => s.type === "ai").map((s) => s.id).join(",");

  // Keep each AI bot's latest decision fresh while the Bots tab is open.
  useEffect(() => {
    if (bottomTab !== "bots" || !aiBotIds) return;
    const refresh = () => aiBotIds.split(",").forEach(loadAiDecisions);
    refresh();
    const id = setInterval(() => {
      refresh();
      loadStrategies();
    }, 30000);
    return () => clearInterval(id);
  }, [bottomTab, aiBotIds]);
  const pendingStrategies = strategyList.filter((s) => s.pendingSignal);
  const runningBots = strategyList.filter((s) => s.enabled).length;

  // --- Connect your agent ---------------------------------------------------
  const [connection, setConnection] = useState<AgentConnection | "loading" | "error" | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadConnection() {
    if (!agentId) return;
    setConnection("loading");
    try {
      const resp = await api(`me?agentId=${encodeURIComponent(agentId)}`);
      if (!resp.ok) throw new Error();
      setConnection(await resp.json());
    } catch {
      setConnection("error");
    }
  }

  const connectSnippet = [
    `# 1. Mint a token for the agent (signed with its Ed25519 key or API key):`,
    `#    POST /api/v1/tokens  body: {"scopes":["mods:call"],"ttlSeconds":86400}`,
    `export AGENT_GUILD_URL=${typeof window !== "undefined" ? window.location.origin : "https://agent-guild.com"}`,
    `export AGENT_GUILD_TOKEN=agt_...        # or AGENT_GUILD_AGENT_ID=${agentId || "<agentId>"} + AGENT_GUILD_API_KEY=...`,
    ...(instant ? [] : [`export HL_MASTER_SECRET=...            # the wallet passphrase (not needed with instant trading)`]),
    ``,
    `# 2. Check it's plugged in, then let it trade:`,
    `node mods/hyperliquid-trading/agent/hl-agent.mjs me`,
    `node mods/hyperliquid-trading/agent/hl-agent.mjs call hyperliquid_trade '{"coin":"ETH","isBuy":true,"sizeUsd":10}'`,
    ...(instant ? [] : [`node mods/hyperliquid-trading/agent/hl-agent.mjs daemon   # fires DCA/grid/sniper signals`]),
    ``,
    `# AI Trader bots ask YOUR agent each round — answered on its own model by:`,
    `agent-guild daemon                      # polls ai/requests, runs your replyCommand, posts the decision`,
    `#   (or any runtime: GET ai/requests, then POST ai/requests/{id}/answer {"decision":"LONG","reasoning":"..."})`,
    ``,
    `# Or inside your agent: import { connect } from ".../hl-agent.mjs"`,
    `#   const hl = await connect(); llm tools = hl.tools; run picks with hl.call(name, input)`,
  ].join("\n");

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(connectSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the snippet is still selectable.
    }
  }

  function loadAgentData() {
    loadConnection();
    loadWalletStatus();
    loadRiskConfig();
    loadHistory();
    loadStrategies();
    loadReferral();
  }

  const bottomTabs: { id: BottomTab; label: string; count?: number }[] = [
    { id: "positions", label: "Positions", count: positionList.length },
    { id: "orders", label: "Orders", count: openOrders.length },
    { id: "bots", label: "Bots", count: strategyList.length },
    { id: "backtest", label: "Backtest" },
    { id: "history", label: "Trade history" },
    { id: "agent", label: "Agent & limits" },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-[1440px] space-y-2 p-2 sm:p-3 text-sm">
      {/* Account bar: who's trading, and with what. */}
      <div className={`${panelClass} flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2`}>
        <div className="flex items-center gap-2">
          <PulseDot tone={instant ? "live" : walletStatus?.hasWallet ? "idle" : "idle"} />
          <span className="text-xs font-semibold uppercase tracking-wide">Hyperliquid</span>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <label htmlFor="agentPick" className={`text-[11px] uppercase tracking-wide ${mutedClass}`}>Agent</label>
          {myAgents === "loading" ? (
            <span className={`text-xs ${mutedClass}`}>loading…</span>
          ) : myAgents === "error" ? (
            <button type="button" className="text-xs text-red-600 dark:text-red-400 underline" onClick={loadMyAgents}>Couldn&apos;t load — retry</button>
          ) : myAgents.length === 0 ? (
            <span className={`text-xs ${mutedClass}`}>No agents yet — create one first.</span>
          ) : (
            <select
              id="agentPick" name="agentPick" className={`${inputClass} w-auto max-w-56 py-1 text-xs`} value={agentId}
              onChange={(e) => selectAgent(myAgents.find((a) => a.agentId === e.target.value))}
            >
              <option value="">Pick an agent…</option>
              {myAgents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name}
                  {new Set(myAgents.map((x) => x.orgId)).size > 1 ? ` — ${a.orgName}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <Segmented
          label="Trading mode" size="xs" value={paperMode ? "paper" : "live"} onChange={(m) => setPaperMode(m === "paper")}
          options={[{ id: "live", label: "Live" }, { id: "paper", label: "Paper" }]}
        />
        {agentId && (
          <div className="flex items-center gap-2">
            {paperMode ? (
              <Badge tone="warning">Paper · mainnet prices</Badge>
            ) : instant ? (
              <Badge tone={network === "mainnet" ? "danger" : "success"}>Live · {network}</Badge>
            ) : isOwner && !usePassphrase ? (
              <Segmented
                label="Network" size="xs" value={instantNetwork} onChange={setInstantNetwork}
                options={[{ id: "testnet", label: "Testnet" }, { id: "mainnet", label: "Mainnet" }]}
              />
            ) : (
              <Badge tone="warning">Passphrase · {network}</Badge>
            )}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          {wallet && !paperMode && (
            <span className={`hidden md:inline text-[11px] ${monoClass} ${mutedClass}`} title={wallet}>
              {wallet.slice(0, 6)}…{wallet.slice(-4)}
            </span>
          )}
          <Stat label="Equity">{accountValue != null ? `$${accountValue.toFixed(2)}` : "—"}</Stat>
          <Stat label="Margin used">{marginUsed != null ? `$${marginUsed.toFixed(2)}` : "—"}</Stat>
          <Stat label="uPnL"><span className={positionList.length ? pnlClass(totalUpnl) : ""}>{positionList.length ? signed(totalUpnl) : "—"}</span></Stat>
        </div>
      </div>
      {instantStatus && <p className={`px-1 text-xs ${mutedClass}`}>{instantStatus}</p>}

      <form onSubmit={startPaperTraining} className={`${panelClass} space-y-2 px-3 py-2`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide">Train a goal</div>
            <p className={`text-[11px] ${mutedClass}`}>
              Write the idea. {selectedAgent?.name ?? "The agent"} paper-trades it on mainnet prices, with real fees, on virtual USDC. Fastest is 1 minute.
            </p>
          </div>
          <span className={`text-[11px] ${trainGoal.trim().length > 800 ? "text-red-600 dark:text-red-400" : mutedClass}`}>{trainGoal.trim().length}/800</span>
        </div>
        <label htmlFor="trainGoal" className="sr-only">Training goal</label>
        <textarea
          id="trainGoal" name="trainGoal" rows={2} maxLength={800}
          className={`${inputClass} min-h-16 w-full resize-y`}
          placeholder="Fade BTC when funding is extreme. Stay flat otherwise. One position at a time."
          value={trainGoal}
          onChange={(e) => setTrainGoal(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {TRAIN_IDEAS.map((idea) => (
            <button
              key={idea.label} type="button" className={secondaryButtonClass("px-2 py-1 text-xs")}
              onClick={() => { setTrainGoal(idea.goal); setTrainCoin(idea.coin); }}
            >
              {idea.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="trainCoin" className={labelClass}>Coin</label>
            <input
              id="trainCoin" name="trainCoin" className={`${inputClass} ${monoClass} w-24`}
              value={trainCoin || coin} onChange={(e) => setTrainCoin(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label htmlFor="trainSize" className={labelClass}>USD / order</label>
            <input
              id="trainSize" name="trainSize" type="number" min={MIN_ORDER_USD} className={`${inputClass} ${monoClass} w-24`}
              value={trainSize} onChange={(e) => setTrainSize(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="trainEvery" className={labelClass}>Decide every</label>
            <select id="trainEvery" name="trainEvery" className={`${inputClass} w-auto`} value={trainEvery} onChange={(e) => setTrainEvery(e.target.value)} title="1 minute is the fastest. The agent still has up to 3 minutes to answer each round.">
              <option value="1">1 minute</option>
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="60">1 hour</option>
              <option value="240">4 hours</option>
              <option value="1440">1 day</option>
            </select>
          </div>
          <div>
            <label htmlFor="trainStop" className={labelClass}>Stop at −%</label>
            <input
              id="trainStop" name="trainStop" type="number" min="1" max="95" className={`${inputClass} ${monoClass} w-20`}
              value={trainStop} onChange={(e) => setTrainStop(e.target.value)}
            />
          </div>
          <button
            type="submit" className={primaryButtonClass("py-1.5")}
            disabled={trainBusy || !agentId || trainGoal.trim().length < 8 || trainGoal.trim().length > 800}
          >
            {trainBusy ? "Starting…" : "Start paper training"}
          </button>
        </div>
        {strategyStatus && <p className={`text-xs ${mutedClass}`}>{strategyStatus}</p>}
      </form>

      {/* Market bar: the coin being traded, with a picker for every perp. */}
      <div className={`${panelClass} relative flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2`}>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-sm px-1 -mx-1 text-base font-semibold hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          aria-haspopup="dialog" aria-expanded={marketOpen}
          onClick={() => setMarketOpen((v) => !v)}
        >
          {coin}-PERP
          <svg viewBox="0 0 12 12" className="h-3 w-3 opacity-60" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <span className={`${monoClass} text-lg font-semibold ${coinInfo ? pnlClass(coinInfo.change24hPct) : ""}`}>
          {price != null ? formatPrice(price) : "—"}
        </span>
        <Stat label="Oracle">
          <span className="inline-flex items-center gap-1.5" title={priceFeed === "ws" ? "Live via Hyperliquid WebSocket" : "Polling (HyperEVM precompile)"}>
            <PulseDot tone={priceFeed === "ws" ? "live" : "idle"} />
            {oraclePx != null ? formatPrice(oraclePx) : "—"}
          </span>
        </Stat>
        <Stat label="Mark">{markPx != null ? formatPrice(markPx) : coinInfo ? formatPrice(coinInfo.markPx) : "—"}</Stat>
        {coinInfo && (
          <>
            <Stat label="24h change"><span className={pnlClass(coinInfo.change24hPct)}>{signed(coinInfo.change24hPct)}%</span></Stat>
            <Stat label="24h volume">{formatCompactUsd(coinInfo.volume24hUsd)}</Stat>
            <Stat label="Open interest">{formatCompactUsd(coinInfo.openInterestUsd)}</Stat>
            <Stat label="Funding / 1h"><span className={pnlClass(coinInfo.fundingRatePct)}>{coinInfo.fundingRatePct.toFixed(4)}%</span></Stat>
            <Stat label="Max leverage">{coinInfo.maxLeverage}x</Stat>
          </>
        )}

        {marketOpen && (
          <>
            <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMarketOpen(false)} />
            <div role="dialog" aria-label="Markets" className={`${panelClass} absolute left-2 top-full z-20 mt-1 w-[min(36rem,calc(100vw-2rem))] p-2 space-y-2 shadow-lg`}>
              <div className="flex items-center gap-2">
                <input
                  ref={marketSearchRef}
                  aria-label="Search coins"
                  className={`${inputClass} ${monoClass}`}
                  placeholder="Search coin"
                  value={marketQuery}
                  onChange={(e) => setMarketQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && filteredMarket[0]) pickCoin(filteredMarket[0].coin);
                  }}
                />
                <Segmented label="Sort markets" size="xs" value={marketSort} onChange={setMarketSort} options={MARKET_SORTS} />
              </div>
              {marketCoins === "loading" && <Spinner label="Loading markets…" />}
              {marketCoins === "error" && <ErrorNote message="Couldn't load markets." onRetry={loadMarket} />}
              {Array.isArray(marketCoins) && filteredMarket.length === 0 && (
                <p className={`text-sm ${mutedClass} p-2`}>No coins match &quot;{marketQuery}&quot;.</p>
              )}
              {filteredMarket.length > 0 && (
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-[hsl(var(--card))]">
                      <tr className={`text-left text-[10px] uppercase tracking-wide ${mutedClass}`}>
                        <th className="pb-1 font-medium">Market</th>
                        <th className="pb-1 font-medium text-right">Price</th>
                        <th className="pb-1 font-medium text-right">24h</th>
                        <th className="pb-1 font-medium text-right">Volume</th>
                        <th className="pb-1 font-medium text-right hidden sm:table-cell">Funding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMarket.map((c) => (
                        <tr
                          key={c.coin}
                          className={`cursor-pointer hover:bg-[hsl(var(--accent))]/60 ${c.coin === coin ? "bg-[hsl(var(--accent))]/40" : ""}`}
                          onClick={() => pickCoin(c.coin)}
                        >
                          <td className="py-1 font-medium">
                            {c.coin} <span className={`${mutedClass} font-normal`}>{c.maxLeverage}x</span>
                          </td>
                          <td className={`py-1 text-right ${monoClass}`}>{formatPrice(c.markPx)}</td>
                          <td className={`py-1 text-right ${monoClass} ${pnlClass(c.change24hPct)}`}>{signed(c.change24hPct)}%</td>
                          <td className={`py-1 text-right ${monoClass} ${mutedClass}`}>{formatCompactUsd(c.volume24hUsd)}</td>
                          <td className={`py-1 text-right ${monoClass} hidden sm:table-cell ${pnlClass(c.fundingRatePct)}`}>{c.fundingRatePct.toFixed(4)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Chart | Book | Ticket */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-12">
        <div className={`${panelClass} min-w-0 lg:col-span-6 xl:col-span-7 flex flex-col`}>
          <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-2 py-1.5">
            <Segmented
              label="Chart interval" size="xs" value={chartInterval} onChange={setChartInterval}
              options={INTERVALS.map((i) => ({ id: i, label: i }))}
            />
            <span className={`text-[11px] ${mutedClass}`}>{network}</span>
          </div>
          <div className="relative h-[280px] sm:h-[360px] lg:h-auto lg:min-h-[420px] lg:flex-1">
            {chartCandles === "loading" ? (
              <Spinner label="Loading chart…" />
            ) : chartCandles === "error" ? (
              <ErrorNote message="Couldn't load the chart." />
            ) : chartCandles.length === 0 ? (
              <p className={`p-4 text-sm ${mutedClass}`}>No trades for {coin} in this window.</p>
            ) : (
              <CandleChart candles={chartCandles} interval={chartInterval} entryPx={coinPosition?.entryPrice ?? null} />
            )}
          </div>
        </div>

        <div className={`${panelClass} order-3 lg:order-none lg:col-span-3 xl:col-span-2`}>
          <div className="border-b border-[hsl(var(--border))] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide">Order book</div>
          <div className="py-1">
            {book && (book.bids.length || book.asks.length) ? (
              <OrderBook bids={book.bids} asks={book.asks} onPick={pickBookPrice} />
            ) : (
              <Spinner label="Loading book…" />
            )}
          </div>
        </div>

        <form className={`${panelClass} order-2 lg:order-none lg:col-span-3 p-2 space-y-3`} onSubmit={submitTicket}>
          <div className="grid grid-cols-2 gap-1 rounded-sm bg-[hsl(var(--muted))] p-0.5" role="radiogroup" aria-label="Side">
            {[true, false].map((buy) => (
              <button
                key={String(buy)}
                type="button"
                role="radio"
                aria-checked={isBuy === buy}
                className={
                  "rounded-sm py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] " +
                  (isBuy === buy
                    ? buy ? "bg-green-600 text-white" : "bg-red-600 text-white"
                    : `${mutedClass} hover:text-[hsl(var(--foreground))]`)
                }
                onClick={() => setIsBuy(buy)}
              >
                {buy ? "Buy / Long" : "Sell / Short"}
              </button>
            ))}
          </div>

          <Segmented
            label="Order type" value={orderType} onChange={setOrderType}
            options={[{ id: "market", label: "Market" }, { id: "limit", label: "Limit" }]}
          />

          {orderType === "limit" && (
            <div>
              <label htmlFor="limitPrice" className={labelClass}>Price (USD)</label>
              <div className="flex gap-1">
                <input
                  id="limitPrice" name="limitPrice" type="number" min="0" step="any" inputMode="decimal"
                  className={`${inputClass} ${monoClass}`} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder={price != null ? String(price) : ""} required
                />
                <button type="button" className={secondaryButtonClass("px-2 text-xs")} onClick={() => price != null && setLimitPrice(String(price))}>
                  Mid
                </button>
              </div>
            </div>
          )}

          <div>
            <label htmlFor="sizeUsd" className={labelClass}>Size (USD)</label>
            <input
              id="sizeUsd" name="sizeUsd" type="number" min="0" step="any" inputMode="decimal"
              className={`${inputClass} ${monoClass}`} value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} required
            />
            <div className="mt-1 flex gap-1">
              {SIZE_PRESETS.map((n) => (
                <button
                  key={n} type="button"
                  className={`flex-1 rounded-sm border border-[hsl(var(--border))] py-0.5 text-[11px] ${monoClass} hover:bg-[hsl(var(--accent))] ${sizeNum === n ? "border-[hsl(var(--primary))]" : ""}`}
                  onClick={() => setSizeUsd(String(n))}
                >
                  ${n}
                </button>
              ))}
              {riskConfig && (
                <button
                  type="button"
                  className={`flex-1 rounded-sm border border-[hsl(var(--border))] py-0.5 text-[11px] hover:bg-[hsl(var(--accent))]`}
                  onClick={() => setSizeUsd(String(riskConfig.maxPositionUsd))}
                >
                  Max
                </button>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="leverage" className={labelClass}>Leverage</label>
              <span className={`${monoClass} text-xs font-semibold`}>{leverage}x</span>
            </div>
            <input
              id="leverage" name="leverage" type="range" min={1} max={maxLeverage} step={1} value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full accent-[hsl(var(--primary))]"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox" checked={tpslOn} onChange={(e) => setTpslOn(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-[hsl(var(--input))]"
              />
              Take profit / Stop loss
            </label>
            {tpslOn && (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <div>
                  <label htmlFor="takeProfitPct" className={labelClass}>TP %</label>
                  <input id="takeProfitPct" name="takeProfitPct" type="number" min="0" step="any" className={`${inputClass} ${monoClass}`} value={takeProfitPct} onChange={(e) => setTakeProfitPct(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="stopLossPct" className={labelClass}>SL %</label>
                  <input id="stopLossPct" name="stopLossPct" type="number" min="0" step="any" className={`${inputClass} ${monoClass}`} value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {needsPassphraseInput && agentId && (
            <div>
              <label htmlFor="masterSecret" className={labelClass}>Wallet passphrase</label>
              <input
                id="masterSecret" name="masterSecret" type="password" className={inputClass}
                placeholder="Decrypts this agent's wallet — never stored" value={masterSecret}
                onChange={(e) => setMasterSecret(e.target.value)} autoComplete="off"
              />
            </div>
          )}

          <dl className={`space-y-0.5 text-[11px] ${monoClass}`}>
            <div className="flex justify-between"><dt className={mutedClass}>Est. size</dt><dd>{execPrice && sizeNum ? `${formatSize(sizeNum / execPrice)} ${coin}` : "—"}</dd></div>
            <div className="flex justify-between"><dt className={mutedClass}>Margin</dt><dd>{sizeNum ? `$${(sizeNum / leverage).toFixed(2)}` : "—"}</dd></div>
            {riskConfig && (
              <div className="flex justify-between">
                <dt className={mutedClass}>Agent limits</dt>
                <dd className={overLeverageCap || overSizeCap ? "text-amber-600 dark:text-amber-400" : ""}>
                  ${riskConfig.maxPositionUsd} · {riskConfig.leverage}x
                </dd>
              </div>
            )}
          </dl>

          <button
            type="submit"
            className={
              "w-full rounded-md py-2.5 text-sm font-semibold text-white transition-colors disabled:pointer-events-none disabled:opacity-50 " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))] " +
              (isBuy ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700")
            }
            disabled={!ticketReady || orderSending || instantBusy}
          >
            {orderSending || instantBusy ? "Sending…" : !agentId ? "Pick an agent" : `${paperMode ? "Paper " : ""}${isBuy ? "Buy / Long" : "Sell / Short"} ${coin}`}
          </button>

          <p className="min-h-4 text-[11px]" aria-live="polite">
            {!agentId ? (
              <span className={mutedClass}>Pick an agent in the top bar — it fills orders from its own wallet.</span>
            ) : !canSign ? (
              <span className={mutedClass}>Enter the passphrase to trade, or have the org owner place an order.</span>
            ) : belowMinimum ? (
              <span className="text-amber-600 dark:text-amber-400">Hyperliquid&apos;s minimum order is ${MIN_ORDER_USD}.</span>
            ) : overLeverageCap ? (
              <span className="text-amber-600 dark:text-amber-400">Above this agent&apos;s {riskConfig!.leverage}x limit — it will be rejected.</span>
            ) : overSizeCap ? (
              <span className="text-amber-600 dark:text-amber-400">Above this agent&apos;s ${riskConfig!.maxPositionUsd} position limit — it will be rejected.</span>
            ) : lastOrder ? (
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">{lastOrder.summary}</span>
                <Badge tone={orderTone(lastOrder.status)}>{lastOrder.status.length > 28 ? `${lastOrder.status.slice(0, 28)}…` : lastOrder.status}</Badge>
              </span>
            ) : paperMode ? (
              <span className={mutedClass}>Paper: fills against the real mainnet book with real fees — no real money moves.</span>
            ) : !instant && isOwner ? (
              <span className={mutedClass}>Your first order switches {selectedAgent?.name ?? "the agent"} to its own wallet — no passphrase.</span>
            ) : null}
          </p>
        </form>
      </div>

      {/* Command line — plain-words orders. */}
      {agentId && (
        <form className={`${panelClass} flex items-center gap-2 px-2 py-1.5`} onSubmit={sendCommand}>
          <span className={`${monoClass} text-xs ${mutedClass}`} aria-hidden="true">&gt;</span>
          <input
            aria-label={`Order for ${selectedAgent?.name ?? "this agent"} in plain words`}
            aria-describedby="commandPreview"
            className={`flex-1 bg-transparent py-1 text-sm ${monoClass} placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none`}
            placeholder="long ETH $25 5x sl 3 tp 8 · short SOL 50 @ 140 · close BTC"
            value={orderText} onChange={(e) => setOrderText(e.target.value)} autoComplete="off"
          />
          <span id="commandPreview" className={`hidden sm:inline text-[11px] ${mutedClass} truncate max-w-[40%]`} aria-live="polite">
            {parsedOrder ? ("error" in parsedOrder ? parsedOrder.error : `${describeOrder(parsedOrder)} on ${paperMode ? "paper" : network}`) : ""}
          </span>
          <button type="submit" className={secondaryButtonClass("py-1 text-xs")} disabled={orderSending || !parsedOrder || "error" in parsedOrder || !canSign}>
            Send
          </button>
        </form>
      )}

      {/* Bottom: positions, orders, bots, history, agent settings. */}
      <div className={panelClass}>
        <div role="tablist" aria-label="Account" className="flex items-center gap-1 overflow-x-auto border-b border-[hsl(var(--border))] px-1">
          {bottomTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={bottomTab === tab.id}
              className={
                "px-2.5 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))] " +
                (bottomTab === tab.id
                  ? "border-[hsl(var(--primary))] text-[hsl(var(--foreground))]"
                  : `border-transparent ${mutedClass} hover:text-[hsl(var(--foreground))]`)
              }
              onClick={() => setBottomTab(tab.id)}
            >
              {tab.label}
              {tab.count ? <span className={`ml-1 ${monoClass} ${mutedClass}`}>({tab.count})</span> : null}
              {tab.id === "bots" && pendingStrategies.length > 0 && !instant && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" aria-label="pending signals" />}
            </button>
          ))}
          <div className="ml-auto pr-1">
            {bottomTab === "bots" && agentId && (
              <button type="button" className={primaryButtonClass("px-3 py-1 text-xs")} onClick={openNewBot}>+ New bot</button>
            )}
          </div>
        </div>

        <div className="p-2">
          {!agentId && bottomTab !== "agent" ? (
            <p className={`p-3 text-sm ${mutedClass}`}>Pick an agent in the top bar to see its account.</p>
          ) : bottomTab === "positions" ? (
            <div className="space-y-2">
            {paperMode && paperAccount && (
              <div className="flex flex-wrap items-end gap-x-5 gap-y-2 rounded-sm bg-[hsl(var(--muted))]/50 px-2 py-1.5">
                <Stat label="Paper balance">${paperAccount.balance.toFixed(2)}</Stat>
                <Stat label="Started with">${paperAccount.startBalance.toLocaleString()}</Stat>
                <Stat label="Return">
                  <span className={pnlClass(paperAccount.equity - paperAccount.startBalance)}>
                    {signed(((paperAccount.equity - paperAccount.startBalance) / paperAccount.startBalance) * 100)}%
                  </span>
                </Stat>
                <Stat label="Today"><span className={pnlClass(paperAccount.dailyPnl)}>{signed(paperAccount.dailyPnl)}</span></Stat>
                <Stat label="Available">${paperAccount.available.toFixed(2)}</Stat>
                <div className="ml-auto flex items-end gap-1.5">
                  <div>
                    <label htmlFor="paperStart" className={labelClass}>Reset to $</label>
                    <input
                      id="paperStart" name="paperStart" type="number" min="100" step="100" className={`${inputClass} ${monoClass} w-28 py-1 text-xs`}
                      value={paperStartInput} onChange={(e) => setPaperStartInput(e.target.value)}
                    />
                  </div>
                  <button type="button" className={secondaryButtonClass("px-2 py-1 text-xs")} onClick={resetPaper} disabled={paperBusy || !(Number(paperStartInput) >= 100)}>
                    {paperBusy ? "Resetting…" : "Reset"}
                  </button>
                </div>
              </div>
            )}
            {positions === "loading" ? <Spinner label="Loading positions…" /> :
            positions === "error" ? <ErrorNote message="Couldn't load positions." onRetry={refreshAccount} /> :
            !wallet && !paperMode ? <p className={`p-3 text-sm ${mutedClass}`}>No wallet yet — place an order and the agent&apos;s wallet is set up for you.</p> :
            positionList.length === 0 ? <p className={`p-3 text-sm ${mutedClass}`}>{paperMode ? "No open paper positions — place an order above to start." : "No open positions."}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className={`text-left text-[10px] uppercase tracking-wide ${mutedClass}`}>
                      <th className="px-2 pb-1 font-medium">Market</th>
                      <th className="px-2 pb-1 font-medium text-right">Size</th>
                      <th className="px-2 pb-1 font-medium text-right">Value</th>
                      <th className="px-2 pb-1 font-medium text-right">Entry</th>
                      <th className="px-2 pb-1 font-medium text-right">Mark</th>
                      <th className="px-2 pb-1 font-medium text-right">PnL (%)</th>
                      <th className="px-2 pb-1"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {positionList.map((p) => {
                      const mark = markOf(p.coin);
                      const cost = Math.abs(p.size) * p.entryPrice;
                      return (
                        <tr key={p.coin} className="hover:bg-[hsl(var(--accent))]/40">
                          <td className="px-2 py-1.5">
                            <button type="button" className="font-semibold hover:underline" onClick={() => pickCoin(p.coin)}>{p.coin}</button>{" "}
                            <Badge tone={p.size > 0 ? "success" : "danger"}>{p.size > 0 ? "long" : "short"}</Badge>
                          </td>
                          <td className={`px-2 py-1.5 text-right ${monoClass}`}>{formatSize(Math.abs(p.size))}</td>
                          <td className={`px-2 py-1.5 text-right ${monoClass}`}>${Math.abs(p.notionalUsd).toFixed(2)}</td>
                          <td className={`px-2 py-1.5 text-right ${monoClass} ${mutedClass}`}>{formatPrice(p.entryPrice)}</td>
                          <td className={`px-2 py-1.5 text-right ${monoClass}`}>{mark != null ? formatPrice(mark) : "—"}</td>
                          <td className={`px-2 py-1.5 text-right ${monoClass} ${pnlClass(p.unrealizedPnl)}`}>
                            {signed(p.unrealizedPnl)} {cost > 0 && <span className="opacity-75">({signed((p.unrealizedPnl / cost) * 100)}%)</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              type="button"
                              className={secondaryButtonClass("px-2 py-0.5 text-xs")}
                              onClick={() => closePosition(p.coin)}
                              disabled={closingCoin === p.coin || !canSign}
                            >
                              {closingCoin === p.coin ? "Closing…" : "Market close"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            </div>
          ) : bottomTab === "orders" ? (
            <div className="space-y-2">
            {paperMode && paperAccount && paperAccount.orders.length > 0 && (
              <div>
                <div className={`px-2 pb-1 text-[10px] font-medium uppercase tracking-wide ${mutedClass}`}>Resting paper orders</div>
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {paperAccount.orders.map((o) => (
                      <tr key={o.orderId}>
                        <td className="px-2 py-1.5">
                          <span className="font-semibold">{o.coin}</span>{" "}
                          <Badge tone={o.isBuy ? "success" : "danger"}>{o.isBuy ? "buy" : "sell"}</Badge>
                          {o.reduceOnly && <span className={`ml-1 ${mutedClass}`}>reduce-only</span>}
                        </td>
                        <td className={`px-2 py-1.5 text-right ${monoClass}`}>{formatSize(o.sz)} @ {formatPrice(o.limitPx)}</td>
                        <td className={`px-2 py-1.5 text-right ${monoClass} ${mutedClass}`}>{o.leverage}x</td>
                        <td className="px-2 py-1.5 text-right">
                          <button type="button" className={secondaryButtonClass("px-2 py-0.5 text-xs")} onClick={() => cancelPaperOrder(o.orderId)}>Cancel</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {orderLog.length === 0 ? (
              <p className={`p-3 text-sm ${mutedClass}`}>Orders you send from this screen show up here while they fill.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className={`text-left text-[10px] uppercase tracking-wide ${mutedClass}`}>
                    <th className="px-2 pb-1 font-medium">Time</th>
                    <th className="px-2 pb-1 font-medium">Order</th>
                    <th className="px-2 pb-1 font-medium hidden sm:table-cell">Agent</th>
                    <th className="px-2 pb-1 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {orderLog.map((o) => (
                    <tr key={o.id}>
                      <td className={`px-2 py-1.5 ${monoClass} ${mutedClass}`}>{new Date(o.id).toLocaleTimeString()}</td>
                      <td className="px-2 py-1.5">{o.summary}</td>
                      <td className={`px-2 py-1.5 hidden sm:table-cell ${mutedClass}`}>{o.agentName}</td>
                      <td className="px-2 py-1.5 text-right" title={o.status}>
                        <Badge tone={orderTone(o.status)}>{o.status.length > 40 ? `${o.status.slice(0, 40)}…` : o.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </div>
          ) : bottomTab === "bots" ? (
            <div className="space-y-2">
              <p className={`px-1 text-xs ${mutedClass}`}>
                {paperMode
                  ? "New bots start on the paper account and trade on their own — switch to Live for real-money bots."
                  : instant
                  ? `${runningBots} running — bots trade on their own from ${selectedAgent?.name ?? "the agent"}'s wallet, within its limits.`
                  : "Bots spot their conditions automatically; with a passphrase wallet each fire waits for you to confirm it."}
              </p>
              {strategyStatus && <p className={`px-1 text-xs ${mutedClass}`}>{strategyStatus}</p>}
              {strategies === "loading" && <Spinner label="Loading bots…" />}
              {strategies === "error" && <ErrorNote message="Couldn't load bots." onRetry={loadStrategies} />}
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {strategyList.map((s) => (
                  <div key={s.id} className={`rounded-sm border p-2.5 space-y-2 ${s.enabled ? "border-[hsl(var(--border))]" : "border-dashed border-[hsl(var(--border))] opacity-75"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                          <PulseDot tone={s.enabled ? "live" : "idle"} />
                          {BOT_KINDS[s.type].label} · {s.coin}
                          {s.paper && <Badge tone="warning">paper</Badge>}
                        </div>
                        <p className={`text-[11px] ${mutedClass}`}>{BOT_KINDS[s.type].blurb}</p>
                        {s.type === "ai" && typeof s.params?.goal === "string" && s.params.goal && (
                          <p className={`mt-1 line-clamp-3 text-[11px] ${mutedClass}`} title={s.params.goal}>Goal: {s.params.goal}</p>
                        )}
                      </div>
                      {s.type === "ai" && s.params?.eliminated ? (
                        <Badge tone="danger">eliminated</Badge>
                      ) : (
                        <Badge tone={s.pendingSignal ? "warning" : s.enabled ? "success" : "neutral"}>
                          {s.pendingSignal ? "pending" : s.enabled ? "running" : "stopped"}
                        </Badge>
                      )}
                    </div>
                    <div className={`text-xs ${monoClass}`}>
                      ${s.sizeUsd} per order
                      {s.type === "ai" && s.params && (
                        <span className={mutedClass}>
                          {" "}· every {formatEvery(Number(s.params.intervalMs))} · stop at −{String(s.params.maxDrawdownPct)}%
                        </span>
                      )}
                    </div>
                    {s.type === "ai" && (() => {
                      const log = aiDecisions[s.id];
                      const latest = Array.isArray(log) ? log[0] : undefined;
                      if (s.params?.openRequestId) {
                        return (
                          <p className={`flex items-center gap-1.5 text-[11px] ${mutedClass}`}>
                            <PulseDot tone="live" /> Waiting for {selectedAgent?.name ?? "the agent"} to decide…
                          </p>
                        );
                      }
                      return latest ? (
                        <div className="rounded-sm bg-[hsl(var(--muted))]/50 p-1.5 text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <span className={`font-semibold ${latest.decision === "LONG" ? "text-green-600 dark:text-green-400" : latest.decision === "SHORT" ? "text-red-600 dark:text-red-400" : ""}`}>
                              {latest.decision ?? latest.action}
                            </span>
                            {latest.decision && <span className={mutedClass}>→ {latest.action}</span>}
                            <span className={`ml-auto ${mutedClass}`}>{latest.createdAt ? new Date(latest.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                          </div>
                          {latest.error ? (
                            <p className="text-amber-700 dark:text-amber-400">{latest.error}</p>
                          ) : latest.reasoning ? (
                            <p className={`line-clamp-3 ${mutedClass}`}>{latest.reasoning}</p>
                          ) : null}
                        </div>
                      ) : (
                        <p className={`text-[11px] ${mutedClass}`}>
                          {s.enabled ? "First decision on the next tick (within a minute)." : "No decisions yet."}
                        </p>
                      );
                    })()}
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className={s.enabled ? secondaryButtonClass("px-2 py-1 text-xs") : primaryButtonClass("px-2 py-1 text-xs")}
                        onClick={() => toggleStrategy(s.id, !s.enabled)}
                      >
                        {s.enabled ? "Stop" : "Start"}
                      </button>
                      {s.pendingSignal && (
                        <button type="button" className={primaryButtonClass("px-2 py-1 text-xs")} onClick={() => executePending(s.id)} disabled={!(canSign || s.paper) || executingId === s.id}>
                          {executingId === s.id ? "Running…" : "Run now"}
                        </button>
                      )}
                      {s.type === "signal" && (
                        <button type="button" className={secondaryButtonClass("px-2 py-1 text-xs")} onClick={() => fireSignal(s.id)} disabled={!(canSign || s.paper)}>
                          Fire
                        </button>
                      )}
                      {s.type === "ai" && (
                        <button
                          type="button" className={secondaryButtonClass("px-2 py-1 text-xs")} aria-expanded={decisionsOpen === s.id}
                          onClick={() => {
                            setDecisionsOpen((cur) => (cur === s.id ? null : s.id));
                            loadAiDecisions(s.id);
                          }}
                        >
                          Decisions
                        </button>
                      )}
                      {s.type !== "signal" && (
                        <button type="button" className={secondaryButtonClass("px-2 py-1 text-xs")} onClick={() => backtestBot(s)}>
                          Backtest
                        </button>
                      )}
                      {s.type === "signal" && (webhookUrls[s.id] || s.webhookToken ? (
                        <button
                          type="button"
                          className={secondaryButtonClass("px-2 py-1 text-xs text-red-600 dark:text-red-400")}
                          onClick={() => revokeWebhook(s.id)} disabled={webhookBusyId === s.id}
                        >
                          Revoke webhook
                        </button>
                      ) : (
                        <button type="button" className={secondaryButtonClass("px-2 py-1 text-xs")} onClick={() => issueWebhook(s.id)} disabled={webhookBusyId === s.id}>
                          {webhookBusyId === s.id ? "Generating…" : "Webhook"}
                        </button>
                      ))}
                    </div>
                    {s.type === "signal" && webhookUrls[s.id] && (
                      <div className="space-y-1">
                        <code className={`block truncate text-[11px] ${monoClass} ${mutedClass}`} title={webhookUrls[s.id]}>{webhookUrls[s.id]}</code>
                        {!instant && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-500">
                            With a passphrase wallet, TradingView&apos;s alert body must include the passphrase in plain text —
                            only use one you&apos;re comfortable exposing to that third party.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!newBotOpen && (
                  <button
                    type="button"
                    className={`flex min-h-28 flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-[hsl(var(--border))] text-sm ${mutedClass} hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]/40`}
                    onClick={openNewBot}
                  >
                    <span className="text-lg leading-none">+</span>
                    New bot
                  </button>
                )}
              </div>

              {decisionsOpen && (() => {
                const bot = strategyList.find((x) => x.id === decisionsOpen);
                const log = aiDecisions[decisionsOpen];
                return (
                  <div className="rounded-sm border border-[hsl(var(--border))]">
                    <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-2.5 py-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide">
                        Decisions · {bot ? `${BOT_KINDS[bot.type].label} ${bot.coin}` : ""}
                      </span>
                      <div className="flex gap-3">
                        <button type="button" className={`text-xs ${mutedClass} hover:underline`} onClick={() => loadAiDecisions(decisionsOpen)}>Refresh</button>
                        <button type="button" className={`text-xs ${mutedClass} hover:underline`} onClick={() => setDecisionsOpen(null)}>Close</button>
                      </div>
                    </div>
                    {log === "loading" || log === undefined ? <Spinner label="Loading decisions…" /> :
                      log === "error" ? <ErrorNote message="Couldn't load decisions." onRetry={() => loadAiDecisions(decisionsOpen)} /> :
                      log.length === 0 ? <p className={`p-3 text-sm ${mutedClass}`}>No decisions yet.</p> : (
                        <ul className="max-h-96 divide-y divide-[hsl(var(--border))] overflow-y-auto text-xs">
                          {log.map((d) => (
                            <li key={d.id} className="px-2.5 py-2">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className={`${monoClass} ${mutedClass}`}>{d.createdAt ? new Date(d.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                                {d.decision && (
                                  <span className={`font-semibold ${d.decision === "LONG" ? "text-green-600 dark:text-green-400" : d.decision === "SHORT" ? "text-red-600 dark:text-red-400" : ""}`}>{d.decision}</span>
                                )}
                                <span className={mutedClass}>→ {d.action}</span>
                                {d.price != null && <span className={monoClass}>@ {formatPrice(d.price)}</span>}
                                {d.equity != null && <span className={`${monoClass} ${mutedClass}`}>equity ${d.equity.toFixed(2)}</span>}
                                {d.taskId && <Badge tone="success">order sent</Badge>}
                                {d.model && <span className={`ml-auto ${mutedClass}`}>{d.model === "agent" ? selectedAgent?.name ?? "agent" : d.model}</span>}
                              </div>
                              {d.error && <p className="mt-0.5 text-amber-700 dark:text-amber-400">{d.error}</p>}
                              {d.reasoning && <p className={`mt-0.5 ${mutedClass}`}>{d.reasoning}</p>}
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                );
              })()}

              {newBotOpen && (
                <form className="rounded-sm border border-[hsl(var(--border))] p-2.5 space-y-2" onSubmit={createStrategy}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide">New bot</span>
                    <button type="button" className={`text-xs ${mutedClass} hover:underline`} onClick={() => setNewBotOpen(false)}>Cancel</button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-3 xl:grid-cols-5" role="radiogroup" aria-label="Bot type">
                    {(Object.keys(BOT_KINDS) as StrategyType[]).map((t) => (
                      <button
                        key={t} type="button" role="radio" aria-checked={strategyType === t}
                        className={`rounded-sm border p-2 text-left transition-colors ${strategyType === t ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/5" : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]/40"}`}
                        onClick={() => setStrategyType(t)}
                      >
                        <div className="text-sm font-semibold">{BOT_KINDS[t].label}</div>
                        <div className={`text-[11px] ${mutedClass}`}>{BOT_KINDS[t].blurb}</div>
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <label htmlFor="strategyCoin" className={labelClass}>Coin</label>
                      <input
                        id="strategyCoin" name="strategyCoin" className={`${inputClass} ${monoClass}`} value={strategyCoin}
                        onChange={(e) => setStrategyCoin(e.target.value.toUpperCase())}
                        placeholder={strategyType === "sniper" && sniperMode === "new-listing" ? "ANY" : undefined}
                        required={!(strategyType === "sniper" && sniperMode === "new-listing")}
                      />
                    </div>
                    <div>
                      <label htmlFor="strategySizeUsd" className={labelClass}>USD per order</label>
                      <input id="strategySizeUsd" name="strategySizeUsd" type="number" min={MIN_ORDER_USD} className={`${inputClass} ${monoClass}`} value={strategySizeUsd} onChange={(e) => setStrategySizeUsd(e.target.value)} required />
                    </div>
                    {strategyType === "ai" && (
                      <>
                        <div>
                          <label htmlFor="aiInterval" className={labelClass}>Decide every</label>
                          <select id="aiInterval" name="aiInterval" className={inputClass} value={paperMode ? aiIntervalMin : String(Math.max(15, Number(aiIntervalMin) || 15))} onChange={(e) => setAiIntervalMin(e.target.value)}>
                            {paperMode && <option value="1">1 minute</option>}
                            {paperMode && <option value="5">5 minutes</option>}
                            <option value="15">15 minutes</option>
                            <option value="60">1 hour</option>
                            <option value="240">4 hours</option>
                            <option value="1440">1 day</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="aiMaxDrawdown" className={labelClass}>Stop at −%</label>
                          <input id="aiMaxDrawdown" name="aiMaxDrawdown" type="number" min="1" max="95" className={`${inputClass} ${monoClass}`} value={aiMaxDrawdown} onChange={(e) => setAiMaxDrawdown(e.target.value)} required />
                        </div>
                      </>
                    )}
                    {strategyType === "dca" && (
                      <div>
                        <label htmlFor="dcaInterval" className={labelClass}>Every (minutes)</label>
                        <input id="dcaInterval" name="dcaInterval" type="number" min="1" className={`${inputClass} ${monoClass}`} value={dcaIntervalMin} onChange={(e) => setDcaIntervalMin(e.target.value)} required />
                      </div>
                    )}
                    {strategyType === "grid" && (
                      <>
                        <div>
                          <label htmlFor="gridLower" className={labelClass}>Lower price</label>
                          <input id="gridLower" name="gridLower" type="number" min="0" step="any" className={`${inputClass} ${monoClass}`} value={gridLower} onChange={(e) => setGridLower(e.target.value)} required />
                        </div>
                        <div>
                          <label htmlFor="gridUpper" className={labelClass}>Upper price</label>
                          <input id="gridUpper" name="gridUpper" type="number" min="0" step="any" className={`${inputClass} ${monoClass}`} value={gridUpper} onChange={(e) => setGridUpper(e.target.value)} required />
                        </div>
                        <div>
                          <label htmlFor="gridLevels" className={labelClass}>Levels</label>
                          <input id="gridLevels" name="gridLevels" type="number" min="1" className={`${inputClass} ${monoClass}`} value={gridLevels} onChange={(e) => setGridLevels(e.target.value)} required />
                        </div>
                      </>
                    )}
                    {strategyType === "sniper" && (
                      <>
                        <div>
                          <label htmlFor="sniperMode" className={labelClass}>Trigger</label>
                          <select id="sniperMode" name="sniperMode" className={inputClass} value={sniperMode} onChange={(e) => setSniperMode(e.target.value as typeof sniperMode)}>
                            <option value="new-listing">New listing</option>
                            <option value="price-above">Price rises above</option>
                            <option value="price-below">Price falls below</option>
                          </select>
                        </div>
                        {sniperMode !== "new-listing" && (
                          <div>
                            <label htmlFor="sniperTargetPrice" className={labelClass}>Target price</label>
                            <input id="sniperTargetPrice" name="sniperTargetPrice" type="number" min="0" step="any" className={`${inputClass} ${monoClass}`} value={sniperTargetPrice} onChange={(e) => setSniperTargetPrice(e.target.value)} required />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {strategyType === "grid" && price != null && (
                    <p className={`text-[11px] ${mutedClass}`}>
                      {strategyCoin === coin ? `${coin} is at ${formatPrice(price)}. ` : ""}
                      <button
                        type="button" className="underline"
                        onClick={() => {
                          if (strategyCoin !== coin) return;
                          setGridLower(String(+(price * 0.95).toPrecision(5)));
                          setGridUpper(String(+(price * 1.05).toPrecision(5)));
                        }}
                        disabled={strategyCoin !== coin}
                      >
                        Use ±5% around the current price
                      </button>
                    </p>
                  )}
                  {strategyType === "sniper" && sniperMode === "new-listing" && (
                    <p className={`text-[11px] ${mutedClass}`}>Fires once, the moment a new Hyperliquid perp lists, then stops.</p>
                  )}
                  {strategyType === "ai" && (
                    <p className={`text-[11px] ${mutedClass}`}>
                      Each round {selectedAgent?.name ?? "your agent"} gets the last 72 bars, RSI, moving averages, bid/ask, funding and
                      open interest — never your balance — and answers LONG, SHORT, CLOSE or NOTHING with its own model, through its
                      daemon (<span className={monoClass}>agent-guild daemon</span>). No outside inference. Orders use the leverage on
                      the ticket ({leverage}x) and this agent&apos;s risk limits. It stops for good if equity falls {aiMaxDrawdown}% below
                      where it started. Try it in Backtest first.
                    </p>
                  )}
                  <button type="submit" className={primaryButtonClass("py-1.5")} disabled={!agentId || instantBusy}>
                    Start {paperMode ? "paper " : ""}{BOT_KINDS[strategyType].label} bot
                  </button>
                </form>
              )}
            </div>
          ) : bottomTab === "backtest" ? (
            <BacktestPanel
              key={backtestKey}
              api={api}
              agentId={agentId}
              coin={coin}
              initial={backtestInitial}
              onStartBot={startBotFromBacktest}
            />
          ) : bottomTab === "history" ? (
            history === "loading" ? <Spinner label="Loading history…" /> :
            history === "error" ? <ErrorNote message="Couldn't load trade history." onRetry={loadHistory} /> :
            !history || history.trades.length === 0 ? <p className={`p-3 text-sm ${mutedClass}`}>{paperMode ? "No paper trades yet." : "No trades yet."}</p> : (
              <div className="space-y-2">
                <div className={`flex items-center gap-4 px-2 text-xs ${mutedClass}`}>
                  <span><span className={`${monoClass} text-[hsl(var(--foreground))]`}>{history.stats.count}</span> closed</span>
                  <span>win rate <span className={`${monoClass} text-[hsl(var(--foreground))]`}>{(history.stats.winRate * 100).toFixed(0)}%</span></span>
                  <span>realized <span className={`${monoClass} ${pnlClass(history.stats.totalPnl)}`}>{signed(history.stats.totalPnl)}</span></span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className={`text-left text-[10px] uppercase tracking-wide ${mutedClass}`}>
                      <th className="px-2 pb-1 font-medium">Market</th>
                      <th className="px-2 pb-1 font-medium text-right">Size</th>
                      <th className="px-2 pb-1 font-medium text-right">Fill</th>
                      <th className="px-2 pb-1 font-medium text-right">Status</th>
                      <th className="px-2 pb-1 font-medium text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {history.trades.map((t) => (
                      <tr key={t.id}>
                        <td className="px-2 py-1.5">
                          <span className="font-semibold">{t.coin}</span>{" "}
                          <Badge tone={t.isBuy ? "success" : "danger"}>{t.isBuy ? "buy" : "sell"}</Badge>
                        </td>
                        <td className={`px-2 py-1.5 text-right ${monoClass}`}>${t.sizeUsd}</td>
                        <td className={`px-2 py-1.5 text-right ${monoClass} ${mutedClass}`}>{t.fillPrice != null ? formatPrice(t.fillPrice) : "—"}</td>
                        <td className={`px-2 py-1.5 text-right ${mutedClass}`}>{t.status}</td>
                        <td className={`px-2 py-1.5 text-right ${monoClass} ${t.realizedPnl != null ? pnlClass(t.realizedPnl) : mutedClass}`}>
                          {t.realizedPnl != null ? signed(t.realizedPnl) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              <Section title="Signing" dense>
                {!agentId ? (
                  <p className={`text-xs ${mutedClass}`}>Pick an agent first.</p>
                ) : instant ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs">
                      <Badge tone={network === "mainnet" ? "danger" : "success"}>Instant · {network}</Badge>{" "}
                      <span className={mutedClass}>The agent signs from its own wallet — no passphrase.</span>
                    </span>
                    <button type="button" className={secondaryButtonClass("text-xs")} onClick={disableInstant} disabled={instantBusy}>
                      Require passphrase
                    </button>
                  </div>
                ) : isOwner && !usePassphrase ? (
                  <div className="space-y-1">
                    <p className="text-xs">Your first order switches the agent to its own wallet — no passphrase needed.</p>
                    <button type="button" className={`text-xs underline ${mutedClass}`} onClick={() => setUsePassphrase(true)}>
                      Use a passphrase-protected wallet instead
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className={`text-xs ${mutedClass}`}>
                      Trades need the wallet passphrase{isOwner ? "." : " until the org owner places an order with this agent."}
                    </p>
                    {isOwner && (
                      <button type="button" className={`text-xs underline ${mutedClass}`} onClick={() => setUsePassphrase(false)}>
                        Switch back to no-passphrase trading
                      </button>
                    )}
                  </div>
                )}
                {wallet && <p className={`text-[11px] ${monoClass} ${mutedClass} break-all`}>Wallet {wallet}</p>}
              </Section>

              <Section title="Risk limits" dense description="Enforced on every order this agent places — by you, a bot, or the agent itself.">
                <form className="space-y-2" onSubmit={saveRiskConfig}>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label htmlFor="riskLeverage" className={labelClass}>Max leverage</label>
                      <input id="riskLeverage" name="riskLeverage" type="number" min="1" className={`${inputClass} ${monoClass}`} value={riskLeverage} onChange={(e) => setRiskLeverage(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="riskMaxPosition" className={labelClass}>Max position $</label>
                      <input id="riskMaxPosition" name="riskMaxPosition" type="number" min="0" className={`${inputClass} ${monoClass}`} value={riskMaxPosition} onChange={(e) => setRiskMaxPosition(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="riskMaxDailyLoss" className={labelClass}>Max daily loss $</label>
                      <input id="riskMaxDailyLoss" name="riskMaxDailyLoss" type="number" min="0" className={`${inputClass} ${monoClass}`} value={riskMaxDailyLoss} onChange={(e) => setRiskMaxDailyLoss(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="submit" className={primaryButtonClass("py-1.5")} disabled={!agentId}>Save limits</button>
                    {riskStatus && <span className={`text-xs ${mutedClass}`}>{riskStatus}</span>}
                  </div>
                </form>
              </Section>

              <Section
                title="Imported wallet"
                dense
                description="Optional: trade from a Hyperliquid key you already have, encrypted with a passphrase."
                right={
                  walletStatus?.hasWallet && !instant ? (
                    <div className="flex gap-2">
                      <button type="button" className={secondaryButtonClass("text-xs")} onClick={() => setWalletFormOpen((v) => !v)}>Rotate key</button>
                      <button type="button" className={secondaryButtonClass("text-xs text-red-600 dark:text-red-400")} onClick={removeWallet}>Remove</button>
                    </div>
                  ) : (
                    <button type="button" className={secondaryButtonClass("text-xs")} onClick={() => setWalletFormOpen((v) => !v)} disabled={!agentId || !orgId}>
                      Import key
                    </button>
                  )
                }
              >
                {walletLoading ? (
                  <Spinner label="Checking wallet…" />
                ) : instant ? (
                  <p className={`text-xs ${mutedClass}`}>Not in use — instant trading signs with the agent&apos;s own wallet.</p>
                ) : walletStatus?.hasWallet ? (
                  <Badge tone="success">Imported key set</Badge>
                ) : (
                  <p className={`text-xs ${mutedClass}`}>None.</p>
                )}
                {walletFormOpen && (
                  <form className="space-y-2 border-t border-[hsl(var(--border))] pt-2" onSubmit={saveWallet}>
                    <div>
                      <label htmlFor="walletKey" className={labelClass}>Hyperliquid private key</label>
                      <input
                        id="walletKey" name="walletKey" type="password" className={inputClass} required
                        value={walletKeyInput} onChange={(e) => setWalletKeyInput(e.target.value)} autoComplete="new-password"
                      />
                    </div>
                    <div>
                      <label htmlFor="walletPassphrase" className={labelClass}>Passphrase (encrypts the key)</label>
                      <input
                        id="walletPassphrase" name="walletPassphrase" type="password" className={inputClass} required
                        value={masterSecret} onChange={(e) => setMasterSecret(e.target.value)} autoComplete="new-password"
                      />
                    </div>
                    <div className="flex gap-2 items-end">
                      <div className="flex-1">
                        <label htmlFor="walletNetwork" className={labelClass}>Network</label>
                        <select
                          id="walletNetwork" name="walletNetwork" className={inputClass}
                          value={walletNetwork} onChange={(e) => setWalletNetwork(e.target.value as Network)}
                        >
                          <option value="testnet">Testnet</option>
                          <option value="mainnet">Mainnet</option>
                        </select>
                      </div>
                      <button type="submit" className={primaryButtonClass("py-1.5")} disabled={!masterSecret || !walletKeyInput}>Save</button>
                    </div>
                  </form>
                )}
                {walletActionStatus && <p className={`text-xs ${mutedClass}`}>{walletActionStatus}</p>}
              </Section>

              <Section
                title="Connect your agent"
                description="Let the agent trade on its own through this mod's API — same wallet, capabilities, and limits."
                dense
                right={
                  <div className="flex gap-2">
                    <button type="button" className={secondaryButtonClass("text-xs")} onClick={loadConnection} disabled={!agentId}>Check</button>
                    <button type="button" className={secondaryButtonClass("text-xs")} onClick={() => setConnectOpen((v) => !v)}>
                      {connectOpen ? "Hide setup" : "Setup"}
                    </button>
                  </div>
                }
              >
                {connection === "loading" ? (
                  <Spinner label="Checking agent…" />
                ) : connection === "error" ? (
                  <ErrorNote message="Couldn't check this agent." onRetry={loadConnection} />
                ) : connection ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      {connection.readyToTrade ? <Badge tone="success">Ready to trade</Badge> : <Badge tone="warning">Not ready yet</Badge>}
                      {connection.pendingStrategies > 0 && (
                        <Badge tone="warning">{connection.pendingStrategies} pending signal{connection.pendingStrategies === 1 ? "" : "s"}</Badge>
                      )}
                    </div>
                    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <li className="flex items-center gap-1.5">
                        <span aria-hidden="true">{connection.wallet.configured ? "✓" : "✗"}</span>
                        Wallet {connection.wallet.configured ? `(${connection.wallet.network})` : "not set"}
                      </li>
                      <li className="flex items-center gap-1.5">
                        <span aria-hidden="true">{connection.risk ? "✓" : "–"}</span>
                        {connection.risk ? `Limits: max $${connection.risk.maxPositionUsd}/trade` : "No risk limits"}
                      </li>
                      {Object.entries(connection.capabilities).map(([key, granted]) => (
                        <li key={key} className={`flex items-center gap-1.5 ${granted ? "" : mutedClass}`}>
                          <span aria-hidden="true">{granted ? "✓" : "✗"}</span>
                          <span className={monoClass}>{key}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {connectOpen && (
                  <div className="space-y-2 border-t border-[hsl(var(--border))] pt-2">
                    <div className="flex items-center justify-between">
                      <span className={labelClass}>Run from your agent&apos;s machine</span>
                      <button type="button" className={secondaryButtonClass("text-xs")} onClick={copySnippet}>{copied ? "Copied" : "Copy"}</button>
                    </div>
                    <pre className={`${monoClass} overflow-x-auto whitespace-pre rounded-sm bg-[hsl(var(--muted))] p-2 text-[11px] leading-relaxed`}>
                      {connectSnippet}
                    </pre>
                    <p className={`text-xs ${mutedClass}`}>
                      The tool manifest at <span className={monoClass}>/api/mods/hyperliquid-trading/agent/tools</span> works as LLM tool definitions.
                    </p>
                  </div>
                )}
              </Section>

              <Section title="Referral" dense description="Refer another agent and earn a cut of the trading volume it generates.">
                {referral === "loading" && <Spinner label="Loading referral stats…" />}
                {referral === "error" && <ErrorNote message="Couldn't load referral stats." onRetry={loadReferral} />}
                {referral && referral !== "loading" && referral !== "error" && (
                  <>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                      <Stat label="Your code"><span className="break-all">{referral.code}</span></Stat>
                      <Stat label="Referred">{referral.referredCount}</Stat>
                      <Stat label="Volume">${referral.totalVolumeUsd.toFixed(2)}</Stat>
                      <Stat label="Earned"><span className="text-green-600 dark:text-green-400">${referral.rewardUsd.toFixed(2)}</span></Stat>
                    </div>
                    {referral.referredBy ? (
                      <p className={`text-xs ${mutedClass}`}>Referred by <code className={monoClass}>{referral.referredBy}</code>.</p>
                    ) : (
                      <form className="flex gap-2 items-end" onSubmit={applyReferral}>
                        <div className="flex-1">
                          <label htmlFor="referralCodeInput" className={labelClass}>Have a referral code?</label>
                          <input
                            id="referralCodeInput" name="referralCodeInput" className={inputClass}
                            value={referralCodeInput} onChange={(e) => setReferralCodeInput(e.target.value)}
                            placeholder="Referring agent's ID"
                          />
                        </div>
                        <button type="submit" className={primaryButtonClass("py-1.5")} disabled={!agentId || !referralCodeInput}>Apply</button>
                      </form>
                    )}
                    {referralStatus && <p className={`text-xs ${mutedClass}`}>{referralStatus}</p>}
                  </>
                )}
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { trading: TradingPanel } });
