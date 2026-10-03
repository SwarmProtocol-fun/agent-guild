"use client";

import { useCallback, useEffect, useState } from "react";
import { Addr, Badge, CopyButton, ErrorNote, Section, buttonClass, inputClass, muted, type Env } from "./ui";

// The Agent tab: what the selected agent has been upgraded with, its devnet
// wallet, and a live feed of what it has done with the mod.

export const UPGRADES: { key: string; name: string; description: string }[] = [
  { key: "solana-dev-inspect", name: "Read & debug chain", description: "Decode failed transactions and program errors, inspect accounts and programs, read Anchor IDLs, derive PDAs, check fees and rent." },
  { key: "solana-dev-simulate", name: "Build & simulate", description: "Turn plain-JSON instructions into transactions using the program's IDL and simulate them for logs, CU and decoded errors." },
  { key: "solana-dev-devnet", name: "Act on devnet", description: "Sign and send devnet transactions with its own dev wallet: airdrop, send, create tokens, deploy." },
  { key: "solana-dev-anchor", name: "Write Anchor programs", description: "Build, test and deploy Anchor programs in a sandboxed GatewayAgent container." },
  { key: "solana-settlement", name: "Settle jobs", description: "Get paid in USDC on Solana for completed jobs, with an on-chain receipt." },
];

interface Me {
  capabilities: Record<string, boolean>;
  devWallet: { address: string; balances: Record<string, number | null> | null } | null;
  anchor: { workersOnline: number; versions: string[] };
}

interface Activity {
  at: string;
  via: "agent" | "session";
  action: string;
  cluster?: string;
  ok: boolean;
  summary: string;
  signature?: string;
  taskId?: string;
}

export function AgentTab({ env, modId }: { env: Env; modId: string }) {
  const agent = env.agent;
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [decimals, setDecimals] = useState("9");
  const [mintAmount, setMintAmount] = useState("1000");

  const agentId = agent?.agentId;
  const { agentApi } = env; // stable per selected agent (useCallback in the panel shell)
  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const [meRes, actRes] = await Promise.all([agentApi("me"), agentApi("activity")]);
      const meData = await meRes.json();
      if (!meRes.ok) throw new Error(meData.error);
      setMe(meData);
      setMeError(null);
      setActivity((await actRes.json()).activity ?? []);
    } catch (err) {
      setMeError((err as Error).message);
    }
  }, [agentId, agentApi]);

  useEffect(() => {
    setMe(null);
    setActivity([]);
    load();
    // Activity is what the agent does on its own — keep it live.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(label: string, path: string, payload: Record<string, unknown>, describe: (d: Record<string, unknown>) => string) {
    setBusy(label);
    setNote(null);
    try {
      const res = await env.agentApi(path, { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNote({ ok: true, text: describe(data) });
      env.refreshAgents();
      await load();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!agent) {
    return (
      <Section title="Upgrade your agents" description="Pick an agent in the header to see and manage its Solana upgrades.">
        <ul className="space-y-2">
          {UPGRADES.map((u) => (
            <li key={u.key}><span className="font-medium">{u.name}</span> <span className={`text-xs ${muted}`}>— {u.description}</span></li>
          ))}
        </ul>
      </Section>
    );
  }

  const caps = me?.capabilities ?? agent.capabilities;
  const missing = UPGRADES.filter((u) => !caps[u.key]);
  const canDevnet = !!caps["solana-dev-devnet"];
  const signingCluster = env.cluster === "testnet" ? "testnet" : "devnet";
  const toolsUrl = typeof window === "undefined" ? `/api/mods/${modId}/agent/tools` : `${window.location.origin}/api/mods/${modId}/agent/tools`;

  return (
    <div className="space-y-3">
      {meError && <ErrorNote message={meError} />}

      <Section
        title={`${agent.name} · upgrades`}
        description={`${agent.orgName} — upgrades are granted per org by installing this mod.`}
        right={missing.length > 0 && agent.isOwner ? (
          <button type="button" className={buttonClass(true)} disabled={busy === "upgrade"}
            onClick={() => act("upgrade", "upgrade", { orgId: agent.orgId }, (d) => `Enabled ${(d.enabled as string[]).length} upgrade(s) for ${agent.orgName}`)}>
            {busy === "upgrade" ? "…" : "Enable all"}
          </button>
        ) : undefined}
      >
        <div className="space-y-2">
          {UPGRADES.map((u) => (
            <div key={u.key} className="flex items-start gap-2">
              <Badge tone={caps[u.key] ? "success" : "neutral"}>{caps[u.key] ? "on" : "off"}</Badge>
              <div>
                <div className="text-sm font-medium">{u.name}</div>
                <div className={`text-xs ${muted}`}>{u.description}</div>
              </div>
            </div>
          ))}
        </div>
        {missing.length > 0 && !agent.isOwner && (
          <p className={`text-xs ${muted}`}>Ask the owner of {agent.orgName} to enable the missing upgrades (or install the mod from the <a className="underline" href={`/market/${modId}`}>Market</a>).</p>
        )}
      </Section>

      <Section title="Dev wallet" description="The agent's own Solana wallet for devnet/testnet. Separate from its payout wallet; the key never leaves the server.">
        {!me?.devWallet ? (
          <div className="flex items-center gap-3">
            <button type="button" className={buttonClass(true)} disabled={!canDevnet || busy === "wallet"}
              onClick={() => act("wallet", "dev/wallet", {}, (d) => `Created ${d.address}`)}>
              {busy === "wallet" ? "…" : "Create dev wallet"}
            </button>
            {!canDevnet && <span className={`text-xs ${muted}`}>Needs the &quot;Act on devnet&quot; upgrade.</span>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm"><Addr value={me.devWallet.address} env={env} /></div>
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(me.devWallet.balances ?? {}).map(([c, bal]) => (
                <div key={c}><span className={`text-xs ${muted}`}>{c}</span> <span className="font-mono text-xs">{bal == null ? "—" : `${bal} SOL`}</span></div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonClass()} disabled={!canDevnet || busy === "airdrop"}
                onClick={() => act("airdrop", "dev/airdrop", { sol: 1, cluster: signingCluster }, (d) => `+1 SOL on ${signingCluster} · balance ${d.balanceSol} SOL`)}>
                {busy === "airdrop" ? "…" : `Airdrop 1 SOL (${signingCluster})`}
              </button>
              <span className={`text-xs ${muted}`}>or fund it at</span>
              <a className="text-xs text-blue-600 dark:text-blue-400 hover:underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com ↗</a>
            </div>
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
              e.preventDefault();
              act("token", "dev/token", { decimals: Number(decimals), mintAmount, cluster: signingCluster }, (d) => `Created mint ${d.mint}`);
            }}>
              <span className="text-xs font-medium">New SPL token</span>
              <input className={`${inputClass} w-16 font-mono text-xs`} value={decimals} onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ""))} aria-label="decimals" />
              <span className={`text-xs ${muted}`}>decimals, mint</span>
              <input className={`${inputClass} w-28 font-mono text-xs`} value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} aria-label="amount to mint" />
              <button type="submit" className={buttonClass()} disabled={!canDevnet || busy === "token"}>{busy === "token" ? "…" : "Create"}</button>
            </form>
          </div>
        )}
        {note && (note.ok ? <p className="text-sm text-green-700 dark:text-green-400">✓ {note.text}</p> : <ErrorNote message={note.text} />)}
      </Section>

      <Section title="Connect the agent's runtime" description="Load these tool definitions into the agent's LLM loop; each call is a signed request to this mod.">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs break-all">{toolsUrl}</span>
          <CopyButton text={toolsUrl} />
        </div>
        <p className={`text-xs ${muted}`}>
          {`Start with solana_me, then e.g. solana_inspect_transaction on a failing signature, solana_simulate before every solana_send, and solana_anchor_job to build what it writes. `}
          Anchor sandbox: {me ? (me.anchor.workersOnline > 0
            ? <Badge tone="success">{me.anchor.workersOnline} worker{me.anchor.workersOnline === 1 ? "" : "s"} online</Badge>
            : <span>no worker online — run <span className="font-mono">gateway-agent register --runtimes docker,solana-anchor</span> on a machine with Docker</span>) : "…"}
        </p>
      </Section>

      <Section title="Activity" description="What this agent has done with the mod (refreshes every 10s; resets when the server restarts).">
        {activity.length === 0 ? <p className={`text-sm ${muted}`}>Nothing yet.</p> : (
          <div className="space-y-1">
            {activity.map((a, i) => (
              <div key={`${a.at}-${i}`} className="flex flex-wrap items-center gap-2 text-sm border-b border-[hsl(var(--border))]/50 py-1 last:border-0">
                <span className={`font-mono text-[11px] ${muted}`}>{new Date(a.at).toLocaleTimeString()}</span>
                <Badge tone={a.ok ? "neutral" : "danger"}>{a.action}</Badge>
                {a.cluster && <span className={`text-xs ${muted}`}>{a.cluster}</span>}
                <span className="text-xs min-w-0 break-all">{a.summary}</span>
                {a.via === "session" && <span className={`text-[11px] ${muted}`}>(you)</span>}
                {a.signature && (
                  <button type="button" className="text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("tx", a.signature!)}>tx</button>
                )}
                {a.taskId && (
                  <button type="button" className="text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("anchor", a.taskId!)}>job</button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
