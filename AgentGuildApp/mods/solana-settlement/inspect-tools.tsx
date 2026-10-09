"use client";

import { useEffect, useMemo, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import {
  Activity, Bug, Calculator, CircleCheck, CircleX, Coins, Download, Droplets, FileCode, Fingerprint, Gauge, Plus, Receipt, RefreshCw, Trash2, Wallet,
} from "lucide-react";
import {
  SEED_TYPES, PROGRAM_DATA_HEADER, TOKEN_PROGRAM,
  inspectAccount, inspectTransaction, walletHoldings, fetchIdl, derivePda, pdaSnippet,
  decodeProgramError, parseErrorCode, priorityFees, rentExempt, parsePubkey,
  type ClusterStatus, type AccountReport, type TxReport, type DecodedError,
  type PriorityFeeReport, type SeedSpec, type SeedType, type WalletHoldings,
} from "./devtools";
import {
  Addr, Badge, Button, Card, CodeBlock, CopyButton, EmptyState, ErrorNote, Examples, Field, Json, Notice, PageHeader, Row, Select, Skeleton, Stat,
  SubHeading, TextInput, ToolForm, cx, linkClass, logLineClass, muted, sol, timeAgo, useRunner, useSeededInput, type AgentSolanaWallet, type Env, type Seed,
} from "./ui";

// The read & debug tools. They talk to the RPC straight from the browser:
// that's what lets a developer point them at their own localnet validator.

const AGENT_GUILD_PROGRAM = "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci";

function ResultSkeleton() {
  return (
    <Card>
      <div className="space-y-3" aria-label="Loading">
        <Skeleton className="h-5 w-40" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        <Skeleton className="h-32" />
      </div>
    </Card>
  );
}

// ── Decoded program error ────────────────────────────────────────────────

const SOURCE_LABEL: Record<DecodedError["source"], string> = {
  system: "System Program",
  "spl-token": "SPL Token",
  "anchor-framework": "Anchor framework",
  "program-idl": "Program IDL",
  unknown: "Unknown source",
};

export function DecodedErrorView({ error, env }: { error: DecodedError & { instructionIndex?: number; programId?: string }; env: Env }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      <div className="flex items-start gap-2.5">
        <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{error.name ?? "Unknown error"}</span>
            {error.hex && <Badge tone="danger">{error.code} · {error.hex}</Badge>}
            <Badge>{SOURCE_LABEL[error.source]}</Badge>
          </div>
          {error.message && <p className="text-sm">{error.message}</p>}
          {(error.instructionIndex != null || error.programId) && (
            <div className={cx("flex flex-wrap items-center gap-x-2 text-xs", muted)}>
              {error.instructionIndex != null && <span>Instruction #{error.instructionIndex}</span>}
              {error.programId && <>· <Addr value={error.programId} env={env} /></>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Transaction ──────────────────────────────────────────────────────────

export function TxTool({ env, seed }: { env: Env; seed?: Seed }) {
  const r = useRunner<TxReport>();
  const lookup = (v: string) => r.run(() => inspectTransaction(env.conn, v));
  const [value, setValue] = useSeededInput(seed, lookup);
  const latest = useRunner<string>();
  const tx = r.data;

  async function loadLatest() {
    await latest.run(async () => {
      const source = env.agent?.devWallet ?? TOKEN_PROGRAM;
      const [sig] = await env.conn.getSignaturesForAddress(new PublicKey(source), { limit: 1 });
      if (!sig) throw new Error(`No transactions found on ${env.cluster}`);
      setValue(sig.signature);
      lookup(sig.signature);
      return sig.signature;
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={Receipt} title="Transaction" description="Why did it fail? Status, the program error decoded to its name, compute units, balance changes and full logs." />
      <ToolForm label="Signature" value={value} onChange={setValue} onSubmit={lookup} placeholder="5h3k…base58 signature" loading={r.loading} action="Inspect" />
      {r.error && <ErrorNote message={r.error} onRetry={() => lookup(value)} />}
      {r.loading && !tx && <ResultSkeleton />}
      {tx && !tx.found && (
        <Notice tone="warning" title={`Not found on ${env.cluster}`}>Check the cluster switcher — or the transaction is older than this RPC keeps.</Notice>
      )}
      {!tx && !r.loading && !r.error && (
        <EmptyState icon={Receipt} title="Paste a signature to inspect it">
          <div className="space-y-3">
            <p>Failed custom errors are decoded using the failing program&apos;s on-chain IDL.</p>
            <Button loading={latest.loading} onClick={loadLatest}>
              {env.agent?.devWallet ? `Open ${env.agent.name}'s latest transaction` : `Open the latest token transaction on ${env.cluster}`}
            </Button>
            {latest.error && <p className="text-red-600 dark:text-red-400">{latest.error}</p>}
          </div>
        </EmptyState>
      )}
      {tx?.found && (
        <>
          <Card>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {tx.success
                    ? <CircleCheck className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden />
                    : <CircleX className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden />}
                  <span className="font-semibold">{tx.success ? "Succeeded" : "Failed"}</span>
                  <Badge>{tx.version === "legacy" ? "legacy" : `v${tx.version}`}</Badge>
                  {tx.blockTime && <span className={cx("text-xs", muted)}>{timeAgo(tx.blockTime * 1000)}</span>}
                </div>
                <div className="flex items-center">
                  <CopyButton text={tx.signature} label="Copy signature" />
                  <a className={cx("text-xs", linkClass)} href={env.explorer("tx", tx.signature)} target="_blank" rel="noreferrer">Explorer ↗</a>
                </div>
              </div>
              {tx.error && <DecodedErrorView error={tx.error} env={env} />}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Compute units" value={tx.computeUnitsConsumed?.toLocaleString() ?? "—"} />
                <Stat label="Fee" value={tx.feeLamports != null ? `${tx.feeLamports.toLocaleString()}` : "—"} sub="lamports" />
                <Stat label="Slot" value={tx.slot?.toLocaleString()} />
                <Stat label="Time" value={tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleTimeString() : "—"} sub={tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleDateString() : undefined} />
              </div>
            </div>
          </Card>

          <Card title="Instructions" description={`${tx.instructions?.length ?? 0} top-level · signed by ${tx.signers?.length ?? 0}`}>
            <ol className="divide-y divide-[hsl(var(--border))]/60">
              {tx.instructions?.map((ix) => (
                <li key={ix.index} className={cx("flex flex-wrap items-center gap-2 py-2 text-sm", tx.error?.instructionIndex === ix.index && "rounded-md bg-red-500/5 px-2")}>
                  <span className={cx("w-6 font-mono text-xs", muted)}>#{ix.index}</span>
                  <Addr value={ix.programId} env={env} name={ix.programName} />
                  {ix.type && <Badge tone="info">{ix.type}</Badge>}
                  {ix.innerCount > 0 && <span className={cx("text-xs", muted)}>+{ix.innerCount} inner</span>}
                  {!ix.programName && <button type="button" className={cx("ml-auto text-xs", linkClass)} onClick={() => env.go("idl", ix.programId)}>View IDL</button>}
                </li>
              ))}
            </ol>
            <div className="mt-3 border-t border-[hsl(var(--border))]/60 pt-3">
              <SubHeading>Signers</SubHeading>
              <div className="flex flex-wrap gap-x-4">{tx.signers?.map((s) => <Addr key={s} value={s} env={env} />)}</div>
            </div>
          </Card>

          {((tx.balanceChanges?.length ?? 0) > 0 || (tx.tokenBalanceChanges?.length ?? 0) > 0) && (
            <Card title="Balance changes">
              <table className="w-full text-sm">
                <caption className="sr-only">Balance changes</caption>
                <tbody className="divide-y divide-[hsl(var(--border))]/60">
                  {tx.balanceChanges?.map((c) => (
                    <tr key={c.account}>
                      <td className="py-1.5"><Addr value={c.account} env={env} /></td>
                      <td className={cx("py-1.5 text-right font-mono text-xs tabular-nums", c.deltaLamports > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
                        {c.deltaLamports > 0 ? "+" : ""}{sol(c.deltaLamports)}
                      </td>
                    </tr>
                  ))}
                  {tx.tokenBalanceChanges?.map((c) => (
                    <tr key={`${c.account}:${c.mint}`}>
                      <td className="py-1.5"><Addr value={c.account} env={env} /> <span className={cx("text-xs", muted)}>mint</span> <Addr value={c.mint} env={env} /></td>
                      <td className={cx("py-1.5 text-right font-mono text-xs tabular-nums", c.delta.startsWith("-") ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400")}>{c.delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {(tx.logs?.length ?? 0) > 0 && <CodeBlock title={`Program logs · ${tx.logs!.length} lines`} code={tx.logs!.join("\n")} lineClass={logLineClass} maxHeight="max-h-96" />}
        </>
      )}
    </div>
  );
}

// ── Account ──────────────────────────────────────────────────────────────

// ── Agent wallets (Account tab, when acting as an agent) ────────────────

const TOKENS_SHOWN = 6;

type HoldingsState = { status: "loading" } | { status: "ready"; data: WalletHoldings } | { status: "error"; error: string };

function AgentWallets({ env, wallets }: { env: Env; wallets: AgentSolanaWallet[] }) {
  const [holdings, setHoldings] = useState<Record<string, HoldingsState>>({});
  const [nonce, setNonce] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setHoldings(Object.fromEntries(wallets.map((w) => [w.address, { status: "loading" } as HoldingsState])));
    // Each wallet resolves on its own so one slow or failing lookup doesn't hold up the rest.
    for (const w of wallets) {
      walletHoldings(env.conn, w.address)
        .then((data): HoldingsState => ({ status: "ready", data }))
        .catch((err: Error): HoldingsState => ({
          status: "error",
          error: /429|too many requests/i.test(err.message) ? "The RPC is rate-limiting requests — retry in a moment, or use a Custom RPC." : err.message,
        }))
        .then((next) => { if (!cancelled) setHoldings((h) => ({ ...h, [w.address]: next })); });
    }
    return () => { cancelled = true; };
  }, [env.conn, wallets, nonce]);

  const ready = Object.values(holdings).filter((h): h is Extract<HoldingsState, { status: "ready" }> => h.status === "ready");
  const totalLamports = ready.reduce((sum, h) => sum + h.data.lamports, 0);
  const loading = Object.values(holdings).some((h) => h.status === "loading");

  return (
    <Card
      title={`${env.agent!.name}'s wallets`}
      description={`${wallets.length} Solana wallet${wallets.length === 1 ? "" : "s"} on ${env.cluster}${ready.length ? ` · ${sol(totalLamports)} total` : ""}`}
      actions={<Button icon={RefreshCw} loading={loading} onClick={() => setNonce((n) => n + 1)}>Refresh</Button>}
    >
      <ul className="divide-y divide-[hsl(var(--border))]/60 rounded-lg border border-[hsl(var(--border))]">
        {wallets.map((w) => {
          const h = holdings[w.address];
          return (
            <li key={w.address} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{w.label ?? "Custodial wallet"}</span>
                <Badge tone={w.custodial ? "neutral" : "info"}>{w.custodial ? "Custodial" : "Identity"}</Badge>
                <span className="ml-auto text-sm font-medium tabular-nums">
                  {h?.status === "ready" ? sol(h.data.lamports) : h?.status === "error" ? <span className="text-red-600 dark:text-red-400">Unavailable</span> : <Skeleton className="inline-block h-4 w-20" />}
                </span>
              </div>
              <Addr value={w.address} env={env} />
              {h?.status === "error" && <ErrorNote message={h.error} onRetry={() => setNonce((n) => n + 1)} />}
              {h?.status === "ready" && h.data.tokens.length > 0 && (
                <ul className="space-y-1 rounded-md bg-[hsl(var(--muted))]/40 p-2">
                  {(expanded.has(w.address) ? h.data.tokens : h.data.tokens.slice(0, TOKENS_SHOWN)).map((t) => (
                    <li key={t.tokenAccount} className="flex items-center gap-2 text-xs">
                      <Coins className={cx("h-3.5 w-3.5 shrink-0", muted)} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {t.symbol ? <span className="font-medium">{t.symbol}</span> : <Addr value={t.mint} env={env} />}
                        {t.program === "spl-token-2022" && <span className="ml-1.5"><Badge>Token-2022</Badge></span>}
                      </span>
                      <span className="font-mono tabular-nums">{Number(t.uiAmount).toLocaleString(undefined, { maximumFractionDigits: t.decimals })}</span>
                    </li>
                  ))}
                  {h.data.tokens.length > TOKENS_SHOWN && (
                    <li>
                      <button type="button" className={cx("text-xs", linkClass)}
                        onClick={() => setExpanded((e) => { const next = new Set(e); if (!next.delete(w.address)) next.add(w.address); return next; })}>
                        {expanded.has(w.address) ? "Show fewer" : `Show all ${h.data.tokens.length} tokens`}
                      </button>
                    </li>
                  )}
                </ul>
              )}
              {h?.status === "ready" && h.data.tokens.length === 0 && <p className={cx("text-xs", muted)}>No tokens</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function AccountTool({ env, seed }: { env: Env; seed?: Seed }) {
  const r = useRunner<AccountReport>();
  const lookup = (v: string) => r.run(() => inspectAccount(env.conn, v, { decodeAnchor: true }));
  const [value, setValue] = useSeededInput(seed, lookup);
  const a = r.data;
  const agentWallets = env.agent?.wallets ?? [];
  const examples = [
    ...(agentWallets.length
      ? agentWallets.map((w) => ({ label: w.label ?? `Wallet ${w.address.slice(0, 4)}…`, value: w.address }))
      : env.agent?.devWallet ? [{ label: `${env.agent.name}'s wallet`, value: env.agent.devWallet }] : []),
    { label: "Agent Guild program", value: AGENT_GUILD_PROGRAM },
    { label: "SPL Token program", value: TOKEN_PROGRAM },
  ];

  return (
    <div className="space-y-4">
      <PageHeader icon={Wallet} title="Account" description="Balance, owner, rent status, token data, program upgrade authority — and Anchor accounts decoded with the owner's IDL." />
      {agentWallets.length > 0 && <AgentWallets env={env} wallets={agentWallets} />}
      <ToolForm label="Address" value={value} onChange={setValue} onSubmit={lookup} placeholder="Wallet, program, mint or PDA address" loading={r.loading} action="Inspect" examples={examples} />
      {r.error && <ErrorNote message={r.error} onRetry={() => lookup(value)} />}
      {r.loading && !a && <ResultSkeleton />}
      {a && !a.exists && <Notice tone="warning" title={`No account at this address on ${env.cluster}`}>It may not be created yet, or it lives on another cluster.</Notice>}
      {a?.exists && (
        <>
          <Card>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {a.executable ? <Badge tone="info">Program</Badge> : <Badge>Account</Badge>}
                {a.anchor && <Badge tone="info">Anchor · {a.anchor.accountType}</Badge>}
                <Badge tone={a.rentExempt ? "success" : "danger"} dot>{a.rentExempt ? "Rent exempt" : "Below rent exemption"}</Badge>
                {a.executable && <button type="button" className={cx("ml-auto text-xs", linkClass)} onClick={() => env.go("idl", a.address)}>View IDL →</button>}
              </div>
              <Addr value={a.address} env={env} full />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Balance" value={sol(a.lamports!)} sub={`${a.lamports!.toLocaleString()} lamports`} />
                <Stat label="Data" value={`${a.dataLength!.toLocaleString()} B`} sub={`rent-exempt min ${sol(a.rentExemptMinimum!)}`} />
                <Stat label="Owner" value={a.ownerName ?? "Program-owned"} sub={a.owner} />
              </div>
              <div>
                <Row label="Owner program"><Addr value={a.owner!} env={env} name={a.ownerName} /></Row>
                {a.program && (
                  <>
                    <Row label="Upgrade authority">
                      {a.program.upgradeAuthority ? <Addr value={a.program.upgradeAuthority} env={env} /> : <Badge tone="success">Immutable</Badge>}
                    </Row>
                    <Row label="ProgramData"><Addr value={a.program.programDataAddress} env={env} /></Row>
                    <Row label="Last deployed"><span className="font-mono text-xs">slot {a.program.lastDeploySlot.toLocaleString()}</span></Row>
                  </>
                )}
                {a.dataLength! > 0 && !a.parsed && !a.anchor && (
                  <Row label="Data (first 64 B)"><span className={cx("font-mono text-xs break-all", muted)}>{a.dataPreviewHex}</span></Row>
                )}
              </div>
            </div>
          </Card>
          {a.parsed != null && <Json value={a.parsed} title="Parsed data" />}
          {a.anchor?.decoded != null && <Json value={a.anchor.decoded} title={`Decoded ${a.anchor.accountType}`} />}
        </>
      )}
      {!a && !r.loading && !r.error && (
        <EmptyState icon={Wallet} title="Inspect any address">Paste a wallet, program, mint or PDA — or pick an example above. Programs show their upgrade authority; Anchor accounts are decoded.</EmptyState>
      )}
    </div>
  );
}

// ── Program IDL ──────────────────────────────────────────────────────────

/** Anchor <0.30 IDLs put name/version at the root and use isMut/isSigner; ≥0.30 uses metadata + writable/signer. */
type LooseIdl = Omit<Idl, "instructions"> & { name?: string; version?: string; instructions: { name: string; accounts: Record<string, unknown>[]; args: { name: string; type: unknown }[] }[] };

const typeLabel = (t: unknown): string => (typeof t === "string" ? t : JSON.stringify(t));

export function IdlTool({ env, seed }: { env: Env; seed?: Seed }) {
  const r = useRunner<{ programId: string; idl: LooseIdl | null }>();
  const lookup = (v: string) => r.run(async () => ({ programId: v.trim(), idl: (await fetchIdl(env.conn, v)) as LooseIdl | null }));
  const [value, setValue] = useSeededInput(seed, lookup);
  const [filter, setFilter] = useState("");
  const idl = r.data?.idl;
  const instructions = (idl?.instructions ?? []).filter((ix) => ix.name.toLowerCase().includes(filter.toLowerCase()));

  function download() {
    if (!idl) return;
    const blob = new Blob([JSON.stringify(idl, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${idl.metadata?.name ?? idl.name ?? r.data!.programId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={FileCode} title="Program IDL" description="The Anchor IDL a program published on-chain: instructions, accounts, types and error codes." />
      <ToolForm label="Program ID" value={value} onChange={setValue} onSubmit={lookup} placeholder="Program address" loading={r.loading} action="Fetch IDL"
        examples={[{ label: "Agent Guild program", value: AGENT_GUILD_PROGRAM }]} />
      {r.error && <ErrorNote message={r.error} onRetry={() => lookup(value)} />}
      {r.loading && !idl && <ResultSkeleton />}
      {r.data && !idl && (
        <Notice tone="warning" title={`No IDL published for this program on ${env.cluster}`}>
          Publish one from the workspace: <code className="font-mono">anchor idl init --filepath target/idl/&lt;program&gt;.json {r.data.programId}</code>
        </Notice>
      )}
      {!r.data && !r.loading && !r.error && (
        <EmptyState icon={FileCode} title="Fetch a program's interface">Anchor programs store their IDL in an on-chain account. Agents use it to build calls without hand-written client code.</EmptyState>
      )}
      {idl && (
        <>
          <Card
            title={<span className="flex items-center gap-2">{idl.metadata?.name ?? idl.name} <Badge>v{idl.metadata?.version ?? idl.version}</Badge>{idl.metadata?.spec && <Badge>spec {idl.metadata.spec}</Badge>}</span>}
            description={`${idl.instructions.length} instructions · ${idl.accounts?.length ?? 0} account types · ${idl.errors?.length ?? 0} errors`}
            actions={<><CopyButton text={JSON.stringify(idl, null, 2)} label="Copy IDL JSON" /><Button icon={Download} onClick={download}>Download</Button></>}
          >
            <Field label="Filter instructions">
              {(id) => <TextInput id={id} placeholder="e.g. initialize" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            </Field>
            <div className="mt-3 divide-y divide-[hsl(var(--border))]/60 rounded-lg border border-[hsl(var(--border))]">
              {instructions.map((ix) => (
                <details key={ix.name} className="group px-3 py-2">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-sm">
                    <span className="font-mono font-medium">{ix.name}</span>
                    <span className={cx("text-xs", muted)}>{ix.accounts.length} accounts · {ix.args.length} args <span className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span></span>
                  </summary>
                  <div className="mt-2 grid gap-3 pb-1 sm:grid-cols-2">
                    <div>
                      <SubHeading>Accounts</SubHeading>
                      <ul className="space-y-1 text-xs">
                        {ix.accounts.map((acc, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono">{String(acc.name)}</span>
                            {Boolean(acc.writable ?? acc.isMut) && <Badge tone="warning">mut</Badge>}
                            {Boolean(acc.signer ?? acc.isSigner) && <Badge tone="info">signer</Badge>}
                            {acc.pda != null && <Badge>pda</Badge>}
                            {typeof acc.address === "string" && <Badge>fixed</Badge>}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <SubHeading>Args</SubHeading>
                      {ix.args.length === 0 ? <p className={cx("text-xs", muted)}>None</p> : (
                        <ul className="space-y-1 font-mono text-xs">
                          {ix.args.map((arg) => <li key={arg.name}>{arg.name}: <span className="text-[hsl(var(--primary))]">{typeLabel(arg.type)}</span></li>)}
                        </ul>
                      )}
                    </div>
                  </div>
                </details>
              ))}
              {instructions.length === 0 && <p className={cx("px-3 py-4 text-center text-xs", muted)}>No instruction matches “{filter}”.</p>}
            </div>
          </Card>
          {(idl.errors?.length ?? 0) > 0 && (
            <Card title="Error codes">
              <table className="w-full text-xs">
                <thead><tr className={cx("text-left", muted)}><th className="pb-2 font-medium">Code</th><th className="pb-2 font-medium">Name</th><th className="pb-2 font-medium">Message</th></tr></thead>
                <tbody className="divide-y divide-[hsl(var(--border))]/60">
                  {idl.errors!.map((e) => (
                    <tr key={e.code}>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{e.code} <span className={muted}>0x{e.code.toString(16)}</span></td>
                      <td className="py-1.5 pr-3 font-mono">{e.name}</td>
                      <td className={cx("py-1.5", muted)}>{e.msg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── PDA ──────────────────────────────────────────────────────────────────

const SEED_PLACEHOLDER: Record<SeedType, string> = {
  string: "utf-8 text", pubkey: "base58 address", hex: "0x…", u8: "0–255", u16: "integer", u32: "integer", u64: "integer", i64: "integer",
};

export function PdaTool({ env }: { env: Env }) {
  const [programId, setProgramId] = useState("");
  const [seeds, setSeeds] = useState<SeedSpec[]>([{ type: "string", value: "" }]);
  const exists = useRunner<AccountReport>();

  // Pure derivation — recompute on every keystroke, no RPC.
  const derived = useMemo(() => {
    if (!programId.trim()) return null;
    try {
      return { ok: true as const, ...derivePda(programId, seeds) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, [programId, seeds]);

  const update = (i: number, patch: Partial<SeedSpec>) => setSeeds((s) => s.map((seed, j) => (j === i ? { ...seed, ...patch } : seed)));
  const example = () => {
    setProgramId(AGENT_GUILD_PROGRAM);
    setSeeds([{ type: "string", value: "agent" }, { type: "pubkey", value: env.agent?.devWallet ?? "B6zYAuTbuJngzhfKATyFk8P465YeftU5Bsnb9WVxV7R" }]);
  };

  return (
    <div className="space-y-4">
      <PageHeader icon={Fingerprint} title="PDA" description="Derive a program-derived address from typed seeds. Integers are little-endian, like Rust's to_le_bytes()." />
      <Card>
        <div className="space-y-4">
          <Field label="Program ID">{(id) => <TextInput id={id} mono placeholder="Program address" value={programId} onChange={(e) => setProgramId(e.target.value)} />}</Field>
          <div className="space-y-2">
            <div className="text-xs font-medium">Seeds</div>
            {seeds.map((seed, i) => (
              <div key={i} className="flex gap-2">
                <span className={cx("flex h-9 w-6 shrink-0 items-center justify-center font-mono text-xs", muted)}>{i + 1}</span>
                <Select value={seed.type} onChange={(e) => update(i, { type: e.target.value as SeedType })} aria-label={`Seed ${i + 1} type`} className="w-28">
                  {SEED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
                <TextInput mono aria-label={`Seed ${i + 1} value`} placeholder={SEED_PLACEHOLDER[seed.type]} value={seed.value} onChange={(e) => update(i, { value: e.target.value })} />
                <Button aria-label={`Remove seed ${i + 1}`} icon={Trash2} variant="ghost" className="w-9 px-0" onClick={() => setSeeds((s) => s.filter((_, j) => j !== i))} disabled={seeds.length === 1} />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button icon={Plus} variant="ghost" onClick={() => setSeeds((s) => [...s, { type: "string", value: "" }])} disabled={seeds.length >= 15}>Add seed</Button>
              <Examples items={[{ label: "Agent Guild agent PDA", value: "x" }]} onPick={example} />
            </div>
          </div>
        </div>
      </Card>
      {derived && !derived.ok && <Notice tone="warning">{derived.error}</Notice>}
      {!derived && <EmptyState icon={Fingerprint} title="Enter a program ID to start">The address updates live as you edit seeds — nothing is sent to the network until you check it.</EmptyState>}
      {derived?.ok && (
        <Card title="Derived address" actions={
          <>
            <Button loading={exists.loading} onClick={() => exists.run(() => inspectAccount(env.conn, derived.address))}>Check on {env.cluster}</Button>
            <Button variant="primary" onClick={() => env.go("account", derived.address)}>Inspect</Button>
          </>
        }>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Addr value={derived.address} env={env} full />
              <Badge tone="info">bump {derived.bump}</Badge>
              {exists.data && (exists.data.exists
                ? <Badge tone="success" dot>Initialized · {exists.data.dataLength} B · {exists.data.ownerName ?? "program-owned"}</Badge>
                : <Badge dot>Not initialized</Badge>)}
            </div>
            {exists.error && <ErrorNote message={exists.error} />}
            <div>
              <SubHeading>Seed bytes</SubHeading>
              <ol className="space-y-1">
                {derived.seedsHex.map((h, i) => <li key={i} className="font-mono text-xs break-all"><span className={muted}>{i + 1}.</span> {h || <span className={muted}>(empty)</span>}</li>)}
              </ol>
            </div>
            <CodeBlock title="TypeScript" code={pdaSnippet(programId.trim(), seeds)} />
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Errors ───────────────────────────────────────────────────────────────

export function ErrorTool({ env, seed }: { env: Env; seed?: Seed }) {
  const [programId, setProgramId] = useState("");
  const r = useRunner<DecodedError & { programId?: string }>();
  const lookup = (v: string, pidOverride?: string) =>
    r.run(async () => {
      const code = parseErrorCode(v);
      const pid = (pidOverride ?? programId).trim() || null;
      if (pid) parsePubkey(pid, "program id");
      const idl = pid && code >= 6000 ? await fetchIdl(env.conn, pid).catch(() => null) : null;
      return { ...decodeProgramError(code, pid, idl), ...(pid ? { programId: pid } : {}) };
    });
  const [value, setValue] = useSeededInput(seed, lookup);
  const examples: { label: string; code: string; program?: string }[] = [
    { label: "0x7d6 · ConstraintSeeds", code: "0x7d6" },
    { label: "0x1 · Token InsufficientFunds", code: "0x1", program: TOKEN_PROGRAM },
    { label: "6020 · Agent Guild", code: "6020", program: AGENT_GUILD_PROGRAM },
  ];

  return (
    <div className="space-y-4">
      <PageHeader icon={Bug} title="Errors" description={<>Turn <code className="font-mono">custom program error: 0x1771</code> into a name and message.</>} />
      <Card>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (value.trim()) lookup(value); }}>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <Field label="Error code or log line">{(id) => <TextInput id={id} mono placeholder="0x1771 · 6001 · custom program error: 0x7d3" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Field label="Program ID (optional)" hint="Needed for System/Token errors and 6000+ codes from your IDL.">
              {(id) => <TextInput id={id} mono placeholder="Program that returned it" value={programId} onChange={(e) => setProgramId(e.target.value)} />}
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cx("text-xs", muted)}>Try</span>
              {examples.map((ex) => (
                <button key={ex.label} type="button" onClick={() => { setValue(ex.code); setProgramId(ex.program ?? ""); lookup(ex.code, ex.program ?? ""); }}
                  className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs transition-colors hover:border-[hsl(var(--primary))]/50 hover:bg-[hsl(var(--primary))]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]">
                  {ex.label}
                </button>
              ))}
            </div>
            <Button type="submit" variant="primary" loading={r.loading} disabled={!value.trim()} icon={Bug}>Decode</Button>
          </div>
        </form>
      </Card>
      {r.error && <ErrorNote message={r.error} />}
      {r.data && <DecodedErrorView error={r.data} env={env} />}
      <Card title="Where codes come from">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[["100–1999", "Anchor instruction / IDL"], ["2000–2999", "Anchor constraints"], ["3000–3999", "Anchor accounts"], ["4100+", "Anchor misc"], ["6000+", "Your #[error_code]"]].map(([range, what]) => (
            <Stat key={range} label={range} wrap value={<span className="font-sans text-xs">{what}</span>} />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ── Network ──────────────────────────────────────────────────────────────

export function NetworkTool({ env, status, address }: { env: Env; status: ClusterStatus | null; address: string | null }) {
  const fees = useRunner<PriorityFeeReport>();
  const [feeAccounts, setFeeAccounts] = useState("");
  const rent = useRunner<{ bytes: number; lamports: number; sol: number }>();
  const [bytes, setBytes] = useState("165");
  const [isProgram, setIsProgram] = useState(false);
  const airdrop = useRunner<string>();
  const [dropTo, setDropTo] = useState(() => {
    try { return address ? parsePubkey(address).toBase58() : ""; } catch { return ""; }
  });
  const [dropAmount, setDropAmount] = useState("1");
  // The agent list loads after mount — fill the recipient once its wallet is known, unless the user typed one.
  useEffect(() => {
    if (!address) return;
    try { const pk = parsePubkey(address).toBase58(); setDropTo((cur) => cur || pk); } catch { /* not a Solana address */ }
  }, [address]);
  const canAirdrop = env.cluster !== "mainnet-beta";

  async function requestAirdrop() {
    await airdrop.run(async () => {
      const amount = Number(dropAmount);
      if (!(amount > 0 && amount <= 5)) throw new Error("Amount must be between 0 and 5 SOL");
      const sig = await env.conn.requestAirdrop(parsePubkey(dropTo), Math.round(amount * LAMPORTS_PER_SOL));
      const latest = await env.conn.getLatestBlockhash();
      await env.conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      return sig;
    });
  }

  const priorityCost = (microLamportsPerCu: number, cu = 200_000) => Math.ceil((microLamportsPerCu * cu) / 1_000_000);

  return (
    <div className="space-y-4">
      <PageHeader icon={Activity} title="Network" description={`Cluster health, priority fees, rent and faucet for ${env.cluster}.`} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {status ? (
          <>
            <Stat label="Version" value={status.version} />
            <Stat label="Slot" value={status.slot.toLocaleString()} sub={`block ${status.blockHeight.toLocaleString()}`} />
            <Stat label="Epoch" value={status.epoch} sub={`${status.epochProgressPct}% complete`} />
            <Stat label="TPS" value={status.tps?.toLocaleString() ?? "—"} sub={status.nonVoteTps != null ? `${status.nonVoteTps.toLocaleString()} non-vote` : undefined} />
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px]" />)}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Gauge className="h-4 w-4" aria-hidden />Priority fees</span>} description="Recent fees in µ-lamports per CU. Scope to the writable accounts your tx touches.">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); fees.run(() => priorityFees(env.conn, feeAccounts.split(/[\s,]+/).filter(Boolean))); }}>
            <Field label="Writable accounts (optional)">
              {(id) => <TextInput id={id} mono placeholder="Comma-separated addresses" value={feeAccounts} onChange={(e) => setFeeAccounts(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" loading={fees.loading}>Sample fees</Button>
          </form>
          {fees.error && <div className="mt-3"><ErrorNote message={fees.error} /></div>}
          {fees.data && (
            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-5 gap-1.5">
                {(["min", "p50", "p75", "p90", "max"] as const).map((k) => (
                  <div key={k} className={cx("rounded-md border border-[hsl(var(--border))] px-2 py-1.5 text-center", k === "p75" && "border-[hsl(var(--primary))]/50 bg-[hsl(var(--primary))]/5")}>
                    <div className={cx("text-[10px] font-medium uppercase", muted)}>{k}</div>
                    <div className="font-mono text-xs tabular-nums">{fees.data![k].toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <p className={cx("text-xs", muted)}>
                p75 ≈ {priorityCost(fees.data.p75).toLocaleString()} lamports at 200k CU · {fees.data.slots} slots, {Math.round(fees.data.zeroFeeShare * 100)}% paid nothing.
                Set the CU limit to what your tx uses to pay less.
              </p>
            </div>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><Calculator className="h-4 w-4" aria-hidden />Rent</span>} description="Lamports to keep an account rent-exempt.">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); rent.run(() => rentExempt(env.conn, Number(bytes) + (isProgram ? PROGRAM_DATA_HEADER : 0))); }}>
            <Field label="Account size (bytes)">
              {(id) => <TextInput id={id} mono inputMode="numeric" value={bytes} onChange={(e) => setBytes(e.target.value.replace(/\D/g, ""))} />}
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {([["Token account", 165], ["Mint", 82], ["Anchor discriminator", 8]] as const).map(([label, n]) => (
                <button key={label} type="button" onClick={() => { setBytes(String(n)); setIsProgram(false); }}
                  className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]">{label} · {n}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={isProgram} onChange={(e) => setIsProgram(e.target.checked)} />
              This is a program .so size (adds the {PROGRAM_DATA_HEADER}-byte ProgramData header)
            </label>
            <Button type="submit" variant="primary" loading={rent.loading} disabled={!bytes}>Calculate</Button>
          </form>
          {rent.error && <div className="mt-3"><ErrorNote message={rent.error} /></div>}
          {rent.data && <div className="mt-4"><Stat label={`${rent.data.bytes.toLocaleString()} bytes`} value={sol(rent.data.lamports)} sub={`${rent.data.lamports.toLocaleString()} lamports`} /></div>}
        </Card>
      </div>

      <Card title={<span className="flex items-center gap-2"><Droplets className="h-4 w-4" aria-hidden />Faucet</span>}
        description={canAirdrop ? "Requested from your browser, so the faucet limit is yours, not the server's." : "Airdrops don't exist on mainnet."}>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); requestAirdrop(); }}>
          <Field label="Recipient" className="min-w-64 flex-1">
            {(id) => <TextInput id={id} mono placeholder="Address" value={dropTo} onChange={(e) => setDropTo(e.target.value)} disabled={!canAirdrop} />}
          </Field>
          <Field label="SOL" className="w-24">
            {(id) => <TextInput id={id} mono inputMode="decimal" value={dropAmount} onChange={(e) => setDropAmount(e.target.value)} disabled={!canAirdrop} />}
          </Field>
          <Button type="submit" variant="primary" icon={Droplets} loading={airdrop.loading} disabled={!canAirdrop || !dropTo}>Airdrop</Button>
        </form>
        {airdrop.error && (
          <div className="mt-3">
            <Notice title="Airdrop failed">
              {airdrop.error}{/429|limit|faucet/i.test(airdrop.error) && <> — the public faucet is rate-limited. Try <a className={linkClass} href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a> or a smaller amount.</>}
            </Notice>
          </div>
        )}
        {airdrop.data && (
          <div className="mt-3">
            <Notice tone="success" title="Airdrop confirmed" action={<Button className="h-7 px-2 text-xs" onClick={() => env.go("tx", airdrop.data!)}>View tx</Button>} />
          </div>
        )}
      </Card>
    </div>
  );
}
