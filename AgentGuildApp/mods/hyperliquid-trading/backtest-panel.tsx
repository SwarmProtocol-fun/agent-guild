"use client";

/**
 * The terminal's Backtest tab: replays real Hyperliquid candles through the
 * same rules the live bots use (backtest.ts), in the browser. An AI backtest
 * puts each decision bar's question to the agent itself (POST /ai/ask), and
 * the agent's own daemon answers it on its own model — one bar at a time, so
 * it is capped and can be stopped midway.
 */
import { useRef, useState, type FormEvent } from "react";
import { runBacktest, type BacktestResult, type BacktestStrategy } from "./backtest";
import type { AiDecision } from "./ai-trader-core";
import type { Candle } from "./indicators";

type Network = "testnet" | "mainnet";
type Kind = "hold" | "dca" | "grid" | "sniper" | "ai";
type Interval = "15m" | "1h" | "4h" | "1d";

const INTERVAL_MS: Record<Interval, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const KIND_LABEL: Record<Kind, string> = { hold: "Buy & hold", dca: "DCA", grid: "Grid", sniper: "Sniper", ai: "AI Trader" };
/** Questions one AI backtest may put to the agent — each is a real run of its model. */
export const MAX_AI_BACKTEST_DECISIONS = 48;
/** Bars of history before the first AI decision, so its snapshot is as full as the live bot's. */
const AI_WARMUP_BARS = 112;

export interface BotSpec {
  type: "dca" | "grid" | "sniper" | "ai";
  coin: string;
  sizeUsd: number;
  params: Record<string, unknown>;
}

const inputClass =
  "w-full rounded-sm border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm font-mono tabular-nums " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";
const labelClass = "block text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1";
const muted = "text-[hsl(var(--muted-foreground))]";
const mono = "font-mono tabular-nums";

function pct(n: number | null, digits = 2) {
  return n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
function tone(n: number | null) {
  return n == null ? "" : n >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
}

/** Strategy equity vs buy & hold, as two lines; stretches to its box. */
function EquityChart({ result, candles, startIndex }: { result: BacktestResult; candles: Candle[]; startIndex: number }) {
  const W = 1000;
  const H = 220;
  const eq = result.equity;
  if (eq.length < 2) return null;
  const firstPx = candles[startIndex].c;
  const hold = eq.map((e, i) => result.startingBalance * (candles[startIndex + i].c / firstPx));
  const all = [...eq.map((e) => e.value), ...hold, result.startingBalance];
  const hi = Math.max(...all);
  const lo = Math.min(...all);
  const pad = (hi - lo || 1) * 0.08;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => (i / (eq.length - 1)) * W;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const up = result.finalEquity >= result.startingBalance;
  const tradeTs = new Set(result.trades.map((t) => t.t));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-48 w-full" role="img"
        aria-label={`Equity from ${result.startingBalance} to ${result.finalEquity.toFixed(2)}`}>
        <line x1={0} x2={W} y1={y(result.startingBalance)} y2={y(result.startingBalance)} className="stroke-[hsl(var(--border))]" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={path(hold)} fill="none" className="stroke-[hsl(var(--muted-foreground))]" strokeWidth={1.25} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <path d={path(eq.map((e) => e.value))} fill="none" className={up ? "stroke-green-500" : "stroke-red-500"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {eq.map((e, i) => tradeTs.has(e.t) && (
          <line key={e.t} x1={x(i)} x2={x(i)} y1={H - 6} y2={H} className="stroke-amber-500" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className={`flex justify-between text-[10px] ${muted} ${mono}`}>
        <span>{new Date(eq[0].t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span className="flex gap-3">
          <span><span className={`inline-block h-0.5 w-3 align-middle ${up ? "bg-green-500" : "bg-red-500"}`} /> strategy</span>
          <span><span className="inline-block h-0.5 w-3 align-middle bg-[hsl(var(--muted-foreground))]" /> buy &amp; hold</span>
          <span><span className="inline-block h-2 w-0.5 align-middle bg-amber-500" /> fills</span>
        </span>
        <span>{new Date(eq[eq.length - 1].t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

function Tile({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-sm border border-[hsl(var(--border))] p-2" title={hint}>
      <div className={`text-[10px] uppercase tracking-wide ${muted}`}>{label}</div>
      <div className={`${mono} text-sm font-semibold`}>{children}</div>
    </div>
  );
}

export function BacktestPanel({ api, agentId, coin: defaultCoin, initial, onStartBot }: {
  api: (path: string, init?: RequestInit) => Promise<Response>;
  agentId: string;
  coin: string;
  /** Prefill from a bot card's "Backtest" button. */
  initial?: BotSpec | null;
  onStartBot: (spec: BotSpec) => Promise<boolean>;
}) {
  const ip = (initial?.params ?? {}) as Record<string, number | string | undefined>;
  const [kind, setKind] = useState<Kind>(initial?.type ?? "ai");
  const [coin, setCoin] = useState(initial?.coin ?? defaultCoin);
  const [dataNetwork, setDataNetwork] = useState<Network>("mainnet");
  const [interval, setInterval_] = useState<Interval>(
    initial?.type === "ai" && ip.intervalMs ? ((Object.keys(INTERVAL_MS) as Interval[]).find((k) => INTERVAL_MS[k] === Number(ip.intervalMs)) ?? "1h") : "1h",
  );
  const [bars, setBars] = useState("500");
  const [balance, setBalance] = useState("1000");
  const [sizeUsd, setSizeUsd] = useState(String(initial?.sizeUsd ?? 100));
  const [leverage, setLeverage] = useState(String(ip.leverage ?? 1));
  const [dcaEveryH, setDcaEveryH] = useState(String(ip.intervalMs ? Number(ip.intervalMs) / 3_600_000 : 24));
  const [gridLower, setGridLower] = useState(String(ip.lowerPrice ?? ""));
  const [gridUpper, setGridUpper] = useState(String(ip.upperPrice ?? ""));
  const [gridLevels, setGridLevels] = useState(String(ip.levels ?? 10));
  const [sniperMode, setSniperMode] = useState<"price-above" | "price-below">((ip.mode as "price-above" | "price-below") ?? "price-below");
  const [sniperTarget, setSniperTarget] = useState(String(ip.targetPrice ?? ""));
  const [aiDecisions, setAiDecisions] = useState("24");
  const [maxDd, setMaxDd] = useState(String(ip.maxDrawdownPct ?? 50));

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ result: BacktestResult; candles: Candle[]; startIndex: number; spec: BotSpec | null } | null>(null);
  const [startStatus, setStartStatus] = useState<string | null>(null);
  const stopRef = useRef(false);

  const decisionCount = Math.min(MAX_AI_BACKTEST_DECISIONS, Math.max(1, Number(aiDecisions) || 1));

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStartStatus(null);
    setOutcome(null);
    stopRef.current = false;
    setRunning(true);
    try {
      const barMs = INTERVAL_MS[interval];
      const want = kind === "ai" ? decisionCount + AI_WARMUP_BARS : Math.min(1000, Math.max(50, Number(bars) || 500));
      const resp = await api(`candles/${encodeURIComponent(coin)}?interval=${interval}&network=${dataNetwork}&bars=${want}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const candles: Candle[] = data.candles ?? [];
      if (candles.length < (kind === "ai" ? 40 : 10)) throw new Error(`Only ${candles.length} ${coin} bars of ${interval} history on ${dataNetwork}.`);

      const size = Number(sizeUsd);
      const lev = Math.max(1, Number(leverage) || 1);
      let strategy: BacktestStrategy;
      let spec: BotSpec | null = null;
      let startIndex = 0;
      if (kind === "hold") {
        strategy = { type: "hold" };
      } else if (kind === "dca") {
        const intervalMs = Math.max(1, Number(dcaEveryH)) * 3_600_000;
        strategy = { type: "dca", intervalMs };
        spec = { type: "dca", coin, sizeUsd: size, params: { intervalMs } };
      } else if (kind === "grid") {
        const g = { lowerPrice: Number(gridLower), upperPrice: Number(gridUpper), levels: Number(gridLevels) };
        if (!(g.lowerPrice > 0 && g.upperPrice > g.lowerPrice && g.levels >= 1)) throw new Error("Grid needs lower < upper and at least 1 level.");
        strategy = { type: "grid", ...g };
        spec = { type: "grid", coin, sizeUsd: size, params: g };
      } else if (kind === "sniper") {
        const targetPrice = Number(sniperTarget);
        if (!(targetPrice > 0)) throw new Error("Sniper needs a target price.");
        strategy = { type: "sniper", mode: sniperMode, targetPrice };
        spec = { type: "sniper", coin, sizeUsd: size, params: { mode: sniperMode, targetPrice } };
      } else {
        // The last bar can't trade (nothing fills after it), so start one bar earlier.
        startIndex = Math.max(20, candles.length - decisionCount - 1);
        strategy = {
          type: "ai",
          everyBars: 1,
          decide: async ({ candles: seen, position }) => {
            const r = await api("ai/ask", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agentId, coin, interval, candles: seen.slice(-AI_WARMUP_BARS), position }),
            });
            const asked = await r.json();
            if (asked.error) throw new Error(asked.error);
            // The agent's daemon picks the question up on its next poll and answers on its own model.
            for (;;) {
              if (stopRef.current) throw new Error("Stopped.");
              await new Promise((res) => setTimeout(res, 2000));
              const q = await (await api(`ai/requests/${asked.id}`)).json();
              if (q.error) throw new Error(q.error);
              if (q.status === "answered") return { decision: q.decision as AiDecision, reasoning: q.reasoning as string };
              if (q.status === "expired") {
                throw new Error("Your agent didn't answer in time — is its daemon running (agent-guild daemon)?");
              }
            }
          },
        };
        spec = { type: "ai", coin, sizeUsd: size, params: { intervalMs: barMs, maxDrawdownPct: Number(maxDd), ...(lev > 1 ? { leverage: lev } : {}) } };
      }

      const result = await runBacktest({
        candles, barMs, strategy, startIndex,
        startingBalance: Number(balance), sizeUsd: kind === "hold" ? Number(balance) * 0.99 * lev : size, leverage: lev,
        maxDrawdownStopPct: kind === "ai" ? Number(maxDd) : undefined,
        onProgress: (done, total) => setProgress({ done, total }),
        shouldStop: () => stopRef.current,
      });
      setOutcome({ result, candles, startIndex, spec });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function startBot() {
    if (!outcome?.spec) return;
    setStartStatus("starting…");
    const ok = await onStartBot(outcome.spec);
    setStartStatus(ok ? "Bot started — see the Bots tab." : null);
  }

  const r = outcome?.result;
  const kinds = Object.keys(KIND_LABEL) as Kind[];

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <form className="space-y-2.5" onSubmit={run}>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Strategy">
          {kinds.map((k) => (
            <button
              key={k} type="button" role="radio" aria-checked={kind === k}
              className={`rounded-sm border px-1.5 py-1 text-xs font-medium ${kind === k ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10" : `border-[hsl(var(--border))] ${muted} hover:text-[hsl(var(--foreground))]`}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label htmlFor="btCoin" className={labelClass}>Coin</label>
            <input id="btCoin" className={inputClass} value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())} required />
          </div>
          <div>
            <label htmlFor="btInterval" className={labelClass}>Bars</label>
            <select id="btInterval" className={inputClass} value={interval} onChange={(e) => setInterval_(e.target.value as Interval)}>
              {(Object.keys(INTERVAL_MS) as Interval[]).map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="btData" className={labelClass}>Prices</label>
            <select id="btData" className={inputClass} value={dataNetwork} onChange={(e) => setDataNetwork(e.target.value as Network)}>
              <option value="mainnet">Mainnet</option>
              <option value="testnet">Testnet</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label htmlFor="btBalance" className={labelClass}>Start $</label>
            <input id="btBalance" type="number" min="10" className={inputClass} value={balance} onChange={(e) => setBalance(e.target.value)} required />
          </div>
          {kind !== "hold" && (
            <div>
              <label htmlFor="btSize" className={labelClass}>$ / order</label>
              <input id="btSize" type="number" min="10" className={inputClass} value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} required />
            </div>
          )}
          <div>
            <label htmlFor="btLev" className={labelClass}>Leverage</label>
            <input id="btLev" type="number" min="1" max="50" className={inputClass} value={leverage} onChange={(e) => setLeverage(e.target.value)} />
          </div>
        </div>

        {kind !== "ai" && (
          <div>
            <label htmlFor="btBars" className={labelClass}>History (bars, max 1000)</label>
            <input id="btBars" type="number" min="50" max="1000" className={inputClass} value={bars} onChange={(e) => setBars(e.target.value)} />
          </div>
        )}
        {kind === "dca" && (
          <div>
            <label htmlFor="btDca" className={labelClass}>Buy every (hours)</label>
            <input id="btDca" type="number" min="1" className={inputClass} value={dcaEveryH} onChange={(e) => setDcaEveryH(e.target.value)} />
          </div>
        )}
        {kind === "grid" && (
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label htmlFor="btLower" className={labelClass}>Lower</label>
              <input id="btLower" type="number" step="any" className={inputClass} value={gridLower} onChange={(e) => setGridLower(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="btUpper" className={labelClass}>Upper</label>
              <input id="btUpper" type="number" step="any" className={inputClass} value={gridUpper} onChange={(e) => setGridUpper(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="btLevels" className={labelClass}>Levels</label>
              <input id="btLevels" type="number" min="1" className={inputClass} value={gridLevels} onChange={(e) => setGridLevels(e.target.value)} required />
            </div>
          </div>
        )}
        {kind === "sniper" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="btSnMode" className={labelClass}>Trigger</label>
              <select id="btSnMode" className={inputClass} value={sniperMode} onChange={(e) => setSniperMode(e.target.value as typeof sniperMode)}>
                <option value="price-below">Price falls below</option>
                <option value="price-above">Price rises above</option>
              </select>
            </div>
            <div>
              <label htmlFor="btSnTarget" className={labelClass}>Target</label>
              <input id="btSnTarget" type="number" step="any" className={inputClass} value={sniperTarget} onChange={(e) => setSniperTarget(e.target.value)} required />
            </div>
          </div>
        )}
        {kind === "ai" && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label htmlFor="btDecisions" className={labelClass}>Decisions (max {MAX_AI_BACKTEST_DECISIONS})</label>
                <input id="btDecisions" type="number" min="1" max={MAX_AI_BACKTEST_DECISIONS} className={inputClass} value={aiDecisions} onChange={(e) => setAiDecisions(e.target.value)} />
              </div>
              <div>
                <label htmlFor="btDd" className={labelClass}>Stop at −%</label>
                <input id="btDd" type="number" min="1" max="95" className={inputClass} value={maxDd} onChange={(e) => setMaxDd(e.target.value)} />
              </div>
            </div>
            <p className={`text-[11px] ${muted}`}>
              One decision per {interval} bar over the last {decisionCount} bars. Your agent answers each one on its own model through
              its daemon (<span className={mono}>agent-guild daemon</span>), so the daemon must be running; each answer takes as long
              as your agent&apos;s model does.
            </p>
          </>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit" disabled={running || !agentId}
            className="inline-flex items-center justify-center rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? "Running…" : "Run backtest"}
          </button>
          {running && (
            <button type="button" className={`text-xs underline ${muted}`} onClick={() => { stopRef.current = true; }}>
              Stop
            </button>
          )}
          {progress && <span className={`text-xs ${mono} ${muted}`}>{progress.done}/{progress.total} bars</span>}
        </div>
        {!agentId && <p className={`text-xs ${muted}`}>Pick an agent first.</p>}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        <p className={`text-[11px] ${muted}`}>
          Fills at the next bar&apos;s open with 0.05% slippage and Hyperliquid&apos;s 0.045% taker fee; funding isn&apos;t modelled.
          Past results don&apos;t predict future ones.
        </p>
      </form>

      <div className="min-w-0 space-y-3">
        {!r ? (
          <div className={`flex h-full min-h-48 items-center justify-center rounded-sm border border-dashed border-[hsl(var(--border))] p-6 text-sm ${muted}`}>
            {running ? "Replaying history…" : "Pick a strategy and run it over real Hyperliquid history."}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">
                {KIND_LABEL[kind]} · {coin} · {interval}
                {r.stoppedOut && <span className="ml-2 text-xs font-normal text-red-600 dark:text-red-400">{r.stoppedOut}</span>}
                {r.endedEarly && <span className={`ml-2 text-xs font-normal ${muted}`}>stopped early</span>}
              </div>
              {outcome?.spec && (
                <div className="flex items-center gap-2">
                  {startStatus && <span className={`text-xs ${muted}`}>{startStatus}</span>}
                  <button type="button" onClick={startBot}
                    className="inline-flex items-center justify-center rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-white">
                    Start this bot live
                  </button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Return"><span className={tone(r.returnPct)}>{pct(r.returnPct)}</span></Tile>
              <Tile label="Buy & hold"><span className={tone(r.buyHoldReturnPct)}>{pct(r.buyHoldReturnPct)}</span></Tile>
              <Tile label="Max drawdown"><span className="text-red-600 dark:text-red-400">{r.maxDrawdownPct ? `−${r.maxDrawdownPct.toFixed(2)}%` : "0%"}</span></Tile>
              <Tile label="Sharpe" hint="Annualized, from per-bar returns">{r.sharpe != null ? r.sharpe.toFixed(2) : "—"}</Tile>
              <Tile label="Final equity">${r.finalEquity.toFixed(2)}</Tile>
              <Tile label="Fills">{r.trades.length}{r.skippedForMargin ? <span className={`ml-1 text-xs font-normal ${muted}`}>({r.skippedForMargin} skipped)</span> : null}</Tile>
              <Tile label="Win rate" hint="Share of closing fills that realized a profit">{r.winRate != null ? `${(r.winRate * 100).toFixed(0)}% of ${r.closingTrades}` : "—"}</Tile>
              <Tile label="Fees">${r.feesPaid.toFixed(2)}</Tile>
            </div>
            {outcome && <EquityChart result={r} candles={outcome.candles} startIndex={outcome.startIndex} />}

            {r.decisions.length > 0 && (
              <details className="rounded-sm border border-[hsl(var(--border))]" open>
                <summary className="cursor-pointer px-2 py-1.5 text-xs font-semibold uppercase tracking-wide">Model decisions ({r.decisions.length})</summary>
                <ul className="max-h-72 divide-y divide-[hsl(var(--border))] overflow-y-auto text-xs">
                  {r.decisions.slice().reverse().map((d) => (
                    <li key={d.t} className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`${mono} ${muted}`}>{new Date(d.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        <span className={`font-semibold ${d.decision === "LONG" ? "text-green-600 dark:text-green-400" : d.decision === "SHORT" ? "text-red-600 dark:text-red-400" : ""}`}>{d.decision}</span>
                        <span className={muted}>→ {d.action}</span>
                        <span className={`ml-auto ${mono}`}>{d.price.toLocaleString()}</span>
                      </div>
                      {d.reasoning && <p className={`mt-0.5 ${muted}`}>{d.reasoning}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {r.trades.length > 0 && (
              <details className="rounded-sm border border-[hsl(var(--border))]">
                <summary className="cursor-pointer px-2 py-1.5 text-xs font-semibold uppercase tracking-wide">Fills ({r.trades.length})</summary>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`text-left text-[10px] uppercase tracking-wide ${muted}`}>
                        <th className="px-2 py-1 font-medium">Time</th>
                        <th className="px-2 py-1 font-medium">Side</th>
                        <th className="px-2 py-1 font-medium text-right">Price</th>
                        <th className="px-2 py-1 font-medium text-right">Value</th>
                        <th className="px-2 py-1 font-medium text-right">PnL</th>
                        <th className="px-2 py-1 font-medium">Why</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[hsl(var(--border))]">
                      {r.trades.map((t, i) => (
                        <tr key={i}>
                          <td className={`px-2 py-1 ${mono} ${muted}`}>{new Date(t.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}</td>
                          <td className={`px-2 py-1 font-semibold ${t.side === "buy" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{t.side}</td>
                          <td className={`px-2 py-1 text-right ${mono}`}>{t.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                          <td className={`px-2 py-1 text-right ${mono}`}>${t.notional.toFixed(2)}</td>
                          <td className={`px-2 py-1 text-right ${mono} ${tone(t.realizedPnl)}`}>{t.realizedPnl != null ? t.realizedPnl.toFixed(2) : "—"}</td>
                          <td className={`px-2 py-1 ${muted}`}>{t.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
