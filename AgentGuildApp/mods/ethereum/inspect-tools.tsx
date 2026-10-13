"use client";

import { useCallback, useState, type FormEvent } from "react";
import { ArrowRight, Binary, BookOpen, CheckCircle2, Clock, Fuel, Receipt, Wallet, XCircle } from "lucide-react";
import {
  Addr, Badge, Button, Card, CodeBlock, Field, Json, Notice, PageHeader, Row, Skeleton, Stat, TextInput, ToolForm, amt, cx, json, mono, muted, timeAgo, usd,
  useRunner, useSeededInput, type Env, type Seed,
} from "./ui";
import { NETWORKS } from "./networks";

// Read & debug views. Every request is a session read through this mod's
// server routes (?network=…), so they work without an agent.

// ── Shapes returned by the server ────────────────────────────────────────

interface Revert { kind: string; selector: string | null; message: string; signature?: string; args?: unknown[]; raw: string }
interface Call { selector: string; signature: string | null; functionName: string | null; args: unknown[] | null; candidates: string[] }
interface Log { index: number; address: string; event: string | null; args: Record<string, unknown> | null; amount?: string; symbol?: string | null; topics: string[] }
interface Tx {
  hash: string; status: "success" | "reverted" | "pending"; blockNumber: string | null; timestamp: string | null;
  from: string; to: string | null; contractAddress: string | null; valueEth: string; nonce: number; gasLimit: string; gasUsed: string | null;
  effectiveGasPriceGwei: string | null; feeEth: string | null; type: string; call: Call | null; revert: Revert | null; logs: Log[];
}
interface Account {
  address: string; balanceEth: string; nonce: number; isContract: boolean; codeSize: number;
  proxy: { implementation: string | null; admin: string | null } | null;
  token: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null } | null;
  ensName: string | null;
}
interface Holding { symbol: string; token: string | null; amount: string }

const q = (env: Env) => `network=${env.network}`;

export function RevertNotice({ revert, title = "Reverted" }: { revert: Revert; title?: string }) {
  return (
    <Notice title={title}>
      <span className="font-mono">{revert.message}</span>
      {revert.signature && revert.kind === "custom" && <span className={cx("ml-1", muted)}>· {revert.signature}</span>}
    </Notice>
  );
}

export function CallView({ call }: { call: Call }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={call.functionName ? "info" : "neutral"}>{call.functionName ?? "unknown function"}</Badge>
        <span className={mono}>{call.selector}</span>
        {call.signature && <span className={cx("font-mono text-xs", muted)}>{call.signature}</span>}
      </div>
      {call.args && call.args.length > 0 && <Json value={call.args} title="Arguments" />}
      {!call.functionName && call.candidates.length > 0 && <p className={cx("text-xs", muted)}>Candidates that didn&apos;t decode: {call.candidates.join(", ")}</p>}
    </div>
  );
}

// ── Transaction ──────────────────────────────────────────────────────────

export function TxTool({ env, seed }: { env: Env; seed?: Seed }) {
  const { loading, error, data, run } = useRunner<{ tx: Tx; explorerUrl: string }>();
  const go = useCallback((hash: string) => run(() => json(env.api(`dev/tx/${hash}?${q(env)}`))), [env, run]);
  const [value, setValue] = useSeededInput(seed, go);
  const tx = data?.tx;
  const StatusIcon = tx?.status === "success" ? CheckCircle2 : tx?.status === "reverted" ? XCircle : Clock;

  return (
    <div className="space-y-4">
      <PageHeader icon={Receipt} title="Transaction" description={`Decoded call, token transfers, fees and — for a failed tx — the revert reason, replayed on ${NETWORKS[env.network].label}.`} />
      <ToolForm label="Transaction hash" value={value} onChange={setValue} onSubmit={go} placeholder="0x…" loading={loading} action="Inspect" />
      {error && <Notice>{error}</Notice>}
      {loading && !tx && <Skeleton className="h-64" />}
      {tx && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3">
              <StatusIcon className={cx("h-6 w-6", tx.status === "success" ? "text-green-600 dark:text-green-400" : tx.status === "reverted" ? "text-red-600 dark:text-red-400" : muted)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold capitalize">{tx.status}</span>
                  {tx.call?.functionName && <Badge tone="info">{tx.call.functionName}</Badge>}
                  {tx.contractAddress && <Badge tone="success">contract created</Badge>}
                </div>
                <div className={cx("text-xs", muted)}>{tx.blockNumber ? `Block ${Number(tx.blockNumber).toLocaleString()}` : "Not mined yet"}{tx.timestamp && ` · ${timeAgo(tx.timestamp)}`}</div>
              </div>
              <a href={data.explorerUrl} target="_blank" rel="noreferrer" className="text-sm text-[hsl(var(--primary))] hover:underline">Explorer ↗</a>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Value" value={`${amt(tx.valueEth, 8)} ETH`} />
              <Stat label="Fee" value={tx.feeEth ? `${amt(tx.feeEth, 8)} ETH` : "—"} sub={tx.effectiveGasPriceGwei ? `${amt(tx.effectiveGasPriceGwei, 4)} gwei` : undefined} />
              <Stat label="Gas used" value={tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : "—"} sub={`limit ${Number(tx.gasLimit).toLocaleString()}`} />
              <Stat label="Nonce" value={tx.nonce} sub={`type ${tx.type}`} />
            </div>
          </Card>
          {tx.revert && <RevertNotice revert={tx.revert} />}
          <Card title="Details">
            <Row label="From"><Addr value={tx.from} env={env} /></Row>
            <Row label="To">{tx.to ? <Addr value={tx.to} env={env} /> : <span className={muted}>Contract creation</span>}</Row>
            {tx.contractAddress && <Row label="Created"><Addr value={tx.contractAddress} env={env} /></Row>}
            <Row label="Hash"><span className={mono}>{tx.hash}</span></Row>
          </Card>
          {tx.call && <Card title="Call"><CallView call={tx.call} /></Card>}
          <Card title={`Logs (${tx.logs.length})`} description="ERC-20 Transfer and Approval are decoded; other events show their topics.">
            {tx.logs.length === 0 ? <p className={cx("text-sm", muted)}>No events.</p> : (
              <ol className="divide-y divide-[hsl(var(--border))]/60">
                {tx.logs.map((l) => (
                  <li key={l.index} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx("w-6 font-mono text-xs", muted)}>#{l.index}</span>
                      <Badge tone={l.event ? "info" : "neutral"}>{l.event ?? "event"}</Badge>
                      <Addr value={l.address} env={env} name={l.symbol ?? undefined} />
                    </div>
                    {l.event && l.args ? (
                      <div className="ml-8 mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <Addr value={String(l.args.from ?? l.args.owner)} env={env} />
                        <ArrowRight className={cx("h-3 w-3", muted)} aria-hidden />
                        <Addr value={String(l.args.to ?? l.args.spender)} env={env} />
                        <span className="font-mono">{l.amount != null ? `${amt(l.amount)} ${l.symbol ?? ""}` : String(l.args.value)}</span>
                      </div>
                    ) : (
                      <div className={cx("ml-8 mt-1 space-y-0.5", mono, muted)}>{l.topics.map((t) => <div key={t}>{t}</div>)}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Address ──────────────────────────────────────────────────────────────

export function AddressTool({ env, seed, fallback }: { env: Env; seed?: Seed; fallback?: string | null }) {
  const { loading, error, data, run } = useRunner<{ account: Account; holdings: Holding[]; explorerUrl: string }>();
  const go = useCallback((address: string) => run(async () => {
    const enc = encodeURIComponent(address);
    const [a, h] = await Promise.all([
      json<{ account: Account; explorerUrl: string }>(env.api(`dev/address/${enc}?${q(env)}`)),
      json<{ holdings: { tokens: Holding[] } }>(env.api(`dev/holdings/${enc}?${q(env)}`)).catch(() => ({ holdings: { tokens: [] } })),
    ]);
    return { ...a, holdings: h.holdings.tokens };
  }), [env, run]);
  const [value, setValue] = useSeededInput(seed, go);
  const a = data?.account;

  return (
    <div className="space-y-4">
      <PageHeader icon={Wallet} title="Address" description="Balance, token holdings, contract code, proxy slots, ERC-20 metadata and ENS." />
      <ToolForm label="Address or ENS name" value={value} onChange={setValue} onSubmit={go} placeholder="0x… or vitalik.eth" loading={loading} action="Inspect"
        examples={[
          ...(fallback && /^0x/.test(fallback) ? [{ label: "My wallet", value: fallback }] : []),
          ...(env.network === "mainnet" ? [{ label: "vitalik.eth", value: "vitalik.eth" }, { label: "USDC", value: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }] : []),
        ]} />
      {error && <Notice>{error}</Notice>}
      {loading && !a && <Skeleton className="h-48" />}
      {a && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Addr value={a.address} env={env} full />
              <Badge tone={a.isContract ? "info" : "neutral"}>{a.isContract ? "Contract" : "Account"}</Badge>
              {a.proxy && <Badge tone="warning">Proxy</Badge>}
              {a.ensName && <Badge tone="success">{a.ensName}</Badge>}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Balance" value={`${amt(a.balanceEth, 6)} ETH`} />
              <Stat label="Nonce" value={a.nonce} />
              <Stat label="Code" value={a.isContract ? `${a.codeSize.toLocaleString()} bytes` : "none"} />
            </div>
          </Card>
          {a.proxy && (
            <Card title="Proxy" description="Implementation and admin from the EIP-1967 (or older ZeppelinOS) storage slots.">
              <Row label="Implementation">{a.proxy.implementation ? <Addr value={a.proxy.implementation} env={env} /> : <span className={muted}>unset</span>}</Row>
              <Row label="Admin">{a.proxy.admin ? <Addr value={a.proxy.admin} env={env} /> : <span className={muted}>unset</span>}</Row>
            </Card>
          )}
          {a.token && (
            <Card title="Token">
              <Row label="Name">{a.token.name ?? "—"}</Row>
              <Row label="Symbol">{a.token.symbol}</Row>
              <Row label="Decimals">{a.token.decimals}</Row>
              <Row label="Total supply"><span className="font-mono text-xs">{a.token.totalSupply ? amt(a.token.totalSupply, 2) : "—"}</span></Row>
              <div className="mt-3"><Button className="h-8" icon={BookOpen} onClick={() => env.go("read", a.address)}>Read this contract</Button></div>
            </Card>
          )}
          <Card title="Holdings" description="Well-known tokens on this network with a non-zero balance.">
            {data.holdings.length === 0 ? <p className={cx("text-sm", muted)}>None of the tracked tokens.</p> : (
              <ul className="divide-y divide-[hsl(var(--border))]/60">
                {data.holdings.map((h) => (
                  <li key={h.token ?? h.symbol} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-medium">{h.symbol}</span>
                    <span className="font-mono text-xs tabular-nums">{amt(h.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Read contract ────────────────────────────────────────────────────────

const READ_PRESETS = [
  { label: "balanceOf", signature: "balanceOf(address) view returns (uint256)", args: "[\"0x…\"]" },
  { label: "totalSupply", signature: "totalSupply() view returns (uint256)", args: "[]" },
  { label: "owner", signature: "owner() view returns (address)", args: "[]" },
  { label: "allowance", signature: "allowance(address owner, address spender) view returns (uint256)", args: "[\"0x…\", \"0x…\"]" },
];

export function ReadTool({ env, seed }: { env: Env; seed?: Seed }) {
  const [address, setAddress] = useSeededInput(seed, () => {});
  const [signature, setSignature] = useState(READ_PRESETS[1].signature);
  const [args, setArgs] = useState("[]");
  const { loading, error, data, run } = useRunner<{ signature: string; result: unknown; raw: string }>();

  function submit(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      let parsed: unknown;
      try { parsed = args.trim() ? JSON.parse(args) : []; } catch { throw new Error("Arguments must be a JSON array, e.g. [\"0xabc…\", \"100\"]"); }
      return json(env.api("dev/read", { method: "POST", body: JSON.stringify({ network: env.network, address: address.trim(), signature, args: parsed }) }));
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={BookOpen} title="Read contract" description="Call any view function by its signature — no ABI needed. Include `returns (…)` to decode the result." />
      <Card>
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Contract">{(id) => <TextInput id={id} mono placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
          <Field label="Function signature" hint={<span className="flex flex-wrap gap-1.5">{READ_PRESETS.map((p) => (
            <button key={p.label} type="button" className="rounded-full border border-[hsl(var(--border))] px-2 py-0.5 hover:border-[hsl(var(--primary))]/50" onClick={() => { setSignature(p.signature); setArgs(p.args); }}>{p.label}</button>
          ))}</span>}>
            {(id) => <TextInput id={id} mono value={signature} onChange={(e) => setSignature(e.target.value)} />}
          </Field>
          <Field label="Arguments (JSON array)">{(id) => <TextInput id={id} mono value={args} onChange={(e) => setArgs(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" loading={loading} disabled={!address.trim() || !signature.trim()} icon={BookOpen}>Read</Button>
        </form>
      </Card>
      {error && <Notice>{error}</Notice>}
      {data && (
        <Card title={data.signature}>
          {data.result !== null ? <Json value={data.result} title="Result" /> : <CodeBlock code={data.raw} title="Raw return data (add `returns (…)` to decode)" wrap />}
        </Card>
      )}
    </div>
  );
}

// ── Decode ───────────────────────────────────────────────────────────────

export function DecodeTool({ env, seed }: { env: Env; seed?: Seed }) {
  const [signature, setSignature] = useState("");
  const { loading, error, data, run } = useRunner<{ kind: "calldata" | "revert"; call?: Call; revert?: Revert }>();
  const go = useCallback((hex: string) => run(() => json(env.api("dev/decode", { method: "POST", body: JSON.stringify({ data: hex, signature: signature.trim() || undefined }) }))), [env, run, signature]);
  const [value, setValue] = useSeededInput(seed, go);

  return (
    <div className="space-y-4">
      <PageHeader icon={Binary} title="Decode" description="Calldata or revert data → function or error with arguments. Unknown selectors are looked up in the public signature database." />
      <Card>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (value.trim()) go(value.trim()); }}>
          <Field label="Hex data">{(id) => (
            <textarea id={id} rows={4} spellCheck={false} placeholder="0xa9059cbb… or 0x08c379a0…" value={value} onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]" />
          )}</Field>
          <Field label="Function signature (optional)" hint="Skips the lookup when you know it.">{(id) => <TextInput id={id} mono placeholder="transfer(address,uint256)" value={signature} onChange={(e) => setSignature(e.target.value)} />}</Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={loading} disabled={!value.trim()} icon={Binary}>Decode</Button>
            {[
              { label: "ERC-20 transfer", v: "0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa9604500000000000000000000000000000000000000000000000000000000000f4240" },
              { label: "Revert string", v: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001a4e6f7420656e6f7567682062616c616e636520746f2073656e64000000000000" },
              { label: "Panic", v: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011" },
            ].map((ex) => <button key={ex.label} type="button" onClick={() => { setValue(ex.v); go(ex.v); }} className="rounded-full border border-[hsl(var(--border))] px-2.5 py-1 text-xs hover:border-[hsl(var(--primary))]/50">{ex.label}</button>)}
          </div>
        </form>
      </Card>
      {error && <Notice>{error}</Notice>}
      {data?.kind === "revert" && data.revert && <RevertNotice revert={data.revert} title={data.revert.kind === "error-string" ? "Error(string)" : data.revert.kind === "panic" ? "Panic" : "Error"} />}
      {data?.kind === "calldata" && data.call && <Card title="Function call"><CallView call={data.call} /></Card>}
    </div>
  );
}

// ── Gas & network ────────────────────────────────────────────────────────

interface Gas {
  baseFeeGwei: string; ethUsd: number | null;
  tiers: Record<"slow" | "standard" | "fast", { maxPriorityFeeGwei: string; maxFeeGwei: string }>;
  costs: { label: string; gas: number; eth: string; usd: number | null }[];
}

export function GasTool({ env, status }: { env: Env; status: { blockNumber: string; gasPriceGwei: string; baseFeeGwei: string | null } | null }) {
  const { loading, error, data, run } = useRunner<{ gas: Gas }>();
  const load = useCallback(() => run(() => json(env.api(`dev/gas?${q(env)}`))), [env, run]);
  const info = NETWORKS[env.network];

  return (
    <div className="space-y-4">
      <PageHeader icon={Fuel} title="Gas & network" description={`${info.label} (chain ${info.chainId}). EIP-1559 tips from the last 20 blocks.`}
        actions={<Button variant="primary" loading={loading} onClick={load} icon={Fuel}>{data ? "Refresh" : "Check gas"}</Button>} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Block" value={status ? Number(status.blockNumber).toLocaleString() : "…"} />
        <Stat label="Gas price" value={status ? `${amt(status.gasPriceGwei, 4)} gwei` : "…"} />
        <Stat label="Base fee" value={status?.baseFeeGwei != null ? `${amt(status.baseFeeGwei, 4)} gwei` : "…"} />
      </div>
      {error && <Notice>{error}</Notice>}
      {!data && !loading && <p className={cx("text-sm", muted)}>Check gas to see fee tiers and what common actions cost right now.</p>}
      {data && (
        <>
          <Card title="Fee tiers" description={`Next base fee ${amt(data.gas.baseFeeGwei, 4)} gwei. Max fee leaves room for the base fee to double.`}>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["slow", "standard", "fast"] as const).map((t) => (
                <Stat key={t} label={t} value={`${amt(data.gas.tiers[t].maxPriorityFeeGwei, 4)} gwei tip`} sub={`max ${amt(data.gas.tiers[t].maxFeeGwei, 4)} gwei`} />
              ))}
            </div>
          </Card>
          <Card title="What things cost now" description={data.gas.ethUsd ? `At standard tier · ETH ${usd(data.gas.ethUsd)}` : "At standard tier"}>
            <ul className="divide-y divide-[hsl(var(--border))]/60">
              {data.gas.costs.map((c) => (
                <li key={c.label} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{c.label} <span className={cx("text-xs", muted)}>· {c.gas.toLocaleString()} gas</span></span>
                  <span className="font-mono text-xs tabular-nums">{amt(c.eth, 8)} ETH {c.usd != null && !info.testnet && <span className={muted}>· {usd(c.usd)}</span>}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
