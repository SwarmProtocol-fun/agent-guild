"use client";

/**
 * The terminal's Scanner tab: arbitrage and relative-value setups across the
 * whole market, not one chart — funding gaps against Binance/Bybit, perps
 * trading off their oracle, and stretched spreads between correlated coins
 * (GET /scanner, computed by scanner.ts). Any row can be handed to the
 * "Train a goal" form as a basket for the agent to practise on paper. A pair
 * can be backtested here with the pairs bot's own rules (pairs.ts) and
 * started as a rule-based pairs bot. Spot-perp basis rows can start a paper
 * basis bot. Positioning and flow for the same coins sit on top
 * (intel-panel.tsx), with order-book imbalance at the bottom.
 */
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { venueLabel, type FundingArb, type PairSpread, type PremiumRow } from "./scanner";
import type { BasisRow } from "./basis";
import type { Imbalance } from "./signals";
import { PAIRS_DEFAULTS, backtestPairs } from "./pairs";
import type { Candle } from "./indicators";
import { IntelSection } from "./intel-panel";

type Network = "testnet" | "mainnet";

const BAR_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Backtests size the first leg at this, so results read as % of it. */
const BACKTEST_SIZE_USD = 100;

type PairBacktest = { trades: number; netPnl: number; winRate: number; bars: number; days: number } | "loading" | { error: string };

interface ScanResponse {
  coins: string[];
  interval: string;
  fundingArbs: FundingArb[];
  premiums: PremiumRow[];
  pairs: PairSpread[];
  basis?: BasisRow[];
  imbalances?: Imbalance[];
  error?: string;
}

const inputClass =
  "w-full rounded-sm border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-sm font-mono tabular-nums " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";
const labelClass = "block text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1";
const muted = "text-[hsl(var(--muted-foreground))]";
const mono = "font-mono tabular-nums";
const th = `px-2 pb-1 font-medium ${muted}`;
const buttonClass =
  "inline-flex items-center justify-center rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-0.5 text-xs font-medium " +
  "transition-colors hover:bg-[hsl(var(--accent))] disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";

function signed(n: number, digits = 2) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}
function tone(n: number) {
  return n >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
}
function usd(n: number | null) {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

export function ScannerPanel({ api, network, onPractice, onRunPairs, onRunBasis }: {
  api: (path: string, init?: RequestInit) => Promise<Response>;
  network: Network;
  /** Prefills the train form with a basket and a goal for this setup. */
  onPractice: (coins: string[], goal: string) => void;
  /** Starts a rule-based pairs bot on these two coins. */
  onRunPairs: (coins: string[], interval: string) => void;
  /** Starts a paper spot-perp basis bot on this coin. */
  onRunBasis?: (coin: string) => void;
}) {
  const [backtests, setBacktests] = useState<Record<string, PairBacktest>>({});

  /** Replays the pairs bot's rules over the last 1000 bars of both coins. */
  async function backtestPair(p: PairSpread, interval: string) {
    const key = `${p.a}/${p.b}`;
    setBacktests((b) => ({ ...b, [key]: "loading" }));
    try {
      const load = async (coin: string): Promise<Candle[]> => {
        const resp = await api(`candles/${coin}?network=${network}&interval=${interval}&bars=1000`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        return data.candles;
      };
      const [ca, cb] = await Promise.all([load(p.a), load(p.b)]);
      const r = backtestPairs({ ...PAIRS_DEFAULTS, coins: [p.a, p.b], interval }, { [p.a]: ca, [p.b]: cb }, BACKTEST_SIZE_USD, BAR_MS[interval] ?? 3_600_000);
      const bars = ca.length;
      setBacktests((b) => ({
        ...b,
        [key]: { trades: r.trades.length, netPnl: r.netPnl, winRate: r.winRate, bars, days: Math.round((bars * (BAR_MS[interval] ?? 3_600_000)) / 86_400_000) },
      }));
    } catch (err) {
      setBacktests((b) => ({ ...b, [key]: { error: (err as Error).message || "Backtest failed" } }));
    }
  }

  const [coinsInput, setCoinsInput] = useState("");
  const [barSize, setBarSize] = useState("1h");
  const [scan, setScan] = useState<ScanResponse | "loading" | { error: string } | null>(null);

  async function load(e?: FormEvent) {
    e?.preventDefault();
    setScan("loading");
    try {
      const coins = coinsInput.split(/[\s,/]+/).map((c) => c.trim().toUpperCase()).filter(Boolean).join(",");
      const resp = await api(`scanner?network=${network}&interval=${barSize}${coins ? `&coins=${encodeURIComponent(coins)}` : ""}`);
      const data = (await resp.json()) as ScanResponse;
      setScan(data.error ? { error: data.error } : data);
    } catch {
      setScan({ error: "Couldn't reach the scanner." });
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [network]);

  return (
    <div className="space-y-3">
      <form onSubmit={load} className="flex flex-wrap items-end gap-2 px-2">
        <div className="min-w-48 flex-1">
          <label htmlFor="scanCoins" className={labelClass}>Pairs among</label>
          <input
            id="scanCoins" name="scanCoins" className={inputClass} placeholder="Top 8 by volume — or BTC, ETH, SOL, …"
            value={coinsInput} onChange={(e) => setCoinsInput(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <label htmlFor="scanInterval" className={labelClass}>Bars</label>
          <select id="scanInterval" name="scanInterval" className={`${inputClass} w-auto`} value={barSize} onChange={(e) => setBarSize(e.target.value)}>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>
        </div>
        <button type="submit" className={`${buttonClass} py-1.5 text-sm`} disabled={scan === "loading"}>
          {scan === "loading" ? "Scanning…" : "Scan"}
        </button>
      </form>

      {scan === null || scan === "loading" ? (
        <p className={`px-2 text-sm ${muted}`}>Scanning the market…</p>
      ) : "error" in scan ? (
        <p className="px-2 text-sm text-red-600 dark:text-red-400">{scan.error}</p>
      ) : (
        <>
          <IntelSection api={api} coins={scan.coins} />

          <section>
            <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Pair spreads</h3>
            <p className={`px-2 pb-1 text-[11px] ${muted}`}>
              Correlated coins whose spread (ln A − β·ln B, {scan.interval} bars) is far from its mean. Long the cheap leg, short the rich one, both on Hyperliquid. Checked: {scan.coins.join(", ")}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                  <th className={th}>Pair</th><th className={`${th} text-right`}>Correlation</th><th className={`${th} text-right`}>β</th>
                  <th className={`${th} text-right`}>z-score</th><th className={th}>Setup</th><th className={th}></th>
                </tr></thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {scan.pairs.length === 0 && <tr><td colSpan={6} className={`px-2 py-2 ${muted}`}>No pair moves together closely enough right now.</td></tr>}
                  {scan.pairs.map((p) => {
                    const stretched = Math.abs(p.z) >= 2;
                    const bt = backtests[`${p.a}/${p.b}`];
                    return (
                      <Fragment key={`${p.a}/${p.b}`}>
                      <tr>
                        <td className={`px-2 py-1.5 ${mono}`}>{p.a} / {p.b}</td>
                        <td className={`px-2 py-1.5 text-right ${mono}`}>{p.correlation.toFixed(2)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono}`}>{p.beta.toFixed(2)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${stretched ? "font-semibold" : muted}`}>{signed(p.z)}</td>
                        <td className="px-2 py-1.5">{stretched ? `Long ${p.longLeg}, short ${p.shortLeg}` : <span className={muted}>Inside 2σ — wait</span>}</td>
                        <td className="space-x-1 whitespace-nowrap px-2 py-1.5 text-right">
                          <button type="button" className={buttonClass} disabled={bt === "loading"} onClick={() => backtestPair(p, scan.interval)}>
                            {bt === "loading" ? "Testing…" : "Backtest"}
                          </button>
                          <button type="button" className={buttonClass} onClick={() => onRunPairs([p.a, p.b], scan.interval)} title="Start a rule-based pairs bot on these two coins">
                            Run bot
                          </button>
                          <button type="button" className={buttonClass} onClick={() => onPractice([p.a, p.b], `Stat-arb ${p.a} against ${p.b}. When the spread z-score passes ±2, long the cheap leg and short the rich leg at equal size. Close both legs together once z is back inside ±0.5. Never hold one leg alone.`)}>
                            Practise
                          </button>
                        </td>
                      </tr>
                      {bt && bt !== "loading" && (
                        <tr>
                          <td colSpan={6} className="px-2 pb-2 text-[11px]">
                            {"error" in bt ? (
                              <span className="text-red-600 dark:text-red-400">Backtest failed: {bt.error}</span>
                            ) : (
                              <span className={muted}>
                                Pairs-bot rules over the last {bt.bars} bars (~{bt.days} days), ${BACKTEST_SIZE_USD} first leg, taker fees both ways:{" "}
                                <span className={`${mono} font-semibold ${bt.trades ? tone(bt.netPnl) : ""}`}>{bt.trades ? `${signed(bt.netPnl)} USD` : "no trades"}</span>
                                {bt.trades > 0 && <> · {bt.trades} trade{bt.trades === 1 ? "" : "s"} · {Math.round(bt.winRate * 100)}% won</>}
                                . Past results don&apos;t promise future ones.
                              </span>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Funding vs other venues</h3>
            <p className={`px-2 pb-1 text-[11px] ${muted}`}>
              Annualised funding, all venues normalised to per-hour. Take the Hyperliquid side shown and hedge the opposite side on the other venue (that leg is yours to place there), or hedge with a correlated coin here.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                  <th className={th}>Coin</th><th className={`${th} text-right`}>Hyperliquid APR</th><th className={th}>vs</th>
                  <th className={`${th} text-right`}>Their APR</th><th className={`${th} text-right`}>Spread</th><th className={th}>HL side</th>
                  <th className={`${th} text-right`}>24h vol</th><th className={th}></th>
                </tr></thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {scan.fundingArbs.length === 0 && <tr><td colSpan={8} className={`px-2 py-2 ${muted}`}>No funding gap over 10% APR on a liquid market.</td></tr>}
                  {scan.fundingArbs.map((f) => (
                    <tr key={f.coin}>
                      <td className={`px-2 py-1.5 ${mono}`}>{f.coin}</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${tone(f.hl.aprPct)}`}>{signed(f.hl.aprPct, 1)}%</td>
                      <td className="px-2 py-1.5">{venueLabel(f.other.venue)}</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${tone(f.other.aprPct)}`}>{signed(f.other.aprPct, 1)}%</td>
                      <td className={`px-2 py-1.5 text-right ${mono} font-semibold`}>{f.spreadAprPct.toFixed(1)}%</td>
                      <td className="px-2 py-1.5">{f.hlSide === "short" ? "Short" : "Long"}</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{usd(f.volume24hUsd)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button type="button" className={buttonClass} onClick={() => onPractice([f.coin, f.coin === "BTC" ? "ETH" : "BTC"], `Funding carry on ${f.coin}: hold ${f.hlSide} ${f.coin} while Hyperliquid funding pays that side, hedged with the opposite position in ${f.coin === "BTC" ? "ETH" : "BTC"}. Close both when the funding edge fades.`)}>
                          Practise
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Premium to oracle</h3>
            <p className={`px-2 pb-1 text-[11px] ${muted}`}>Perps trading furthest from their spot index. Funding is charged on this premium, and it tends to close.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                  <th className={th}>Coin</th><th className={`${th} text-right`}>Mark</th><th className={`${th} text-right`}>Oracle</th>
                  <th className={`${th} text-right`}>Premium</th><th className={`${th} text-right`}>Funding APR</th><th className={`${th} text-right`}>24h vol</th>
                </tr></thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {scan.premiums.length === 0 && <tr><td colSpan={6} className={`px-2 py-2 ${muted}`}>Every liquid perp is within 0.1% of its oracle.</td></tr>}
                  {scan.premiums.map((p) => (
                    <tr key={p.coin}>
                      <td className={`px-2 py-1.5 ${mono}`}>{p.coin}</td>
                      <td className={`px-2 py-1.5 text-right ${mono}`}>{+p.markPx.toPrecision(6)}</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{+p.oraclePx.toPrecision(6)}</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${tone(p.premiumPct)}`}>{signed(p.premiumPct, 3)}%</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${tone(p.fundingAprPct)}`}>{signed(p.fundingAprPct, 1)}%</td>
                      <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{usd(p.volume24hUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {scan.basis && (
            <section>
              <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Spot-perp basis</h3>
              <p className={`px-2 pb-1 text-[11px] ${muted}`}>
                Perps with a Hyperliquid spot market. Long spot and short the perp to collect funding with price hedged out. Best carry first.
                {network !== "mainnet" ? " Spot markets are mainnet only." : ""}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                    <th className={th}>Coin</th><th className={th}>Spot</th><th className={`${th} text-right`}>Perp</th><th className={`${th} text-right`}>Spot px</th>
                    <th className={`${th} text-right`}>Basis</th><th className={`${th} text-right`}>Funding APR</th><th className={`${th} text-right`}>Spot 24h vol</th><th className={th} />
                  </tr></thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {scan.basis.length === 0 && <tr><td colSpan={8} className={`px-2 py-2 ${muted}`}>No perp has a liquid spot market right now.</td></tr>}
                    {scan.basis.map((b) => (
                      <tr key={b.coin}>
                        <td className={`px-2 py-1.5 ${mono}`}>{b.coin}</td>
                        <td className={`px-2 py-1.5 ${mono} ${muted}`}>{b.spotToken}</td>
                        <td className={`px-2 py-1.5 text-right ${mono}`}>{+b.perpPx.toPrecision(6)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{+b.spotPx.toPrecision(6)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${tone(b.basisPct)}`}>{signed(b.basisPct, 3)}%</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${tone(b.fundingAprPct)}`}>{signed(b.fundingAprPct, 1)}%</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{usd(b.spotVolume24hUsd)}</td>
                        <td className="px-2 py-1.5 text-right">
                          {onRunBasis && b.fundingAprPct > 0 && (
                            <button type="button" className={buttonClass} onClick={() => onRunBasis(b.coin)} title="Start a paper basis bot on this coin">
                              Carry on paper
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {scan.imbalances && scan.imbalances.length > 0 && (
            <section>
              <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Order-book imbalance</h3>
              <p className={`px-2 pb-1 text-[11px] ${muted}`}>Resting bid vs ask depth within ±0.5% of the mid. +1 is all bids, −1 all asks.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                    <th className={th}>Coin</th><th className={`${th} text-right`}>Imbalance</th><th className={`${th} text-right`}>Bid depth</th><th className={`${th} text-right`}>Ask depth</th>
                  </tr></thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {scan.imbalances.map((b) => (
                      <tr key={b.coin}>
                        <td className={`px-2 py-1.5 ${mono}`}>{b.coin}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${tone(b.imbalance)}`}>{signed(b.imbalance, 2)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{usd(b.bidUsd)}</td>
                        <td className={`px-2 py-1.5 text-right ${mono} ${muted}`}>{usd(b.askUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
