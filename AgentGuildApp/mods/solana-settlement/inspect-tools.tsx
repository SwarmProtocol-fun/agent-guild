"use client";

import { useMemo, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import {
  SEED_TYPES, PROGRAM_DATA_HEADER,
  inspectAccount, inspectTransaction, fetchIdl, derivePda, pdaSnippet,
  decodeProgramError, parseErrorCode, priorityFees, rentExempt, parsePubkey,
  type ClusterStatus, type AccountReport, type TxReport, type DecodedError,
  type PriorityFeeReport, type SeedSpec, type SeedType,
} from "./devtools";
import {
  Addr, Badge, CopyButton, ErrorNote, Json, Row, Section, ToolForm, buttonClass, inputClass, mono, muted, sol,
  useRunner, useSeededInput, type Env, type Seed,
} from "./ui";

// The read & debug tools. They talk to the RPC straight from the browser:
// that's what lets a developer point them at their own localnet validator.

// ── Transaction ──────────────────────────────────────────────────────────

export function DecodedErrorView({ error, env }: { error: DecodedError & { instructionIndex?: number; programId?: string }; env: Env }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2 space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger">{error.source}</Badge>
        {error.instructionIndex != null && <span className={`text-xs ${muted}`}>instruction #{error.instructionIndex}</span>}
        {error.hex && <span className={mono}>{error.code} ({error.hex})</span>}
      </div>
      <div className="font-medium">{error.name ?? "Unknown error"}</div>
      {error.message && <div className={`text-xs ${muted}`}>{error.message}</div>}
      {error.programId && <div className="text-xs">program <Addr value={error.programId} env={env} /></div>}
    </div>
  );
}

export function TxTool({ env, seed }: { env: Env; seed?: Seed }) {
  const r = useRunner<TxReport>();
  const lookup = (v: string) => r.run(() => inspectTransaction(env.conn, v));
  const [value, setValue] = useSeededInput(seed, lookup);
  const tx = r.data;

  return (
    <Section title="Transaction inspector" description="Status, compute units, fees, balance deltas, logs — and failing custom errors decoded via the program's IDL.">
      <ToolForm value={value} onChange={setValue} onSubmit={() => lookup(value)} placeholder="transaction signature" loading={r.loading} action="Inspect" />
      {r.error && <ErrorNote message={r.error} />}
      {tx && !tx.found && <ErrorNote message={`Not found on ${env.cluster} (wrong cluster, or older than the RPC's history).`} />}
      {tx?.found && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tx.success ? "success" : "danger"}>{tx.success ? "success" : "failed"}</Badge>
            <Badge tone="neutral">{String(tx.version)}</Badge>
            <a className="text-xs text-blue-600 dark:text-blue-400 hover:underline" href={env.explorer("tx", tx.signature)} target="_blank" rel="noreferrer">explorer ↗</a>
          </div>
          {tx.error && <DecodedErrorView error={tx.error} env={env} />}
          <div>
            <Row label="Slot">{tx.slot?.toLocaleString()}</Row>
            <Row label="Time">{tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : "—"}</Row>
            <Row label="Fee">{tx.feeLamports != null ? `${tx.feeLamports.toLocaleString()} lamports` : "—"}</Row>
            <Row label="Compute units">{tx.computeUnitsConsumed?.toLocaleString() ?? "—"}</Row>
            <Row label="Signers">{tx.signers?.map((s) => <div key={s}><Addr value={s} env={env} /></div>)}</Row>
          </div>
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Instructions</div>
            {tx.instructions?.map((ix) => (
              <div key={ix.index} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                <span className={`${mono} ${muted}`}>#{ix.index}</span>
                <Addr value={ix.programId} env={env} name={ix.programName} />
                {ix.type && <Badge tone="neutral">{ix.type}</Badge>}
                {ix.innerCount > 0 && <span className={`text-xs ${muted}`}>+{ix.innerCount} inner</span>}
                {!ix.programName && (
                  <button type="button" className="text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("idl", ix.programId)}>IDL</button>
                )}
              </div>
            ))}
          </div>
          {(tx.balanceChanges?.length ?? 0) > 0 && (
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>SOL balance changes</div>
              {tx.balanceChanges!.map((c) => (
                <div key={c.account} className="flex justify-between gap-2 py-0.5">
                  <Addr value={c.account} env={env} />
                  <span className={`${mono} ${c.deltaLamports > 0 ? "text-green-600" : "text-red-600"}`}>{c.deltaLamports > 0 ? "+" : ""}{sol(c.deltaLamports)}</span>
                </div>
              ))}
            </div>
          )}
          {(tx.tokenBalanceChanges?.length ?? 0) > 0 && (
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Token balance changes</div>
              {tx.tokenBalanceChanges!.map((c) => (
                <div key={`${c.account}:${c.mint}`} className="py-0.5 text-sm">
                  <span className={`${mono} ${c.delta.startsWith("-") ? "text-red-600" : "text-green-600"}`}>{c.delta}</span>{" "}
                  <span className={`text-xs ${muted}`}>of mint</span> <Addr value={c.mint} env={env} />
                  {c.owner && <div className={`text-xs ${muted}`}>owner {c.owner}</div>}
                </div>
              ))}
            </div>
          )}
          {(tx.logs?.length ?? 0) > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>Program logs</div>
                <CopyButton text={tx.logs!.join("\n")} label="copy logs" />
              </div>
              <pre className="max-h-80 overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs leading-relaxed">
                {tx.logs!.map((line, i) => (
                  <div key={i} className={/failed|error/i.test(line) ? "text-red-600 dark:text-red-400" : /consumed \d+ of/.test(line) ? muted : ""}>{line}</div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Account ──────────────────────────────────────────────────────────────

export function AccountTool({ env, seed }: { env: Env; seed?: Seed }) {
  const r = useRunner<AccountReport>();
  const lookup = (v: string) => r.run(() => inspectAccount(env.conn, v, { decodeAnchor: true }));
  const [value, setValue] = useSeededInput(seed, lookup);
  const a = r.data;

  return (
    <Section title="Account inspector" description="Balance, owner, rent status, parsed token data, program upgrade authority, and Anchor accounts decoded from the owner's IDL.">
      <ToolForm value={value} onChange={setValue} onSubmit={() => lookup(value)} placeholder="account / program / mint address" loading={r.loading} action="Inspect" />
      {r.error && <ErrorNote message={r.error} />}
      {a && !a.exists && <ErrorNote message={`No account at this address on ${env.cluster}.`} />}
      {a?.exists && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {a.executable ? <Badge tone="warning">program</Badge> : <Badge tone="neutral">account</Badge>}
            <Badge tone={a.rentExempt ? "success" : "danger"}>{a.rentExempt ? "rent exempt" : "below rent exemption"}</Badge>
            {a.anchor && <Badge tone="success">anchor · {a.anchor.accountType}</Badge>}
            <a className="text-xs text-blue-600 dark:text-blue-400 hover:underline" href={env.explorer("address", a.address)} target="_blank" rel="noreferrer">explorer ↗</a>
            {a.executable && (
              <button type="button" className="text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("idl", a.address)}>view IDL</button>
            )}
          </div>
          <div>
            <Row label="Address"><span className={mono}>{a.address}</span> <CopyButton text={a.address} /></Row>
            <Row label="Balance">{sol(a.lamports!)} <span className={`text-xs ${muted}`}>({a.lamports!.toLocaleString()} lamports)</span></Row>
            <Row label="Owner"><Addr value={a.owner!} env={env} name={a.ownerName} /></Row>
            <Row label="Data size">{a.dataLength!.toLocaleString()} bytes</Row>
            <Row label="Rent-exempt min">{sol(a.rentExemptMinimum!)}</Row>
            {a.program && (
              <>
                <Row label="ProgramData"><Addr value={a.program.programDataAddress} env={env} /></Row>
                <Row label="Upgrade authority">
                  {a.program.upgradeAuthority ? <Addr value={a.program.upgradeAuthority} env={env} /> : <Badge tone="success">immutable</Badge>}
                </Row>
                <Row label="Last deployed slot">{a.program.lastDeploySlot.toLocaleString()}</Row>
              </>
            )}
            {a.dataLength! > 0 && !a.parsed && !a.anchor && (
              <Row label="Data (first 64 B)"><span className={mono}>{a.dataPreviewHex}</span></Row>
            )}
          </div>
          {a.parsed != null && (<div><div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Parsed</div><Json value={a.parsed} /></div>)}
          {a.anchor?.decoded != null && (<div><div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Decoded {a.anchor.accountType}</div><Json value={a.anchor.decoded} /></div>)}
        </div>
      )}
    </Section>
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
  const idl = r.data?.idl;

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
    <Section title="Anchor IDL" description="Fetches the IDL a program published on-chain (anchor idl init / upgrade).">
      <ToolForm value={value} onChange={setValue} onSubmit={() => lookup(value)} placeholder="program id" loading={r.loading} action="Fetch" />
      {r.error && <ErrorNote message={r.error} />}
      {r.data && !idl && <ErrorNote message={`No IDL account for this program on ${env.cluster}. Publish one with: anchor idl init --filepath target/idl/<program>.json ${r.data.programId}`} />}
      {idl && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{idl.metadata?.name ?? idl.name}</span>
            <Badge tone="neutral">v{idl.metadata?.version ?? idl.version}</Badge>
            {idl.metadata?.spec && <Badge tone="neutral">spec {idl.metadata.spec}</Badge>}
            <button type="button" className={buttonClass(false, "ml-auto")} onClick={download}>Download JSON</button>
            <CopyButton text={JSON.stringify(idl, null, 2)} label="copy JSON" />
          </div>
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Instructions ({idl.instructions.length})</div>
            {idl.instructions.map((ix) => (
              <details key={ix.name} className="border-b border-[hsl(var(--border))]/50 py-1">
                <summary className="cursor-pointer text-sm font-mono">{ix.name}<span className={`ml-2 text-xs ${muted}`}>{ix.accounts.length} accounts · {ix.args.length} args</span></summary>
                <div className="pl-4 py-1 space-y-1 text-xs">
                  {ix.accounts.map((acc, i) => {
                    const writable = Boolean(acc.writable ?? acc.isMut);
                    const signer = Boolean(acc.signer ?? acc.isSigner);
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono">{String(acc.name)}</span>
                        {writable && <Badge tone="warning">mut</Badge>}
                        {signer && <Badge tone="success">signer</Badge>}
                        {acc.pda != null && <Badge tone="neutral">pda</Badge>}
                        {typeof acc.address === "string" && <span className={`${mono} ${muted}`}>{acc.address}</span>}
                      </div>
                    );
                  })}
                  {ix.args.map((arg) => (
                    <div key={arg.name} className="font-mono"><span className={muted}>arg</span> {arg.name}: {typeLabel(arg.type)}</div>
                  ))}
                </div>
              </details>
            ))}
          </div>
          {(idl.accounts?.length ?? 0) > 0 && (
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Accounts</div>
              <div className="flex flex-wrap gap-1.5">{idl.accounts!.map((a) => <Badge key={a.name} tone="neutral">{a.name}</Badge>)}</div>
            </div>
          )}
          {(idl.errors?.length ?? 0) > 0 && (
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide ${muted} mb-1`}>Errors</div>
              {idl.errors!.map((e) => (
                <div key={e.code} className="grid grid-cols-[6rem_12rem_1fr] gap-2 py-0.5 text-xs">
                  <span className="font-mono">{e.code} <span className={muted}>0x{e.code.toString(16)}</span></span>
                  <span className="font-mono">{e.name}</span>
                  <span className={muted}>{e.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ── PDA ──────────────────────────────────────────────────────────────────

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

  return (
    <Section title="PDA derivation" description="findProgramAddressSync with typed seeds — integers are little-endian, like Anchor's to_le_bytes().">
      <input className={`${inputClass} w-full font-mono text-xs`} placeholder="program id" value={programId} onChange={(e) => setProgramId(e.target.value)} spellCheck={false} />
      <div className="space-y-2">
        {seeds.map((seed, i) => (
          <div key={i} className="flex gap-2">
            <select className={inputClass} value={seed.type} onChange={(e) => update(i, { type: e.target.value as SeedType })} aria-label={`seed ${i + 1} type`}>
              {SEED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder={seed.type === "pubkey" ? "base58 pubkey" : seed.type === "hex" ? "0x…" : seed.type === "string" ? "utf-8 text" : "integer"}
              value={seed.value} onChange={(e) => update(i, { value: e.target.value })} spellCheck={false} />
            <button type="button" className={buttonClass()} onClick={() => setSeeds((s) => s.filter((_, j) => j !== i))} disabled={seeds.length === 1} aria-label="remove seed">−</button>
          </div>
        ))}
        <button type="button" className={buttonClass()} onClick={() => setSeeds((s) => [...s, { type: "string", value: "" }])} disabled={seeds.length >= 15}>+ seed</button>
      </div>
      {derived && !derived.ok && <ErrorNote message={derived.error} />}
      {derived?.ok && (
        <div className="space-y-2">
          <Row label="Address"><span className={mono}>{derived.address}</span> <CopyButton text={derived.address} /></Row>
          <Row label="Bump">{derived.bump}</Row>
          <Row label="Seed bytes">{derived.seedsHex.map((h, i) => <div key={i} className={`${mono} ${muted}`}>{i + 1}: {h || "(empty)"}</div>)}</Row>
          <div className="flex gap-2">
            <button type="button" className={buttonClass()} disabled={exists.loading} onClick={() => exists.run(() => inspectAccount(env.conn, derived.address))}>
              {exists.loading ? "checking…" : `Check on ${env.cluster}`}
            </button>
            <button type="button" className={buttonClass()} onClick={() => env.go("account", derived.address)}>Open in inspector</button>
          </div>
          {exists.error && <ErrorNote message={exists.error} />}
          {exists.data && (
            <div className="text-sm">
              {exists.data.exists
                ? <Badge tone="success">initialized · {exists.data.dataLength} bytes · owner {exists.data.ownerName ?? exists.data.owner}</Badge>
                : <Badge tone="neutral">not initialized</Badge>}
            </div>
          )}
          <div className="relative">
            <pre className="overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs">{pdaSnippet(programId.trim(), seeds)}</pre>
            <div className="absolute right-2 top-1"><CopyButton text={pdaSnippet(programId.trim(), seeds)} /></div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Errors ───────────────────────────────────────────────────────────────

export function ErrorTool({ env, seed }: { env: Env; seed?: Seed }) {
  const [programId, setProgramId] = useState("");
  const r = useRunner<DecodedError>();
  const lookup = (v: string) =>
    r.run(async () => {
      const code = parseErrorCode(v);
      const pid = programId.trim() || null;
      if (pid) parsePubkey(pid, "program id");
      const idl = pid && code >= 6000 ? await fetchIdl(env.conn, pid).catch(() => null) : null;
      return decodeProgramError(code, pid, idl);
    });
  const [value, setValue] = useSeededInput(seed, lookup);

  return (
    <Section title="Error decoder" description='Paste "custom program error: 0x1771", a decimal code, or hex. Add the program id to resolve 6000+ codes from its IDL.'>
      <ToolForm value={value} onChange={setValue} onSubmit={() => lookup(value)} placeholder="0x1771 · 6001 · custom program error: 0x7d3" loading={r.loading} action="Decode" />
      <input className={`${inputClass} w-full font-mono text-xs`} placeholder="program id (optional — System / Token / your Anchor program)" value={programId} onChange={(e) => setProgramId(e.target.value)} spellCheck={false} />
      {r.error && <ErrorNote message={r.error} />}
      {r.data && <DecodedErrorView error={r.data} env={env} />}
      <p className={`text-xs ${muted}`}>
        Ranges: 100–1999 Anchor instruction/IDL · 2000–2999 constraints · 3000–3999 accounts · 4100+ misc · 6000+ your program&apos;s <span className="font-mono">#[error_code]</span>.
      </p>
    </Section>
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
    <div className="space-y-3">
      <Section title="Cluster">
        {status ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {[
              ["Version", status.version],
              ["Slot", status.slot.toLocaleString()],
              ["Epoch", `${status.epoch} · ${status.epochProgressPct}%`],
              ["TPS", status.tps == null ? "—" : `${status.tps.toLocaleString()}${status.nonVoteTps != null ? ` (${status.nonVoteTps.toLocaleString()} non-vote)` : ""}`],
            ].map(([k, v]) => (
              <div key={k}><div className={`text-xs ${muted}`}>{k}</div><div className="font-mono text-xs">{v}</div></div>
            ))}
          </div>
        ) : <p className={`text-sm ${muted}`}>Not connected.</p>}
      </Section>

      <Section title="Priority fees" description="Recent prioritization fees in µ-lamports per CU. Scope to the writable accounts your tx touches for a realistic estimate.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); fees.run(() => priorityFees(env.conn, feeAccounts.split(/[\s,]+/).filter(Boolean))); }}>
          <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder="writable accounts (optional, comma-separated)" value={feeAccounts} onChange={(e) => setFeeAccounts(e.target.value)} spellCheck={false} />
          <button type="submit" className={buttonClass(true)} disabled={fees.loading}>{fees.loading ? "…" : "Sample"}</button>
        </form>
        {fees.error && <ErrorNote message={fees.error} />}
        {fees.data && (
          <div className="space-y-2">
            <div className="grid grid-cols-5 gap-2 text-sm">
              {(["min", "p50", "p75", "p90", "max"] as const).map((k) => (
                <div key={k}>
                  <div className={`text-xs ${muted}`}>{k}</div>
                  <div className="font-mono text-xs">{fees.data![k].toLocaleString()}</div>
                  <div className={`text-[11px] ${muted}`}>{priorityCost(fees.data![k]).toLocaleString()} lamports</div>
                </div>
              ))}
            </div>
            <p className={`text-xs ${muted}`}>
              {fees.data.slots} slots sampled, {Math.round(fees.data.zeroFeeShare * 100)}% paid no priority fee. Lamport cost assumes 200k CU — set
              <span className="font-mono"> ComputeBudgetProgram.setComputeUnitLimit</span> to what your tx actually uses (see the Transaction tool) to pay less.
            </p>
          </div>
        )}
      </Section>

      <Section title="Rent calculator" description="Lamports needed to keep an account of this size rent-exempt.">
        <form className="flex flex-wrap gap-2 items-center" onSubmit={(e) => {
          e.preventDefault();
          rent.run(() => rentExempt(env.conn, Number(bytes) + (isProgram ? PROGRAM_DATA_HEADER : 0)));
        }}>
          <input className={`${inputClass} w-32 font-mono text-xs`} inputMode="numeric" value={bytes} onChange={(e) => setBytes(e.target.value.replace(/\D/g, ""))} aria-label="bytes" />
          <span className={`text-xs ${muted}`}>bytes</span>
          {[["token acct", 165], ["mint", 82], ["anchor disc", 8]].map(([label, n]) => (
            <button key={label} type="button" className={buttonClass(false, "text-xs")} onClick={() => { setBytes(String(n)); setIsProgram(false); }}>{label}</button>
          ))}
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={isProgram} onChange={(e) => setIsProgram(e.target.checked)} /> program .so size (adds {PROGRAM_DATA_HEADER} B header)
          </label>
          <button type="submit" className={buttonClass(true)} disabled={rent.loading || !bytes}>Calculate</button>
        </form>
        {rent.error && <ErrorNote message={rent.error} />}
        {rent.data && <div className="text-sm"><span className="font-mono">{sol(rent.data.lamports)}</span> <span className={`text-xs ${muted}`}>({rent.data.lamports.toLocaleString()} lamports for {rent.data.bytes.toLocaleString()} bytes)</span></div>}
      </Section>

      <Section title="Airdrop" description={canAirdrop ? "Requested from your browser, so faucet limits apply to you, not the server." : "Not available on mainnet."}>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); requestAirdrop(); }}>
          <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder="recipient address" value={dropTo} onChange={(e) => setDropTo(e.target.value)} spellCheck={false} disabled={!canAirdrop} />
          <input className={`${inputClass} w-20 font-mono text-xs`} inputMode="decimal" value={dropAmount} onChange={(e) => setDropAmount(e.target.value)} aria-label="SOL amount" disabled={!canAirdrop} />
          <button type="submit" className={buttonClass(true)} disabled={!canAirdrop || airdrop.loading || !dropTo}>{airdrop.loading ? "…" : "Airdrop"}</button>
        </form>
        {airdrop.error && (
          <ErrorNote message={`${airdrop.error}${/429|limit|faucet/i.test(airdrop.error) ? " — the public faucet is rate-limited; try faucet.solana.com or a smaller amount." : ""}`} />
        )}
        {airdrop.data && (
          <div className="text-sm text-green-700 dark:text-green-400">
            ✓ confirmed{" "}
            <button type="button" className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("tx", airdrop.data!)}>{airdrop.data.slice(0, 16)}…</button>
          </div>
        )}
      </Section>
    </div>
  );
}
