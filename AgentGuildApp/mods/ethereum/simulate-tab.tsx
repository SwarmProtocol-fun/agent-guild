"use client";

import { useState, type FormEvent } from "react";
import { FlaskConical, Send } from "lucide-react";
import { Addr, Badge, Button, Card, Field, Json, Notice, PageHeader, Stat, TextInput, amt, cx, json, muted, type Env } from "./ui";
import { RevertNotice } from "./inspect-tools";
import { NETWORKS, SIGNING_NETWORKS } from "./networks";

// Build a call, ETH send or deployment; dry-run it on any network, then —
// on a testnet, as an agent with the testnet upgrade — sign and send it
// from the agent's own dev wallet.

type Mode = "call" | "deploy";

interface Revert { kind: string; selector: string | null; message: string; signature?: string; raw: string }
interface Simulation { fromBalanceEth: string | null; canAfford: boolean | null; success: boolean; from: string; to: string | null; valueEth: string; result: unknown; returnData: string | null; gasEstimate: string | null; feeEstimateEth: string | null; revert: Revert | null; error: string | null }
interface SendResult { hash: string | null; explorerUrl: string | null; status: "success" | "reverted" | "rejected" | "pending"; contractAddress: string | null; gasUsed: string | null; feeEth: string | null; revert: Revert | null; error: string | null }

export function SimulateTab({ env }: { env: Env }) {
  const agent = env.agent;
  const [mode, setMode] = useState<Mode>("call");
  const [to, setTo] = useState("");
  const [signature, setSignature] = useState("");
  const [args, setArgs] = useState("[]");
  const [data, setData] = useState("");
  const [value, setValue] = useState("");
  const [bytecode, setBytecode] = useState("");
  const [ctor, setCtor] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState<"sim" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);

  const canSimulate = !!agent?.capabilities["eth-simulate"];
  const canSend = !!agent?.capabilities["eth-testnet"] && !!agent.devWallet && SIGNING_NETWORKS.includes(env.network);
  const sendBlocker = !agent ? "Pick an agent to send from its dev wallet."
    : !agent.capabilities["eth-testnet"] ? `${agent.name} needs the “Act on testnets” upgrade.`
    : !agent.devWallet ? `${agent.name} has no dev wallet yet — create one on the Overview tab.`
    : !SIGNING_NETWORKS.includes(env.network) ? `Switch to ${SIGNING_NETWORKS.map((n) => NETWORKS[n].label).join(" or ")} to send.`
    : null;

  function spec(): Record<string, unknown> {
    let parsed: unknown = [];
    if (args.trim()) {
      try { parsed = JSON.parse(args); } catch { throw new Error("Arguments must be a JSON array"); }
    }
    const base = { network: env.network, value: value.trim() || undefined };
    return mode === "deploy"
      ? { ...base, bytecode: bytecode.trim(), constructorSignature: ctor.trim() || undefined, args: ctor.trim() ? parsed : undefined }
      : { ...base, to: to.trim(), ...(signature.trim() ? { signature: signature.trim(), args: parsed } : { data: data.trim() || undefined }) };
  }

  async function simulate(e: FormEvent) {
    e.preventDefault();
    setBusy("sim"); setError(null); setSent(null);
    try {
      const payload = { ...spec(), ...(from.trim() ? { from: from.trim() } : {}) };
      // With an agent that has the upgrade, simulate as its dev wallet; otherwise as `from`.
      const call = canSimulate ? env.agentApi : env.api;
      const d = await json<{ simulation: Simulation }>(call("dev/simulate", { method: "POST", body: JSON.stringify(payload) }));
      setSim(d.simulation);
    } catch (err) {
      setSim(null);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    setBusy("send"); setError(null);
    try {
      const path = mode === "deploy" ? "dev/deploy" : "dev/send";
      setSent(await json<SendResult>(env.agentApi(path, { method: "POST", body: JSON.stringify(spec()) })));
      env.refreshAgents();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader icon={FlaskConical} title="Simulate & send"
        description="Dry-run any call or deployment with eth_call + gas estimate — on mainnet too. On a testnet, send it from the agent's own wallet; a call that would revert is never sent." />
      <Card>
        <form className="space-y-3" onSubmit={simulate}>
          <div role="radiogroup" aria-label="Kind" className="inline-flex rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-0.5">
            {(["call", "deploy"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                className={cx("h-8 rounded-md px-3 text-xs font-medium", mode === m ? "bg-[hsl(var(--background))] shadow-sm" : muted)}>
                {m === "call" ? "Call / send ETH" : "Deploy contract"}
              </button>
            ))}
          </div>
          {mode === "call" ? (
            <>
              <Field label="To">{(id) => <TextInput id={id} mono placeholder="0x… contract or recipient" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
              <Field label="Function signature" hint="Leave empty to send raw calldata (or nothing, for a plain ETH send).">
                {(id) => <TextInput id={id} mono placeholder="approve(address spender, uint256 amount) returns (bool)" value={signature} onChange={(e) => setSignature(e.target.value)} />}
              </Field>
              {signature.trim()
                ? <Field label="Arguments (JSON array)">{(id) => <TextInput id={id} mono value={args} onChange={(e) => setArgs(e.target.value)} />}</Field>
                : <Field label="Calldata">{(id) => <TextInput id={id} mono placeholder="0x" value={data} onChange={(e) => setData(e.target.value)} />}</Field>}
            </>
          ) : (
            <>
              <Field label="Creation bytecode" hint="From your compiler output (solc / forge build): the `bytecode.object`.">{(id) => (
                <textarea id={id} rows={4} spellCheck={false} placeholder="0x6080604052…" value={bytecode} onChange={(e) => setBytecode(e.target.value)}
                  className="w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]" />
              )}</Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Constructor (optional)">{(id) => <TextInput id={id} mono placeholder="constructor(string name, uint256 supply)" value={ctor} onChange={(e) => setCtor(e.target.value)} />}</Field>
                <Field label="Constructor args (JSON array)">{(id) => <TextInput id={id} mono value={args} onChange={(e) => setArgs(e.target.value)} disabled={!ctor.trim()} />}</Field>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Value (ETH)" className="w-36">{(id) => <TextInput id={id} mono inputMode="decimal" placeholder="0" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Field label={canSimulate ? "Simulate as (optional)" : "Simulate as"} className="min-w-0 flex-1 basis-56"
              hint={canSimulate ? `Defaults to ${agent!.name}'s dev wallet.` : "Any address — the call runs with its balance and permissions."}>
              {(id) => <TextInput id={id} mono placeholder={canSimulate && agent?.devWallet ? agent.devWallet : "0x…"} value={from} onChange={(e) => setFrom(e.target.value)} />}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" icon={FlaskConical} loading={busy === "sim"}>Simulate</Button>
            <Button icon={Send} loading={busy === "send"} disabled={!canSend || !sim?.success} onClick={send}
              title={sendBlocker ?? (!sim?.success ? "Simulate successfully first" : undefined)}>
              Send from {agent?.name ?? "agent"}
            </Button>
            {sendBlocker && <span className={cx("text-xs", muted)}>{sendBlocker}</span>}
          </div>
        </form>
      </Card>

      {error && <Notice>{error}</Notice>}

      {sim && (
        <Card title={<span className="flex items-center gap-2">Simulation <Badge tone={sim.success ? "success" : "danger"}>{sim.success ? "would succeed" : "would revert"}</Badge></span>}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Gas" value={sim.gasEstimate ? Number(sim.gasEstimate).toLocaleString() : "—"} />
            <Stat label="Max fee" value={sim.feeEstimateEth ? `${amt(sim.feeEstimateEth, 8)} ETH` : "—"} />
            <Stat label="From" value={<Addr value={sim.from} env={env} />} />
          </div>
          <div className="mt-3 space-y-3">
            {sim.revert ? <RevertNotice revert={sim.revert} /> : sim.error ? <Notice>{sim.error}</Notice> : null}
            {sim.success && sim.canAfford === false && <Notice tone="warning" title="Sender can't pay for this">It holds {amt(sim.fromBalanceEth ?? "0", 8)} ETH — less than the value plus max gas. A send would be refused.</Notice>}
            {sim.result != null && <Json value={sim.result} title="Return value" />}
          </div>
        </Card>
      )}

      {sent && (
        <Notice tone={sent.status === "success" ? "success" : sent.status === "pending" ? "info" : "danger"}
          title={sent.status === "success" ? (sent.contractAddress ? "Deployed" : "Sent") : sent.status === "pending" ? "Sent — still pending" : sent.status === "rejected" ? "Rejected in simulation — nothing sent" : "Reverted on-chain"}>
          {sent.contractAddress && <div>Contract <span className="font-mono">{sent.contractAddress}</span></div>}
          {sent.gasUsed && <div>{Number(sent.gasUsed).toLocaleString()} gas · {amt(sent.feeEth ?? "0", 8)} ETH</div>}
          {sent.error && <div className="font-mono">{sent.error}</div>}
          {sent.hash && (
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" className="underline" onClick={() => env.go("tx", sent.hash!)}>Inspect tx</button>
              {sent.explorerUrl && <a className="underline" href={sent.explorerUrl} target="_blank" rel="noreferrer">Explorer ↗</a>}
            </div>
          )}
        </Notice>
      )}

      <Card>
        <p className={cx("text-xs", muted)}>
          Agents do the same with <code className="font-mono">eth_simulate</code>, <code className="font-mono">eth_send</code> and <code className="font-mono">eth_deploy_contract</code>.
          Sends carrying ETH respect the owner&apos;s per-transaction ETH limit and allowlist.
        </p>
      </Card>
    </div>
  );
}
