"use client";

/**
 * Scanner tab's "Positioning & flow" section: GET /intel for the coins the
 * scan covered — smart vs dumb money, HLP, OKX crowd ratio and liquidations,
 * plus market-wide sentiment. All from free public sources (intel.ts).
 */
import { useEffect, useState } from "react";
import { netBias, type CoinPositioning, type MarketIntel } from "./intel";

const muted = "text-[hsl(var(--muted-foreground))]";
const mono = "font-mono tabular-nums";
const th = `px-2 pb-1 font-medium ${muted}`;

function usd(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** Net long/short of a group, as a signed % with the dollars behind it on hover. */
function Bias({ p }: { p: CoinPositioning | null }) {
  const b = netBias(p ?? undefined);
  if (b == null || !p) return <span className={muted}>—</span>;
  const title = `Long ${usd(p.longUsd)} (${p.longs}) · short ${usd(p.shortUsd)} (${p.shorts})`;
  return (
    <span className={`${mono} ${b >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`} title={title}>
      {b >= 0 ? "+" : ""}{Math.round(b * 100)}% <span className={`${muted} text-[10px]`}>{usd(p.longUsd + p.shortUsd)}</span>
    </span>
  );
}

export function IntelSection({ api, coins }: { api: (path: string, init?: RequestInit) => Promise<Response>; coins: string[] }) {
  const [intel, setIntel] = useState<MarketIntel | "loading" | { error: string }>("loading");
  const key = coins.join(",");

  useEffect(() => {
    let live = true;
    setIntel("loading");
    api(`intel?coins=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((d) => { if (live) setIntel(d.error ? { error: d.error } : d); })
      .catch(() => { if (live) setIntel({ error: "Couldn't load market intel." }); });
    return () => { live = false; };
    // `api` is a fresh function each render; refetch only when the coins change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <section>
      <h3 className="px-2 text-xs font-semibold uppercase tracking-wide">Positioning &amp; flow</h3>
      <p className={`px-2 pb-1 text-[11px] ${muted}`}>
        Who holds what, from free public data. Smart and dumb money are the month&apos;s 30 most and least profitable large Hyperliquid accounts.
        HLP is Hyperliquid&apos;s market-making vault, so takers hold the opposite side. Liquidations come from OKX. Your AI bots see this too.
      </p>
      {intel === "loading" ? (
        <p className={`px-2 text-sm ${muted}`}>Reading the leaderboard, vaults and exchanges…</p>
      ) : "error" in intel ? (
        <p className="px-2 text-sm text-red-600 dark:text-red-400">{intel.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-2 pb-2 text-xs">
            {intel.fearGreed && <span>Fear &amp; Greed <span className={`${mono} font-semibold`}>{intel.fearGreed.value}</span> <span className={muted}>{intel.fearGreed.label}</span></span>}
            {intel.dvol.BTC != null && <span>BTC implied vol <span className={`${mono} font-semibold`}>{intel.dvol.BTC.toFixed(1)}</span></span>}
            {intel.dvol.ETH != null && <span>ETH implied vol <span className={`${mono} font-semibold`}>{intel.dvol.ETH.toFixed(1)}</span></span>}
            {intel.coinbasePremiumPct != null && (
              <span title="Coinbase BTC-USD vs Hyperliquid BTC. Positive: US spot buyers are paying up.">
                Coinbase premium <span className={`${mono} font-semibold`}>{intel.coinbasePremiumPct >= 0 ? "+" : ""}{intel.coinbasePremiumPct.toFixed(3)}%</span>
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-[10px] uppercase tracking-wide">
                <th className={th}>Coin</th><th className={th}>Smart money</th><th className={th}>Dumb money</th><th className={th}>HLP</th>
                <th className={`${th} text-right`}>OKX long/short</th><th className={`${th} text-right`}>Liq. longs 4h</th><th className={`${th} text-right`}>Liq. shorts 4h</th>
              </tr></thead>
              <tbody className="divide-y divide-[hsl(var(--border))]">
                {intel.coins.map((c) => {
                  const w4 = c.liquidations?.find((w) => w.window === "4h");
                  return (
                    <tr key={c.coin}>
                      <td className={`px-2 py-1.5 ${mono}`}>{c.coin}</td>
                      <td className="px-2 py-1.5"><Bias p={c.smart} /></td>
                      <td className="px-2 py-1.5"><Bias p={c.dumb} /></td>
                      <td className="px-2 py-1.5"><Bias p={c.hlp} /></td>
                      <td className={`px-2 py-1.5 text-right ${mono}`}>{c.okxLongShortRatio != null ? c.okxLongShortRatio.toFixed(2) : <span className={muted}>—</span>}</td>
                      <td className={`px-2 py-1.5 text-right ${mono}`}>{w4 ? usd(w4.longUsd) : <span className={muted}>—</span>}</td>
                      <td className={`px-2 py-1.5 text-right ${mono}`}>{w4 ? usd(w4.shortUsd) : <span className={muted}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {intel.errors.length > 0 && <p className={`px-2 pt-1 text-[11px] ${muted}`}>Unavailable this round: {intel.errors.map((e) => e.split(":")[0]).join(", ")}.</p>}
        </>
      )}
    </section>
  );
}
