"use client";

import { useEffect, useState } from "react";
import { Coins, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Notice, PageHeader, Skeleton, Stat, TextInput, cx, muted, timeAgo, type SelectedAgent } from "./ui";

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  reputationUpdated: boolean;
  at: string;
}

interface SlashingEntry {
  proposalId: string;
  asn: string;
  agent: string;
  amount: number;
  reason: string;
  proposer: string;
  resolvedAt: number;
  proposalAddress: string;
}

interface ScoreEvent {
  signature: string;
  blockTime: number | null;
  payload: unknown;
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** GET → JSON, throwing the route's error message on a non-2xx. */
async function fetchJson<T>(api: Api, path: string, init?: RequestInit): Promise<T> {
  const r = await api(path, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
  return d as T;
}

/** USDC job payouts on Solana — the mod's original feature, now one tab of the Solana panel. */
export function SettlementTab({ api, agents }: { api: Api; agents: SelectedAgent[] }) {
  const nameOf = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id;
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [history, setHistory] = useState<SettlementRecord[] | null>(null);
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { hashVerified: boolean }>>({});

  const [asn, setAsn] = useState("");
  const [slashing, setSlashing] = useState<SlashingEntry[] | null>(null);
  const [events, setEvents] = useState<ScoreEvent[] | null>(null);
  const [asnLoading, setAsnLoading] = useState<"slashing" | "events" | null>(null);

  const [mintWallet, setMintWallet] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintResult, setMintResult] = useState<string | null>(null);

  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    fetchJson<{ history: SettlementRecord[] }>(api, "history")
      .then((d) => setHistory(d.history ?? []))
      .catch((err: Error) => { setHistory([]); setHistoryError(err.message); });
  }, [api]);

  /** Runs a lookup, surfacing its error in the card instead of failing silently. */
  async function lookup(fn: () => Promise<void>) {
    setLookupError(null);
    try { await fn(); } catch (err) { setLookupError((err as Error).message); }
  }

  const w = wallet.trim();
  const checkBalance = () => lookup(async () => setBalance((await fetchJson<{ usdc?: number }>(api, `balance/${encodeURIComponent(w)}`)).usdc ?? null));
  const checkRegistered = () => lookup(async () => setRegistered((await fetchJson<{ registered?: boolean }>(api, `registered/${encodeURIComponent(w)}`)).registered ?? null));

  async function verify(txSig: string) {
    setVerifying(txSig);
    await lookup(async () => {
      const d = await fetchJson<{ hashVerified: boolean }>(api, `verify/${txSig}`);
      setVerifyResult((prev) => ({ ...prev, [txSig]: d }));
    });
    setVerifying(null);
  }

  async function loadSlashing() {
    setAsnLoading("slashing");
    await lookup(async () => setSlashing((await fetchJson<{ history?: SlashingEntry[] }>(api, `slashing/${encodeURIComponent(asn.trim())}`)).history ?? []));
    setAsnLoading(null);
  }

  async function loadEvents() {
    setAsnLoading("events");
    await lookup(async () => setEvents((await fetchJson<{ events?: ScoreEvent[] }>(api, `events/${encodeURIComponent(asn.trim())}`)).events ?? []));
    setAsnLoading(null);
  }

  async function mintIdentity() {
    if (!mintWallet) return;
    setMinting(true);
    setMintResult(null);
    const r = await api("identity/mint", { method: "POST", body: JSON.stringify({ agentAddress: mintWallet }) });
    const d = await r.json();
    setMintResult(r.ok ? `✓ minted ${d.mint}` : `✗ ${d.error}`);
    setMinting(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={Coins} title="Payouts"
        description="When a job poster approves an agent's work, the agent is paid the job's dollar reward in USDC on Solana, with a receipt hash in an on-chain memo." />

      {lookupError && <Notice>{lookupError}</Notice>}

      <Card title="Recent payouts" description="Re-verify any receipt against what's actually on-chain.">
        {historyError && <div className="mb-3"><Notice>{historyError}</Notice></div>}
        {history == null ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : history.length === 0 ? (
          <EmptyState icon={Coins} title="No payouts yet">Once a job's poster approves the delivery, the agent that did it calls <code className="font-mono">solana_settle_job</code> (or <code className="font-mono">agent-guild settle &lt;jobId&gt;</code>) and is paid the job&apos;s dollar reward in USDC. Payouts appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]/60">
            {history.map((s) => {
              const v = verifyResult[s.txSig];
              return (
                <li key={s.txSig} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium" title={s.agentId}>{nameOf(s.agentId)}</span>
                      <span className="font-mono tabular-nums">${s.amountUsdc.toFixed(2)}</span>
                      <span className={cx("text-xs", muted)}>task {s.taskId} · {timeAgo(s.at)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone={s.reputationUpdated ? "success" : "neutral"}>{s.reputationUpdated ? "Reputation updated" : "Reputation not updated"}</Badge>
                      {v && <Badge tone={v.hashVerified ? "success" : "danger"} dot>{v.hashVerified ? "Receipt verified" : "Hash mismatch"}</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button className="h-8" icon={ShieldCheck} loading={verifying === s.txSig} onClick={() => verify(s.txSig)}>Verify</Button>
                    <a href={s.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md px-2 text-xs text-[hsl(var(--primary))] hover:underline">Explorer ↗</a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Wallet lookup" description="USDC balance and whether the wallet has an on-chain agent account.">
          <div className="space-y-3">
            <Field label="Wallet address" hint={agents.some((a) => a.wallets?.length) ? "Pick one of your agents' wallets or paste any address." : undefined}>{(id) => <TextInput id={id} mono placeholder="Agent wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} />}</Field>
            {agents.some((a) => a.wallets?.length) && (
              <div className="flex flex-wrap gap-1.5">
                {agents.flatMap((a) => (a.wallets ?? []).map((wl) => (
                  <button key={`${a.agentId}:${wl.address}`} type="button" title={wl.address}
                    onClick={() => { setWallet(wl.address); setBalance(null); setRegistered(null); }}
                    className={cx("rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-[hsl(var(--accent))]", wallet === wl.address ? "border-[hsl(var(--primary))]" : "border-[hsl(var(--border))]")}>
                    {a.name} · {wl.label ?? "wallet"}
                  </button>
                )))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={checkBalance} disabled={!wallet}>Check balance</Button>
              <Button onClick={checkRegistered} disabled={!wallet}>Check registration</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {balance != null && <Stat label="USDC" value={`$${balance.toFixed(2)}`} />}
              {registered != null && <Badge tone={registered ? "success" : "warning"} dot>{registered ? "Registered on-chain" : "Not registered — reputation won't update"}</Badge>}
            </div>
          </div>
        </Card>

      <details className="group rounded-xl border border-[hsl(var(--border))]">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">Advanced: reputation records &amp; identity tokens</summary>
        <div className="space-y-4 border-t border-[hsl(var(--border))] p-4">
        <Card title="ASN lookup" description="On-chain slashing history and score events for an agent serial number.">
          <div className="space-y-3">
            <Field label="ASN">{(id) => <TextInput id={id} mono placeholder="ASN-…" value={asn} onChange={(e) => setAsn(e.target.value)} />}</Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={loadSlashing} disabled={!asn} loading={asnLoading === "slashing"}>Slashing history</Button>
              <Button onClick={loadEvents} disabled={!asn} loading={asnLoading === "events"}>Score events</Button>
            </div>
            {slashing != null && (slashing.length === 0
              ? <p className={cx("text-xs", muted)}>No approved penalty proposals for this ASN.</p>
              : <ul className="space-y-1 text-xs">{slashing.map((p) => <li key={p.proposalAddress} className="text-red-600 dark:text-red-400">−{p.amount} credit · {p.reason} · {new Date(p.resolvedAt * 1000).toLocaleDateString()}</li>)}</ul>)}
            {events != null && (events.length === 0
              ? <p className={cx("text-xs", muted)}>No score events for this ASN.</p>
              : <CodeBlock title={`${events.length} score events`} code={events.map((e) => `${e.blockTime ? new Date(e.blockTime * 1000).toISOString() : "pending"}  ${JSON.stringify(e.payload)}`).join("\n")} maxHeight="max-h-48" />)}
          </div>
        </Card>

      <Card title="Soulbound identity token" description="Platform admins only. Mints a frozen SPL token to an agent wallet — irreversible and fee-paying.">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); mintIdentity(); }}>
          <Field label="Agent wallet" className="min-w-64 flex-1">{(id) => <TextInput id={id} mono placeholder="Wallet address" value={mintWallet} onChange={(e) => setMintWallet(e.target.value)} />}</Field>
          <Button type="submit" loading={minting} disabled={!mintWallet}>Mint</Button>
        </form>
        {mintResult && <div className="mt-3"><Notice tone={mintResult.startsWith("✓") ? "success" : "danger"}>{mintResult.replace(/^[✓✗] /, "")}</Notice></div>}
      </Card>
        </div>
      </details>
    </div>
  );
}
