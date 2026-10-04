"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { fetchIdl } from "./devtools";
import { simulate, type InstructionSpec, type SimulationReport } from "./txbuilder";
import { DecodedErrorView } from "./inspect-tools";
import { CircleCheck, CircleX, FileCode, FlaskConical, Plus, Send } from "lucide-react";
import {
  Addr, Button, Card, CodeBlock, CopyButton, ErrorNote, Field, PageHeader, Row, Select, Skeleton, Stat, TextInput,
  cx, inputClass, linkClass, logLineClass, muted, useRunner, type Env,
} from "./ui";

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

  const jsonError = (() => { try { JSON.parse(text); return null; } catch (err) { return (err as Error).message; } })();

  return (
    <div className="space-y-4">
      <PageHeader icon={FlaskConical} title="Simulate & send"
        description="Build a transaction from plain JSON — the same format agents send — dry-run it, then send it as the agent on devnet." />

      <Card title="Start from a program's IDL" description="Generates an instruction with its args and the accounts Anchor can't derive on its own.">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Program ID" className="min-w-64 flex-1">
            {(id) => <TextInput id={id} mono placeholder="Program address" value={programId} onChange={(e) => setProgramId(e.target.value)} />}
          </Field>
          <Button onClick={loadIdl} disabled={!programId.trim()} icon={FileCode}>Load IDL</Button>
          {idl && (
            <>
              <Select value={ixName} onChange={(e) => setIxName(e.target.value)} aria-label="Instruction">
                {idl.instructions.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </Select>
              <Button variant="primary" icon={Plus} onClick={insertTemplate}>Add instruction</Button>
            </>
          )}
        </div>
        {templateError && <div className="mt-3"><ErrorNote message={templateError} /></div>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title="Instructions" description={<>Use <code className="font-mono">&quot;payer&quot;</code> for the fee payer and <code className="font-mono">&quot;new:label&quot;</code> for a fresh keypair that signs.</>}
          actions={<CopyButton text={text} label="Copy JSON" />}>
          <label htmlFor="sim-json" className="sr-only">Instructions JSON</label>
          <textarea id="sim-json" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
            className={cx(inputClass, "h-auto min-h-72 resize-y py-2 font-mono text-xs leading-relaxed", jsonError && "border-red-500/60")} />
          {jsonError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">Invalid JSON — {jsonError}</p>}
        </Card>

        <Card title="Run">
          <div className="space-y-3">
            <Field label="Fee payer" hint={!feePayer && env.agent?.devWallet ? `Defaults to ${env.agent.name}'s dev wallet` : undefined}>
              {(id) => <TextInput id={id} mono placeholder={env.agent?.devWallet ?? "Payer address"} value={feePayer} onChange={(e) => setFeePayer(e.target.value)} />}
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="CU limit">{(id) => <TextInput id={id} mono inputMode="numeric" placeholder="auto" value={cuLimit} onChange={(e) => setCuLimit(e.target.value.replace(/\D/g, ""))} />}</Field>
              <Field label="µ-lamports/CU">{(id) => <TextInput id={id} mono inputMode="numeric" placeholder="0" value={priorityFee} onChange={(e) => setPriorityFee(e.target.value.replace(/\D/g, ""))} />}</Field>
            </div>
            <Button variant="primary" className="w-full" icon={FlaskConical} loading={sim.loading} disabled={!payer || !!jsonError}
              onClick={() => sim.run(() => simulate(env.conn, new PublicKey(payer), parseSpecs(), budget()))}>
              Simulate on {env.cluster}
            </Button>
            <Button className="w-full" icon={Send} loading={send.loading} disabled={!canSend || !!jsonError}
              onClick={() => send.run(async () => {
                const res = await env.agentApi("dev/send", { method: "POST", body: JSON.stringify({ cluster: env.cluster, instructions: parseSpecs(), ...budget() }) });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                return data;
              })}>
              {env.agent ? `Send as ${env.agent.name}` : "Send as agent"}
            </Button>
            {!canSend && (
              <p className={cx("text-xs", muted)}>
                {!env.agent ? "Pick an agent to send as it." : !env.agent.capabilities["solana-dev-devnet"] ? `${env.agent.name} needs the “Act on devnet” upgrade.`
                  : !env.agent.devWallet ? `${env.agent.name} has no dev wallet yet — create one on Overview.` : "Sending works on devnet and testnet only."}
              </p>
            )}
            {!payer && <p className={cx("text-xs", muted)}>Enter a fee payer to simulate.</p>}
          </div>
        </Card>
      </div>

      {sim.error && <ErrorNote message={sim.error} />}
      {sim.loading && !sim.data && <Skeleton className="h-40" />}
      {sim.data && (
        <Card title={<span className="flex items-center gap-2">{sim.data.success
          ? <CircleCheck className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden /> : <CircleX className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />}
          Simulation {sim.data.success ? "succeeded" : "failed"}</span>}
          actions={<CopyButton text={sim.data.transactionBase64} label="Copy unsigned transaction (base64)" />}>
          <div className="space-y-4">
            {sim.data.error && <DecodedErrorView error={sim.data.error} env={env} />}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Compute units" value={sim.data.unitsConsumed?.toLocaleString() ?? "—"} />
              <Stat label="Suggested limit" value={sim.data.recommendedComputeUnitLimit?.toLocaleString() ?? "—"} sub="used + 10%" />
              <Stat label="Size" value={`${sim.data.sizeBytes} B`} sub="of 1,232" tone={sim.data.sizeBytes > 1232 ? "danger" : undefined} />
              <Stat label="Instructions" value={sim.data.instructionCount} />
            </div>
            {Object.keys(sim.data.newAccounts).length > 0 && (
              <div>{Object.entries(sim.data.newAccounts).map(([label, pk]) => <Row key={label} label={`new:${label}`}><Addr value={pk} env={env} /></Row>)}</div>
            )}
            <CodeBlock title={`Program logs · ${sim.data.logs.length} lines`} code={sim.data.logs.join("\n")} lineClass={logLineClass} />
          </div>
        </Card>
      )}

      {send.error && <ErrorNote message={send.error} />}
      {send.data && (
        <Card title={send.data.success ? "Sent and confirmed" : send.data.signature ? "Sent, but failed on-chain" : "Rejected in simulation — nothing was sent"}>
          <div className="space-y-3">
            {send.data.error && <DecodedErrorView error={send.data.error} env={env} />}
            {send.data.signature && (
              <Row label="Signature">
                <button type="button" className={cx("font-mono text-xs break-all text-left", linkClass)} onClick={() => env.go("tx", send.data!.signature)}>{send.data.signature}</button>
              </Row>
            )}
            {Object.entries(send.data.newAccounts ?? {}).map(([label, pk]) => <Row key={label} label={`new:${label}`}><Addr value={pk} env={env} /></Row>)}
          </div>
        </Card>
      )}
    </div>
  );
}
