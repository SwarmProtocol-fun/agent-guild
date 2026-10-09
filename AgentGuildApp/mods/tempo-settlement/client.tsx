"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Clock, Download, ExternalLink, LoaderCircle, RefreshCw, Send, ShieldCheck, Wallet, X, Zap } from "lucide-react";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { useEvmSender, type EvmChainParams } from "@/lib/wallet";

// ── Data from the server ─────────────────────────────────────────────────

interface Overview {
  network: string;
  chain: EvmChainParams;
  token: string | null;
  tokenSymbol: string | null;
  /** The connected wallet's balance of the payout token. */
  balance: number | null;
  missing: string[];
  error: string | null;
  orgs: { id: string; name: string; isOwner: boolean }[];
}

interface PayableJob {
  jobId: string;
  title: string;
  reward: string | null;
  suggestedUsdc: number | null;
  agentId: string;
  agentName: string | null;
  wallets: { address: string; label: string | null }[];
}

/** A transfer the owner's wallet has to send for one reserved job. */
interface Transfer {
  jobId: string;
  jobTitle?: string;
  to: string;
  amountUsdc: number;
  amountBase: string;
  memo: Hex;
}

interface Waiting extends Transfer { agentId: string; agentName: string | null; createdAt: string }

interface Payout {
  orgId: string;
  kind: "job" | "task";
  jobId?: string;
  jobTitle?: string;
  taskId?: string;
  agentId: string;
  agentName?: string;
  to: string;
  amountUsdc: number;
  status: "pending" | "paid";
  txSig?: string;
  explorerUrl?: string;
  paidBy: string;
  createdAt: string;
  paidAt?: string;
}

const TIP20 = parseAbi(["function transferWithMemo(address to, uint256 amount, bytes32 memo)"]);

/** Per-job choices in the "Ready to pay" list. */
interface Draft { selected: boolean; amount: string; to: string }

// ── Small UI pieces (shadcn CSS variables, so light/dark and skins just work) ──

const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(" ");
const muted = "text-[hsl(var(--muted-foreground))]";
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function Card({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[hsl(var(--border))]/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className={cx("mt-0.5 text-xs", muted)}>{description}</p>}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Button({ children, onClick, disabled, loading, primary, icon: Icon, type = "button" }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean; primary?: boolean;
  icon?: typeof Send; type?: "button" | "submit";
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled || loading}
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
        primary ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
          : "border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]",
      )}>
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : Icon && <Icon className="size-3.5" />}
      {children}
    </button>
  );
}

function Badge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warning" | "danger"; children: ReactNode }) {
  const tones = {
    neutral: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "bg-red-500/10 text-red-700 dark:text-red-400",
  };
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", tones[tone])}>{children}</span>;
}

function Notice({ tone, children }: { tone: "danger" | "warning" | "success"; children: ReactNode }) {
  const tones = {
    danger: "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400",
    warning: "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300",
    success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300",
  };
  return <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-lg border px-3 py-2 text-xs", tones[tone])}>{children}</div>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={cx("text-[11px] uppercase tracking-wide", muted)}>{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

const inputClass = "h-8 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

// ── Panel ────────────────────────────────────────────────────────────────

function PayoutsPanel({ api }: PanelProps) {
  const sender = useEvmSender();
  const payer = sender?.address ?? null;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [payable, setPayable] = useState<PayableJob[] | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [history, setHistory] = useState<Payout[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "danger" | "warning"; text: ReactNode } | null>(null);
  const [creatingWallet, setCreatingWallet] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  const org = overview?.orgs.find((o) => o.id === orgId) ?? null;
  const symbol = overview?.tokenSymbol ?? "USD";
  const configured = overview != null && overview.missing.length === 0;
  const paying = progress != null;
  const canPay = !!org?.isOwner && configured && !!sender && !paying;

  const loadOverview = useCallback(() => {
    api(`overview${payer ? `?payer=${encodeURIComponent(payer)}` : ""}`).then((r) => json<Overview>(r)).then((o) => {
      setOverview(o);
      setOrgId((cur) => cur ?? o.orgs.find((x) => x.isOwner)?.id ?? o.orgs[0]?.id ?? null);
    }).catch((e: Error) => setResult({ tone: "danger", text: e.message }));
  }, [api, payer]);

  const loadPayable = useCallback(() => {
    if (!orgId) return;
    api(`payable?orgId=${encodeURIComponent(orgId)}`).then((r) => json<{ jobs: PayableJob[]; waiting: Waiting[] }>(r)).then(({ jobs, waiting }) => {
      setPayable(jobs);
      setWaiting(waiting);
      setDrafts(Object.fromEntries(jobs.map((j) => [j.jobId, {
        selected: false,
        amount: j.suggestedUsdc != null ? String(j.suggestedUsdc) : "",
        to: j.wallets[0]?.address ?? "",
      }])));
    }).catch((e: Error) => { setPayable([]); setResult({ tone: "danger", text: e.message }); });
  }, [api, orgId]);

  const loadHistory = useCallback(() => {
    api("history").then((r) => json<{ payouts: Payout[] }>(r)).then((d) => setHistory(d.payouts.filter((p) => p.status === "paid"))).catch(() => setHistory([]));
  }, [api]);

  const refresh = useCallback(() => { loadPayable(); loadHistory(); loadOverview(); }, [loadPayable, loadHistory, loadOverview]);

  useEffect(() => { loadOverview(); loadHistory(); }, [loadOverview, loadHistory]);
  useEffect(() => { loadPayable(); }, [loadPayable]);

  const selected = useMemo(() => (payable ?? []).filter((j) => drafts[j.jobId]?.selected), [payable, drafts]);
  const total = selected.reduce((s, j) => s + (Number(drafts[j.jobId]?.amount) || 0), 0);
  const invalid = selected.some((j) => {
    const d = drafts[j.jobId];
    const n = Number(d.amount);
    return !d.to || !Number.isFinite(n) || n <= 0;
  });
  const overBalance = overview?.balance != null && total > overview.balance;

  const setDraft = (jobId: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [jobId]: { ...d[jobId], ...patch } }));

  async function createWallet(job: PayableJob) {
    if (!orgId) return;
    setCreatingWallet(job.agentId);
    try {
      const { address } = await json<{ address: string }>(await api("wallet", { method: "POST", body: JSON.stringify({ orgId, agentId: job.agentId }) }));
      // Every job by this agent can now be paid to the new wallet.
      setPayable((list) => list?.map((j) => (j.agentId === job.agentId ? { ...j, wallets: [{ address, label: "Tempo payouts" }] } : j)) ?? null);
      setDrafts((d) => Object.fromEntries(Object.entries(d).map(([id, dr]) => [id, (payable ?? []).find((j) => j.jobId === id)?.agentId === job.agentId ? { ...dr, to: address } : dr])));
    } catch (e) {
      setResult({ tone: "danger", text: (e as Error).message });
    } finally {
      setCreatingWallet(null);
    }
  }

  /** Ask the server to find this job's transfer on-chain; retries while the tx is still landing. */
  async function confirm(jobId: string, txHash?: string, attempts = 1): Promise<{ status: string; explorerUrl: string | null }> {
    for (let i = 0; ; i++) {
      const r = await json<{ status: string; explorerUrl: string | null }>(
        await api("payouts/confirm", { method: "POST", body: JSON.stringify({ orgId, jobId, txHash }) }),
      );
      if (r.status === "paid" || i + 1 >= attempts) return r;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }

  /** Send each transfer from the connected wallet, one wallet confirmation per job, and record it. */
  async function send(transfers: Transfer[], chain: EvmChainParams, token: string) {
    if (!sender) throw new Error("Connect an EVM wallet to pay from");
    let paid = 0;
    let lastUrl: string | null = null;
    for (const [i, t] of transfers.entries()) {
      setProgress(`Confirm ${transfers.length > 1 ? `payment ${i + 1} of ${transfers.length}` : "the payment"} in your wallet — ${t.jobTitle ?? t.jobId}`);
      const txHash = await sender.sendContractCall({
        to: token,
        chain,
        data: encodeFunctionData({ abi: TIP20, functionName: "transferWithMemo", args: [t.to as Hex, BigInt(t.amountBase), t.memo] }),
      });
      setProgress(`Waiting for Tempo to confirm ${t.jobTitle ?? t.jobId}…`);
      const r = await confirm(t.jobId, txHash, 20);
      if (r.status !== "paid") throw new Error(`${t.jobTitle ?? t.jobId} was sent but isn't on-chain yet. It's under "Waiting for payment" — press Check in a moment.`);
      paid++;
      lastUrl = r.explorerUrl;
    }
    return { paid, lastUrl };
  }

  async function run(fn: () => Promise<{ paid: number; lastUrl: string | null; totalUsdc: number }>) {
    setResult(null);
    try {
      const r = await fn();
      setResult({
        tone: "success",
        text: (
          <>
            Paid {r.paid} job{r.paid === 1 ? "" : "s"} · {money(r.totalUsdc)} {symbol} from your wallet.{" "}
            {r.lastUrl && <a href={r.lastUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">View on explorer</a>}
          </>
        ),
      });
    } catch (e) {
      const msg = (e as Error).message;
      const rejected = /reject|denied|cancel/i.test(msg);
      setResult({
        tone: rejected ? "warning" : "danger",
        text: rejected ? "You cancelled in your wallet. Anything not sent is under “Waiting for payment” — send it or cancel it there." : msg,
      });
    } finally {
      setProgress(null);
      refresh();
    }
  }

  function pay() {
    if (!orgId || selected.length === 0) return;
    return run(async () => {
      setProgress("Reserving jobs…");
      const items = selected.map((j) => ({ jobId: j.jobId, to: drafts[j.jobId].to, amountUsdc: Number(drafts[j.jobId].amount) }));
      const start = await json<{ token: string; chain: EvmChainParams; transfers: Transfer[] }>(
        await api("payouts/start", { method: "POST", body: JSON.stringify({ orgId, items }) }),
      );
      const r = await send(start.transfers, start.chain, start.token);
      return { ...r, totalUsdc: start.transfers.reduce((s, t) => s + t.amountUsdc, 0) };
    });
  }

  function resume(w: Waiting) {
    if (!overview?.token) return;
    return run(async () => {
      // The transfer may already have gone out — check before asking the wallet again.
      setProgress(`Checking Tempo for ${w.jobTitle ?? w.jobId}…`);
      const done = await confirm(w.jobId);
      if (done.status === "paid") return { paid: 1, lastUrl: done.explorerUrl, totalUsdc: w.amountUsdc };
      const r = await send([w], overview.chain, overview.token!);
      return { ...r, totalUsdc: w.amountUsdc };
    });
  }

  async function check(w: Waiting) {
    setBusyJob(w.jobId);
    try {
      const r = await confirm(w.jobId);
      setResult(r.status === "paid"
        ? { tone: "success", text: <>Found it — {w.jobTitle ?? w.jobId} is paid.</> }
        : { tone: "warning", text: <>No transfer for {w.jobTitle ?? w.jobId} on Tempo yet.</> });
      if (r.status === "paid") refresh();
    } catch (e) {
      setResult({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusyJob(null);
    }
  }

  async function cancel(w: Waiting) {
    setBusyJob(w.jobId);
    try {
      const r = await json<{ cancelled: boolean }>(await api("payouts/cancel", { method: "POST", body: JSON.stringify({ orgId, jobId: w.jobId }) }));
      setResult(r.cancelled
        ? { tone: "success", text: <>{w.jobTitle ?? w.jobId} is back in Ready to pay.</> }
        : { tone: "success", text: <>That payment had already gone out — {w.jobTitle ?? w.jobId} is marked paid.</> });
      refresh();
    } catch (e) {
      setResult({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusyJob(null);
    }
  }

  async function verify(txSig: string) {
    setVerifying(txSig);
    try {
      const d = await json<{ hashVerified: boolean }>(await api(`verify/${txSig}`));
      setVerified((v) => ({ ...v, [txSig]: d.hashVerified }));
    } catch (e) {
      setResult({ tone: "danger", text: (e as Error).message });
    } finally {
      setVerifying(null);
    }
  }

  async function exportCsv() {
    const blob = await (await api("export")).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tempo-payouts.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const ownerNote = !org ? null
    : !org.isOwner ? "Only the org owner can pay agents."
      : !sender ? "Connect an EVM wallet to pay from."
        : `Approved jobs not paid yet. Paid from your wallet, ${short(sender.address)}.`;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]"><Zap className="size-4" /></div>
          <div>
            <h1 className="text-lg font-semibold">Tempo payouts</h1>
            <p className={cx("max-w-2xl text-sm", muted)}>
              Pay your agents for approved jobs in stablecoins on Tempo, straight from your own wallet into each agent&apos;s wallet.
              Every payment carries a fingerprint of the job&apos;s delivery, so anyone can match it to the work on-chain.
            </p>
          </div>
        </div>
        {overview && overview.orgs.length > 1 && (
          <select aria-label="Organization" className={inputClass} value={orgId ?? ""} onChange={(e) => setOrgId(e.target.value)}>
            {overview.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </header>

      {/* Where the money comes from */}
      <section className="grid grid-cols-2 gap-4 rounded-xl border border-[hsl(var(--border))] p-4 sm:grid-cols-4">
        <Stat label="Paying from">
          {payer ? <span className="font-mono text-xs">{short(payer)}</span> : <span className={muted}>No EVM wallet connected</span>}
        </Stat>
        <Stat label="Your balance">
          {overview?.balance != null ? <span className="tabular-nums">{money(overview.balance)} {symbol}</span> : <span className={muted}>—</span>}
        </Stat>
        <Stat label="Token">{overview?.tokenSymbol ?? (overview?.token ? short(overview.token) : "—")}</Stat>
        <Stat label="Network">{overview ? <Badge tone="warning">{overview.network}</Badge> : "—"}</Stat>
      </section>

      {overview && overview.missing.length > 0 && (
        <Notice tone="warning">Payouts are off until the server has {overview.missing.join(" and ")} set.</Notice>
      )}
      {overview?.error && <Notice tone="warning">Couldn&apos;t reach Tempo: {overview.error}</Notice>}
      {progress && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs">
          <LoaderCircle className="size-3.5 animate-spin" /> {progress}
        </div>
      )}
      {result && !progress && <Notice tone={result.tone}>{result.text}</Notice>}

      {waiting.length > 0 && (
        <Card title="Waiting for payment" description="Reserved so they can't be paid twice, but not seen on Tempo yet. Send them, check again, or cancel to free the job.">
          <ul className="divide-y divide-[hsl(var(--border))]/60">
            {waiting.map((w) => (
              <li key={w.jobId} className="flex flex-wrap items-center gap-3 py-3">
                <Clock className={cx("size-4", muted)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{w.jobTitle ?? w.jobId}</div>
                  <div className={cx("text-xs", muted)}>
                    {money(w.amountUsdc)} {symbol} to {w.agentName ?? w.agentId} · <span className="font-mono">{short(w.to)}</span> · started {timeAgo(w.createdAt)}
                  </div>
                </div>
                <Button icon={RefreshCw} loading={busyJob === w.jobId} disabled={paying} onClick={() => check(w)}>Check</Button>
                {org?.isOwner && <Button icon={X} disabled={paying || busyJob != null} onClick={() => cancel(w)}>Cancel</Button>}
                {org?.isOwner && <Button primary icon={Send} disabled={!canPay || busyJob != null} onClick={() => resume(w)}>Send</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Ready to pay" description={ownerNote}>
        {!orgId ? (
          <p className={cx("text-sm", muted)}>You&apos;re not in an organization yet.</p>
        ) : payable == null ? (
          <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-[hsl(var(--muted))]" />)}</div>
        ) : payable.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <CheckCircle2 className={cx("size-6", muted)} />
            <p className="text-sm font-medium">Nothing waiting</p>
            <p className={cx("text-xs", muted)}>Jobs show up here once you approve an agent&apos;s delivery.</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-[hsl(var(--border))]/60">
              {payable.map((job) => {
                const d = drafts[job.jobId];
                if (!d) return null;
                const canEdit = !!org?.isOwner && configured && !paying;
                return (
                  <li key={job.jobId} className="flex flex-wrap items-center gap-3 py-3">
                    <input type="checkbox" aria-label={`Pay ${job.title}`} className="size-4 accent-[hsl(var(--primary))]"
                      checked={d.selected} disabled={!canEdit || job.wallets.length === 0}
                      onChange={(e) => setDraft(job.jobId, { selected: e.target.checked })} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{job.title}</div>
                      <div className={cx("text-xs", muted)}>
                        {job.agentName ?? job.agentId}{job.reward ? ` · reward “${job.reward}”` : ""}
                      </div>
                    </div>
                    {job.wallets.length === 0 ? (
                      <Button icon={Wallet} disabled={!org?.isOwner} loading={creatingWallet === job.agentId} onClick={() => createWallet(job)}>
                        Give agent a wallet to be paid into
                      </Button>
                    ) : (
                      <>
                        <select aria-label="Pay to" className={cx(inputClass, "font-mono")} value={d.to} disabled={!canEdit}
                          onChange={(e) => setDraft(job.jobId, { to: e.target.value })}>
                          {job.wallets.map((w) => <option key={w.address} value={w.address}>{short(w.address)}{w.label ? ` · ${w.label}` : ""}</option>)}
                        </select>
                        <label className="flex items-center gap-1">
                          <input aria-label="Amount" inputMode="decimal" placeholder="0.00" className={cx(inputClass, "w-24 text-right tabular-nums")}
                            value={d.amount} disabled={!canEdit}
                            onChange={(e) => setDraft(job.jobId, { amount: e.target.value, selected: d.selected || e.target.value !== "" })} />
                          <span className={cx("text-xs", muted)}>{symbol}</span>
                        </label>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            <footer className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t border-[hsl(var(--border))]/60 pt-3">
              {overBalance && <span className="text-xs text-red-600 dark:text-red-400">More than your wallet holds</span>}
              <span className={cx("text-xs tabular-nums", muted)}>
                {selected.length} selected · {money(total)} {symbol}
                {selected.length > 1 && " · one wallet confirmation each"}
              </span>
              <Button primary icon={Send} loading={paying} onClick={pay}
                disabled={!canPay || selected.length === 0 || invalid || overBalance}>
                {selected.length > 1 ? `Pay ${selected.length} jobs` : "Pay"}
              </Button>
            </footer>
          </>
        )}
      </Card>

      <Card title="Paid" description="Verify re-reads the transaction from Tempo and checks its memo matches the job's delivery fingerprint."
        actions={<Button icon={Download} onClick={exportCsv} disabled={!history?.length}>CSV</Button>}>
        {history == null ? (
          <div className="h-12 animate-pulse rounded-md bg-[hsl(var(--muted))]" />
        ) : history.length === 0 ? (
          <p className={cx("text-sm", muted)}>No payouts yet.</p>
        ) : (
          <ul className="divide-y divide-[hsl(var(--border))]/60">
            {history.map((p) => {
              const key = p.jobId ? `job:${p.jobId}` : `task:${p.agentId}:${p.taskId}`;
              const v = p.txSig ? verified[p.txSig] : undefined;
              const from = p.paidBy.startsWith("0x") ? short(p.paidBy) : null;
              return (
                <li key={key} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="truncate font-medium">{p.jobTitle ?? `Task ${p.taskId}`}</span>
                      <span className="font-mono tabular-nums">{money(p.amountUsdc)} {symbol}</span>
                      {v != null && <Badge tone={v ? "success" : "danger"}>{v ? "Receipt verified" : "Memo mismatch"}</Badge>}
                    </div>
                    <div className={cx("text-xs", muted)}>
                      {from && <>from <span className="font-mono">{from}</span> · </>}
                      to {p.agentName ?? p.agentId} (<span className="font-mono">{short(p.to)}</span>) · {timeAgo(p.paidAt ?? p.createdAt)}
                    </div>
                  </div>
                  {p.txSig && (
                    <div className="flex items-center gap-1">
                      <Button icon={ShieldCheck} loading={verifying === p.txSig} onClick={() => verify(p.txSig!)}>Verify</Button>
                      <a href={p.explorerUrl} target="_blank" rel="noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-[hsl(var(--primary))] hover:underline">
                        Explorer <ExternalLink className="size-3" />
                      </a>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default defineClientMod({ panels: { settlements: PayoutsPanel } });
