"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { fetchIdl } from "./devtools";
import { simulate, type InstructionSpec, type SimulationReport } from "./txbuilder";
import { DecodedErrorView } from "./inspect-tools";
import { Addr, Badge, CopyButton, ErrorNote, Row, Section, buttonClass, inputClass, mono, muted, useRunner, type Env } from "./ui";

// Build & simulate: the same instruction-spec JSON agents send to
// POST /dev/simulate, run here in the browser (so localnet works too), with
// a template generator from the program's IDL and a "send as agent" button.

type IdlTypeLike = string | Record<string, unknown>;
type TypeDef = { name: string; type: { kind: string; fields?: { name: string; type: IdlTypeLike }[] | IdlTypeLike[]; variants?: { name: string }[] } };
type IdlAccountItem = { name: string; signer?: boolean; writable?: boolean; address?: string; pda?: unknown; accounts?: IdlAccountItem[] };

const BIG = new Set(["u64", "i64", "u128", "i128", "u256", "i256"]);

/** A placeholder value for an IDL type — what an agent (or you) fills in. */
function argTemplate(type: IdlTypeLike, types: TypeDef[], depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof type === "string") {
    if (type === "bool") return false;
    if (BIG.has(type)) return "0";
    if (/^[ui](8|16|32)$|^f(32|64)$/.test(type)) return 0;
    if (type === "string") return "";
    if (type === "pubkey" || type === "publicKey") return "payer";
    if (type === "bytes") return "0x";
    return null;
  }
  if ("option" in type || "coption" in type) return null;
  if ("vec" in type) return [];
  if ("array" in type) {
    const [inner, len] = type.array as [IdlTypeLike, number];
    return inner === "u8" ? `0x${"00".repeat(len)}` : Array.from({ length: len }, () => argTemplate(inner, types, depth + 1));
  }
  if ("defined" in type) {
    const name = typeof type.defined === "string" ? type.defined : (type.defined as { name: string }).name;
    const def = types.find((t) => t.name === name);
    if (!def) return null;
    if (def.type.kind === "enum") return def.type.variants?.[0]?.name ?? null;
    const fields = def.type.fields ?? [];
    if (fields.length && typeof fields[0] === "object" && "name" in (fields[0] as object)) {
      return Object.fromEntries((fields as { name: string; type: IdlTypeLike }[]).map((f) => [f.name, argTemplate(f.type, types, depth + 1)]));
    }
    return (fields as IdlTypeLike[]).map((f) => argTemplate(f, types, depth + 1));
  }
  return null;
}

/** Accounts Anchor can't derive on its own: no fixed address, no PDA seeds. Signers default to the payer. */
function accountTemplate(items: IdlAccountItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of items) {
    if (a.accounts) Object.assign(out, accountTemplate(a.accounts));
    else if (!a.address && !a.pda) out[a.name] = a.signer ? "payer" : "";
  }
  return out;
}

const EXAMPLE: InstructionSpec[] = [{ kind: "transfer", to: "11111111111111111111111111111112", sol: 0.001 }];

export function SimulateTab({ env }: { env: Env }) {
  const [text, setText] = useState(JSON.stringify(EXAMPLE, null, 2));
  const [feePayer, setFeePayer] = useState("");
  const [cuLimit, setCuLimit] = useState("");
  const [priorityFee, setPriorityFee] = useState("");
  const [programId, setProgramId] = useState("");
  const [idl, setIdl] = useState<Idl | null>(null);
  const [ixName, setIxName] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const sim = useRunner<SimulationReport>();
  const send = useRunner<{ signature: string; success: boolean; error: SimulationReport["error"]; unitsConsumed: number | null; newAccounts: Record<string, string> }>();

  const payer = feePayer.trim() || env.agent?.devWallet || "";
  const canSend = !!env.agent?.capabilities["solana-dev-devnet"] && !!env.agent?.devWallet && (env.cluster === "devnet" || env.cluster === "testnet");

  function parseSpecs(): InstructionSpec[] {
    let specs: unknown;
    try {
      specs = JSON.parse(text);
    } catch (err) {
      throw new Error(`Instructions aren't valid JSON: ${(err as Error).message}`);
    }
    return (Array.isArray(specs) ? specs : [specs]) as InstructionSpec[];
  }

  const budget = () => ({
    computeUnitLimit: cuLimit ? Number(cuLimit) : undefined,
    priorityFee: priorityFee ? Number(priorityFee) : undefined,
  });

  async function loadIdl() {
    setTemplateError(null);
    try {
      const fetched = await fetchIdl(env.conn, programId);
      if (!fetched) throw new Error(`No on-chain IDL for this program on ${env.cluster}`);
      setIdl(fetched);
      setIxName(fetched.instructions[0]?.name ?? "");
    } catch (err) {
      setIdl(null);
      setTemplateError((err as Error).message);
    }
  }

  function insertTemplate() {
    const ix = idl?.instructions.find((x) => x.name === ixName);
    if (!idl || !ix) return;
    const types = (idl.types ?? []) as unknown as TypeDef[];
    const spec = {
      programId: programId.trim(),
      instruction: ix.name,
      args: Object.fromEntries(ix.args.map((a) => [a.name, argTemplate(a.type as IdlTypeLike, types)])),
      accounts: accountTemplate(ix.accounts as unknown as IdlAccountItem[]),
    };
    let existing: unknown[] = [];
    try {
      const parsed = JSON.parse(text);
      existing = Array.isArray(parsed) ? parsed : [];
    } catch { /* replace unparseable text */ }
    const keep = existing.filter((s) => JSON.stringify(s) !== JSON.stringify(EXAMPLE[0]));
    setText(JSON.stringify([...keep, spec], null, 2));
  }

  return (
    <div className="space-y-3">
      <Section title="Instruction template" description="Load a program's IDL to generate an instruction spec. PDAs and fixed-address accounts are left out — Anchor derives them.">
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder="program id" value={programId} onChange={(e) => setProgramId(e.target.value)} spellCheck={false} />
          <button type="button" className={buttonClass()} onClick={loadIdl} disabled={!programId.trim()}>Load IDL</button>
          {idl && (
            <>
              <select className={inputClass} value={ixName} onChange={(e) => setIxName(e.target.value)} aria-label="instruction">
                {idl.instructions.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
              <button type="button" className={buttonClass(true)} onClick={insertTemplate}>Insert</button>
            </>
          )}
        </div>
        {templateError && <ErrorNote message={templateError} />}
      </Section>

      <Section title="Transaction" description='Same JSON your agents send to solana_simulate / solana_send. "payer" = fee payer; "new:<label>" = a fresh keypair that signs.'>
        <textarea className={`${inputClass} w-full font-mono text-xs min-h-56`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="instructions JSON" />
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputClass} flex-1 min-w-64 font-mono text-xs`} placeholder={env.agent?.devWallet ? `fee payer (default: ${env.agent.name}'s dev wallet)` : "fee payer address"}
            value={feePayer} onChange={(e) => setFeePayer(e.target.value)} spellCheck={false} />
          <input className={`${inputClass} w-28 font-mono text-xs`} placeholder="CU limit" inputMode="numeric" value={cuLimit} onChange={(e) => setCuLimit(e.target.value.replace(/\D/g, ""))} />
          <input className={`${inputClass} w-36 font-mono text-xs`} placeholder="µ-lamports/CU" inputMode="numeric" value={priorityFee} onChange={(e) => setPriorityFee(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass(true)} disabled={sim.loading || !payer}
            onClick={() => sim.run(() => simulate(env.conn, new PublicKey(payer), parseSpecs(), budget()))}>
            {sim.loading ? "Simulating…" : `Simulate on ${env.cluster}`}
          </button>
          <button type="button" className={buttonClass()} disabled={!canSend || send.loading}
            title={canSend ? undefined : "Needs a selected agent with the devnet upgrade and a dev wallet, on devnet or testnet"}
            onClick={() => send.run(async () => {
              const res = await env.agentApi("dev/send", { method: "POST", body: JSON.stringify({ cluster: env.cluster, instructions: parseSpecs(), ...budget() }) });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error);
              return data;
            })}>
            {send.loading ? "Sending…" : env.agent ? `Send as ${env.agent.name}` : "Send as agent"}
          </button>
          {!payer && <span className={`text-xs ${muted}`}>Enter a fee payer, or pick an agent with a dev wallet.</span>}
        </div>
      </Section>

      {sim.error && <ErrorNote message={sim.error} />}
      {sim.data && (
        <Section title="Simulation" right={<Badge tone={sim.data.success ? "success" : "danger"}>{sim.data.success ? "success" : "failed"}</Badge>}>
          {sim.data.error && <DecodedErrorView error={sim.data.error} env={env} />}
          <div>
            <Row label="Compute units">{sim.data.unitsConsumed?.toLocaleString() ?? "—"}{sim.data.recommendedComputeUnitLimit && <span className={`text-xs ${muted}`}> · set limit {sim.data.recommendedComputeUnitLimit.toLocaleString()}</span>}</Row>
            <Row label="Size">{sim.data.sizeBytes} / 1232 bytes</Row>
            <Row label="Instructions">{sim.data.instructionCount}</Row>
            {Object.entries(sim.data.newAccounts).map(([label, pk]) => <Row key={label} label={`new:${label}`}><Addr value={pk} env={env} /></Row>)}
            <Row label="Unsigned tx"><span className={`${mono} ${muted}`}>{sim.data.transactionBase64.slice(0, 48)}…</span> <CopyButton text={sim.data.transactionBase64} label="copy base64" /></Row>
          </div>
          <pre className="max-h-72 overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs leading-relaxed">
            {sim.data.logs.map((line, i) => <div key={i} className={/failed|error/i.test(line) ? "text-red-600 dark:text-red-400" : ""}>{line}</div>)}
          </pre>
        </Section>
      )}

      {send.error && <ErrorNote message={send.error} />}
      {send.data && (
        <Section title="Sent" right={<Badge tone={send.data.success ? "success" : "danger"}>{send.data.success ? "confirmed" : send.data.signature ? "failed" : "rejected in simulation"}</Badge>}>
          {send.data.error && <DecodedErrorView error={send.data.error} env={env} />}
          {send.data.signature && (
            <Row label="Signature">
              <button type="button" className={`${mono} text-blue-600 dark:text-blue-400 hover:underline text-left`} onClick={() => env.go("tx", send.data!.signature)}>{send.data.signature}</button>
            </Row>
          )}
          {Object.entries(send.data.newAccounts ?? {}).map(([label, pk]) => <Row key={label} label={`new:${label}`}><Addr value={pk} env={env} /></Row>)}
        </Section>
      )}
    </div>
  );
}
