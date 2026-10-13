"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BellRing, CheckCheck, Clock, Eye, QrCode, ShieldAlert, X } from "lucide-react";
import {
  Badge, Button, Card, CopyButton, EmptyState, ErrorNote, IconButton, PageHeader, Skeleton, TextInput, cx, mono, muted, shortAddr, timeAgo,
  type Env,
} from "./ui";
import { getJson, usd, type Api } from "./market-tab";

// What the hub runs for the selected agent while it isn't running: standing
// orders, watches, payment requests, and the alerts they leave behind. The
// agent creates these through its tools; the operator watches and can cancel.

interface Trigger { mint: string; op: "above" | "below" | "trail"; usd?: number; trailPct?: number; peakUsd?: number | null }
interface Order {
  id: string; status: string; createdAt: string; expiresAt: string; inputMint: string; outputMint: string; amount: string;
  trigger: Trigger; note: string | null; result?: string; closedAt?: string;
}
type Watch = { id: string; status: string; createdAt: string; expiresAt: string; note: string | null; repeat: boolean; fireCount: number; lastFiredAt?: string }
  & ({ kind: "price"; trigger: Trigger } | { kind: "activity"; address: string; cluster: string });
interface PayRequest { id: string; status: string; createdAt: string; amount: string; mint: string | null; recipient: string; cluster: string; label: string | null; url: string; paidSignature?: string; payer?: string | null }
interface Alert { id: string; at: string; source: string; title: string; detail: string; read: boolean; explorerUrl?: string }
interface Finding { severity: "high" | "medium" | "info"; code: string; message: string }
interface SafetyReport {
  mint: string; name: string | null; symbol: string | null; verdict: "high-risk" | "caution" | "no-red-flags"; findings: Finding[];
  facts: { program: string; supplyUi: string; mintAuthority: string | null; freezeAuthority: string | null; top10Pct: number | null };
  market: { priceUsd: number | null; liquidityUsd: number | null; sellImpactPctFor1k: number | null; holderCount: number | null; verified: boolean };
}

const SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP", DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
};
const tok = (mint: string | null) => (mint ? SYMBOLS[mint] ?? shortAddr(mint, 4) : "SOL");
const triggerText = (t: Trigger) =>
  t.op === "trail" ? `${tok(t.mint)} falls ${t.trailPct}% from high${t.peakUsd ? ` (${usd(t.peakUsd)})` : ""}` : `${tok(t.mint)} ${t.op === "above" ? "≥" : "≤"} ${usd(t.usd ?? null)}`;
const statusTone = (s: string) => (s === "open" || s === "active" || s === "pending" ? "info" : s === "filled" || s === "paid" ? "success" : s === "failed" ? "danger" : "neutral") as "info" | "success" | "danger" | "neutral";
const verdictTone = { "high-risk": "danger", caution: "warning", "no-red-flags": "success" } as const;

export function AutomateTab({ env, api }: { env: Env; api: Api }) {
  const { agent, agentApi } = env;
  const [data, setData] = useState<{ alerts: Alert[]; orders: Order[]; watches: Watch[]; requests: PayRequest[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agent) return;
    setError(null);
    try {
      const [a, o, w, p] = await Promise.all([
        getJson<{ alerts: Alert[] }>(agentApi, "alerts?limit=30"),
        getJson<{ orders: Order[] }>(agentApi, "orders"),
        getJson<{ watches: Watch[] }>(agentApi, "watches"),
        getJson<{ requests: PayRequest[] }>(agentApi, "payments"),
      ]);
      setData({ alerts: a.alerts, orders: o.orders, watches: w.watches, requests: p.requests });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agent, agentApi]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const post = async (key: string, path: string, body: object = {}) => {
    setBusy(key);
    try {
      const res = await agentApi(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unread = data?.alerts.filter((a) => !a.read).length ?? 0;
  const live = {
    orders: data?.orders.filter((o) => o.status === "open") ?? [],
    watches: data?.watches.filter((w) => w.status === "active") ?? [],
    requests: data?.requests.filter((r) => r.status === "pending") ?? [],
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Clock}
        title="While away"
        description="An agent only exists while a prompt runs. These are what the hub does for it in between: it checks every minute, fills standing paper orders, fires watches, confirms payments, and leaves alerts for the agent's next wake."
      />
      {!agent ? (
        <EmptyState icon={Clock} title="Pick an agent">Choose an agent in the sidebar to see what the hub is running for it.</EmptyState>
      ) : (
        <>
          {error && <ErrorNote message={error} onRetry={load} />}

          <Card
            title={<span className="inline-flex items-center gap-2">Alerts {unread > 0 && <Badge tone="info">{unread} unread</Badge>}</span>}
            description="What fired, newest first. The agent reads these with solana_alerts."
            actions={unread > 0 ? <Button className="h-8" icon={CheckCheck} loading={busy === "read"} onClick={() => post("read", "alerts/read", { all: true })}>Mark all read</Button> : undefined}
          >
            {!data ? <Skeleton className="h-16" /> : data.alerts.length === 0 ? (
              <p className={cx("text-sm", muted)}>Nothing has fired yet.</p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {data.alerts.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 py-2.5">
                    <BellRing className={cx("mt-0.5 h-4 w-4 shrink-0", a.read ? muted : "text-[hsl(var(--primary))]")} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className={cx("text-sm", !a.read && "font-medium")}>{a.title}</div>
                      <div className={cx("text-xs break-words", muted)}>{a.detail}</div>
                    </div>
                    <div className={cx("shrink-0 text-right text-xs", muted)}>
                      <div>{timeAgo(a.at)}</div>
                      {a.explorerUrl && <a className="hover:underline" href={a.explorerUrl} target="_blank" rel="noreferrer">tx ↗</a>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={`Standing orders (${live.orders.length} open)`} description="Paper swaps waiting on a price. Created with solana_order.">
              {!data ? <Skeleton className="h-16" /> : data.orders.length === 0 ? (
                <p className={cx("text-sm", muted)}>None. An agent can leave a limit, stop or trailing-stop order that fills while it&apos;s offline.</p>
              ) : (
                <ul className="space-y-2">
                  {data.orders.slice(0, 15).map((o) => (
                    <li key={o.id} className="rounded-md border border-[hsl(var(--border))] p-2.5 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                        <span className="min-w-0 flex-1 truncate">{o.amount} {tok(o.inputMint)} → {tok(o.outputMint)}</span>
                        {o.status === "open" && <IconButton label="Cancel order" icon={X} disabled={busy === o.id} onClick={() => post(o.id, `orders/${o.id}/cancel`)} />}
                      </div>
                      <div className={cx("mt-1 text-xs", muted)}>
                        when {triggerText(o.trigger)} · {o.status === "open" ? `expires ${timeAgo(o.expiresAt)}` : o.result ?? ""}
                      </div>
                      {o.note && <div className={cx("mt-1 text-xs italic", muted)}>“{o.note}”</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={`Watches (${live.watches.length} active)`} description="Price levels and addresses the hub checks. Created with solana_watch.">
              {!data ? <Skeleton className="h-16" /> : data.watches.length === 0 ? (
                <p className={cx("text-sm", muted)}>None.</p>
              ) : (
                <ul className="space-y-2">
                  {data.watches.slice(0, 15).map((w) => (
                    <li key={w.id} className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] p-2.5 text-sm">
                      <Eye className={cx("h-4 w-4 shrink-0", muted)} aria-hidden />
                      <Badge tone={statusTone(w.status)}>{w.status}</Badge>
                      <span className="min-w-0 flex-1 truncate">
                        {w.kind === "price" ? triggerText(w.trigger) : <>activity on <span className={mono}>{shortAddr(w.address, 4)}</span> ({w.cluster})</>}
                      </span>
                      <span className={cx("shrink-0 text-xs", muted)}>fired {w.fireCount}×</span>
                      {w.status === "active" && <IconButton label="Stop watch" icon={X} disabled={busy === w.id} onClick={() => post(w.id, `watches/${w.id}/cancel`)} />}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title={`Payment requests (${live.requests.length} pending)`} description="Solana Pay links the agent sent out. The hub confirms each one on-chain. Created with solana_payment_request.">
            {!data ? <Skeleton className="h-16" /> : data.requests.length === 0 ? (
              <p className={cx("text-sm", muted)}>None. An agent can bill anyone directly and get an alert when it&apos;s paid.</p>
            ) : (
              <ul className="space-y-2">
                {data.requests.slice(0, 15).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--border))] p-2.5 text-sm">
                    <QrCode className={cx("h-4 w-4 shrink-0", muted)} aria-hidden />
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    <span className="min-w-0 flex-1 truncate">{r.amount} {tok(r.mint)}{r.label ? ` · ${r.label}` : ""} <span className={muted}>({r.cluster})</span></span>
                    {r.status === "paid" && r.payer && <span className={cx("text-xs", muted)}>from {shortAddr(r.payer, 4)}</span>}
                    {r.status === "pending" && <CopyButton text={r.url} label="Copy link" />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <SafetyCard api={api} />
    </div>
  );
}

/** The same report an agent gets from solana_token_safety. Works without an agent. */
function SafetyCard({ api }: { api: Api }) {
  const [mint, setMint] = useState("");
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!mint.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setReport((await getJson<{ report: SafetyReport }>(api, `token/safety/${encodeURIComponent(mint.trim())}`)).report);
    } catch (err) {
      setReport(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Token safety" description="Rug check a mainnet token: authorities, Token-2022 traps, concentration, and whether $1,000 can be sold back.">
      <form onSubmit={run} className="flex gap-2">
        <TextInput mono value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Mint address or symbol (BONK)" aria-label="Token mint" className="flex-1" />
        <Button type="submit" variant="primary" icon={ShieldAlert} loading={loading}>Check</Button>
      </form>
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
      {report && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{report.name ?? shortAddr(report.mint, 6)}{report.symbol ? ` (${report.symbol})` : ""}</span>
            <Badge tone={verdictTone[report.verdict]}>{report.verdict.replace(/-/g, " ")}</Badge>
            {report.market.verified && <Badge tone="success">Jupiter verified</Badge>}
          </div>
          <div className={cx("grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4", muted)}>
            <span>Price {usd(report.market.priceUsd)}</span>
            <span>Liquidity {usd(report.market.liquidityUsd)}</span>
            <span>$1k sell impact {report.market.sellImpactPctFor1k == null ? "—" : `${report.market.sellImpactPctFor1k.toFixed(2)}%`}</span>
            <span>Top 10 hold {report.facts.top10Pct == null ? "—" : `${report.facts.top10Pct}%`}</span>
          </div>
          {report.findings.length > 0 && (
            <ul className="space-y-1.5 text-sm">
              {report.findings.map((f) => (
                <li key={f.code + f.message} className="flex gap-2">
                  <Badge tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral"}>{f.severity}</Badge>
                  <span className="min-w-0">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
