"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bot, Coins, Droplets, FlaskConical, Hammer, History, Lock, Plug, RefreshCw, ScanSearch, Send, Sparkles, Wallet, type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  Addr, Badge, Button, Card, CodeBlock, EmptyState, ErrorNote, Field, Notice, Skeleton, Stat, TextInput, cx, muted, timeAgo,
  type Env, type Tab,
} from "./ui";

// The Agent tab: what the selected agent has been upgraded with, its devnet
// wallet, how to plug its runtime in, and a live feed of what it has done.

export const UPGRADES: { key: string; name: string; description: string; icon: ComponentType<LucideProps>; tab: Tab }[] = [
  { key: "solana-dev-inspect", name: "Read & debug chain", icon: ScanSearch, tab: "tx", description: "Decode failed transactions and program errors, inspect accounts and programs, read IDLs, derive PDAs." },
  { key: "solana-dev-simulate", name: "Build & simulate", icon: FlaskConical, tab: "simulate", description: "Turn plain-JSON instructions into transactions with the program's IDL and dry-run them." },
  { key: "solana-dev-devnet", name: "Act on devnet", icon: Send, tab: "network", description: "Sign and send with its own dev wallet: airdrop, send transactions, create tokens, deploy." },
  { key: "solana-dev-anchor", name: "Write Anchor programs", icon: Hammer, tab: "anchor", description: "Build, test and deploy Anchor programs in a sandboxed container." },
  { key: "solana-settlement", name: "Settle jobs", icon: Coins, tab: "settlement", description: "Get paid in USDC on Solana for completed jobs, with an on-chain receipt." },
];

export interface AgentsState {
  status: "loading" | "error" | "ready";
  count: number;
  error: string | null;
  retry: () => void;
}

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

const ACTION_ICON: Record<string, ComponentType<LucideProps>> = {
  inspect: ScanSearch, "derive-pda": ScanSearch, simulate: FlaskConical, send: Send, airdrop: Droplets,
  "create-token": Coins, "create-wallet": Wallet,
};
const ACTION_LABEL: Record<string, string> = {
  inspect: "Inspected", "derive-pda": "Derived PDA", simulate: "Simulated", send: "Sent transaction", airdrop: "Airdrop",
  "create-token": "Created token", "create-wallet": "Created wallet", "anchor-build": "Anchor build", "anchor-test": "Anchor test", "anchor-deploy": "Anchor deploy",
};

export function initials(name: string) {
  return name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "A";
}

export function AgentAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const dims = { sm: "h-7 w-7 text-[11px]", md: "h-9 w-9 text-xs", lg: "h-12 w-12 text-base" }[size];
  // Brand gradient (violet → blue, see brand.md).
  return (
    <div className={cx("flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#7221FA] to-[#27A0FD] font-semibold text-white", dims)} aria-hidden>
      {initials(name)}
    </div>
  );
}

export function AgentTab({ env, modId, agents }: { env: Env; modId: string; agents: AgentsState }) {
  const agent = env.agent;
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
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
    setActivity(null);
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

  // ── No agent selected: explain why, by state ──
  if (!agent) {
    if (agents.status === "loading") {
      return <div className="space-y-4"><Skeleton className="h-24" /><div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div></div>;
    }
    if (agents.status === "error") {
      return (
        <Notice title="Couldn't load your agents" action={<Button icon={RefreshCw} onClick={agents.retry}>Retry</Button>}>
          {agents.error ?? "The agent list request failed."} The debug tools still work without an agent.
        </Notice>
      );
    }
    if (agents.count === 0) {
      return (
        <EmptyState icon={Bot} title="No agents in your organizations yet">
          <p>Create an agent first, then come back to give it Solana upgrades.</p>
          <a href="/agents" className={cx("mt-3", "inline-flex h-9 items-center rounded-md bg-[hsl(var(--primary))] px-3 text-sm font-medium text-white")}>Go to Agents</a>
        </EmptyState>
      );
    }
    return (
      <div className="space-y-4">
        <Notice tone="info" title="Pick an agent in the sidebar">The upgrades below are granted per org; pick an agent to see what it has and to act as it.</Notice>
        <div className="grid gap-3 sm:grid-cols-2">
          {UPGRADES.map((u) => <UpgradeTile key={u.key} upgrade={u} />)}
        </div>
      </div>
    );
  }

  const caps = me?.capabilities ?? agent.capabilities;
  const enabled = UPGRADES.filter((u) => caps[u.key]).length;
  const canDevnet = !!caps["solana-dev-devnet"];
  const signingCluster = env.cluster === "testnet" ? "testnet" : "devnet";
  const toolsUrl = typeof window === "undefined" ? `/api/mods/${modId}/agent/tools` : `${window.location.origin}/api/mods/${modId}/agent/tools`;
  const balance = me?.devWallet?.balances?.[signingCluster];

  return (
    <div className="space-y-4">
      {/* Hero */}
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <AgentAvatar name={agent.name} size="lg" />
          <div className="min-w-0 flex-1 basis-48">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{agent.name}</h2>
              <Badge tone={enabled === UPGRADES.length ? "success" : "info"}>{enabled}/{UPGRADES.length} upgrades</Badge>
            </div>
            <p className={cx("text-sm", muted)}>{agent.orgName} · <span className="font-mono text-xs">{agent.agentId}</span></p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
            {(["devnet", "testnet"] as const).map((c) => (
              <Stat key={c} label={c} value={me ? (me.devWallet?.balances?.[c] != null ? `${me.devWallet.balances[c]} SOL` : "—") : "…"} />
            ))}
          </div>
        </div>
      </Card>

      {meError && <ErrorNote message={meError} onRetry={load} />}

      {/* Upgrades */}
      <Card title="Upgrades" description="Each one unlocks a set of tools for this agent. Granted per org."
        actions={enabled < UPGRADES.length && agent.isOwner ? (
          <Button variant="primary" icon={Sparkles} loading={busy === "upgrade"}
            onClick={() => act("upgrade", "upgrade", { orgId: agent.orgId }, (d) => `Enabled ${(d.enabled as string[]).length} upgrade(s) for ${agent.orgName}`)}>
            Enable all
          </Button>
        ) : undefined}>
        <div className="grid gap-3 sm:grid-cols-2">
          {UPGRADES.map((u) => <UpgradeTile key={u.key} upgrade={u} on={!!caps[u.key]} onOpen={() => env.go(u.tab, "")} />)}
        </div>
        {enabled < UPGRADES.length && !agent.isOwner && (
          <p className={cx("mt-3 text-xs", muted)}>Only the owner of {agent.orgName} can enable upgrades.</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Wallet */}
        <Card title={<span className="flex items-center gap-2"><Wallet className="h-4 w-4" aria-hidden />Dev wallet</span>}
          description="The agent's own key for devnet/testnet. Separate from its payout wallet; never leaves the server.">
          {!me ? <Skeleton className="h-28" /> : !me.devWallet ? (
            <div className="space-y-3">
              <p className={cx("text-sm", muted)}>No dev wallet yet. The agent can create one itself with <code className="font-mono">solana_create_wallet</code>.</p>
              <Button variant="primary" icon={Wallet} disabled={!canDevnet} loading={busy === "wallet"}
                onClick={() => act("wallet", "dev/wallet", {}, (d) => `Created ${d.address}`)}>Create dev wallet</Button>
              {!canDevnet && <p className={cx("text-xs", muted)}>Needs the “Act on devnet” upgrade.</p>}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className={cx("text-xs", muted)}>Address</div>
                <Addr value={me.devWallet.address} env={env} />
              </div>
              <div>
                <div className={cx("text-xs", muted)}>{signingCluster} balance</div>
                <div className="font-mono text-2xl font-semibold tabular-nums">{balance != null ? balance : "—"} <span className={cx("text-sm", muted)}>SOL</span></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button icon={Droplets} disabled={!canDevnet} loading={busy === "airdrop"}
                  onClick={() => act("airdrop", "dev/airdrop", { sol: 1, cluster: signingCluster }, (d) => `+1 SOL · balance ${d.balanceSol} SOL`)}>Airdrop 1 SOL</Button>
                <a className="inline-flex h-9 items-center rounded-md px-3 text-sm text-[hsl(var(--primary))] hover:underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com ↗</a>
              </div>
              <form className="flex flex-wrap items-end gap-2 border-t border-[hsl(var(--border))]/60 pt-3" onSubmit={(e) => {
                e.preventDefault();
                act("token", "dev/token", { decimals: Number(decimals), mintAmount, cluster: signingCluster }, (d) => `Created mint ${d.mint}`);
              }}>
                <Field label="Decimals" className="w-24">{(id) => <TextInput id={id} mono inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ""))} />}</Field>
                <Field label="Mint to self" className="w-32">{(id) => <TextInput id={id} mono inputMode="decimal" value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} />}</Field>
                <Button type="submit" icon={Coins} disabled={!canDevnet} loading={busy === "token"}>Create token</Button>
              </form>
            </div>
          )}
          {note && <div className="mt-3"><Notice tone={note.ok ? "success" : "danger"}>{note.text}</Notice></div>}
        </Card>

        {/* Connect */}
        <Card title={<span className="flex items-center gap-2"><Plug className="h-4 w-4" aria-hidden />Connect the agent</span>}
          description="Load these tools into the agent's LLM loop. Each call is a signed request to this mod.">
          <div className="space-y-3">
            <CodeBlock title="Tool definitions" code={`curl ${toolsUrl}`} maxHeight="max-h-24" wrap />
            <ol className={cx("list-decimal space-y-1 pl-4 text-xs", muted)}>
              <li>Call <code className="font-mono text-[hsl(var(--foreground))]">solana_me</code> to see which upgrades it has.</li>
              <li>Debug with <code className="font-mono text-[hsl(var(--foreground))]">solana_inspect_transaction</code> on a failing signature.</li>
              <li>Always <code className="font-mono text-[hsl(var(--foreground))]">solana_simulate</code> before <code className="font-mono text-[hsl(var(--foreground))]">solana_send</code>.</li>
            </ol>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs">
              <span className="flex items-center gap-2"><Hammer className="h-3.5 w-3.5" aria-hidden />Anchor sandbox</span>
              {!me ? <Skeleton className="h-4 w-20" /> : me.anchor.workersOnline > 0
                ? <Badge tone="success" dot>{me.anchor.workersOnline} worker{me.anchor.workersOnline === 1 ? "" : "s"} online</Badge>
                : <Badge tone="warning" dot>No worker online</Badge>}
            </div>
            {me && me.anchor.workersOnline === 0 && (
              <p className={cx("text-xs", muted)}>Run <code className="font-mono">gateway-agent register --runtimes docker,solana-anchor</code> on a machine with Docker.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Activity */}
      <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4" aria-hidden />Activity</span>} description="What this agent has done with the mod. Live; resets when the server restarts.">
        {activity === null ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : activity.length === 0 ? (
          <p className={cx("py-6 text-center text-sm", muted)}>Nothing yet — actions the agent takes through its Solana tools show up here.</p>
        ) : (
          <ol className="relative space-y-0.5">
            {activity.map((a, i) => {
              const IconC = ACTION_ICON[a.action] ?? (a.action.startsWith("anchor") ? Hammer : Bot);
              return (
                <li key={`${a.at}-${i}`} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[hsl(var(--accent))]/40">
                  <div className={cx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", a.ok ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]" : "bg-red-500/10 text-red-600 dark:text-red-400")}>
                    <IconC className="h-3.5 w-3.5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-sm">
                      <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                      {!a.ok && <Badge tone="danger">failed</Badge>}
                      {a.cluster && <span className={cx("text-xs", muted)}>{a.cluster}</span>}
                      {a.via === "session" && <span className={cx("text-xs", muted)}>· by you</span>}
                    </div>
                    <div className={cx("truncate text-xs", muted)} title={a.summary}>{a.summary}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {a.signature && <Button className="h-7 px-2 text-xs" variant="ghost" onClick={() => env.go("tx", a.signature!)}>View tx</Button>}
                    {a.taskId && <Button className="h-7 px-2 text-xs" variant="ghost" onClick={() => env.go("anchor", a.taskId!)}>View job</Button>}
                    <time className={cx("w-16 text-right text-xs tabular-nums", muted)} dateTime={a.at} title={new Date(a.at).toLocaleString()}>{timeAgo(a.at)}</time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}

function UpgradeTile({ upgrade: u, on, onOpen }: { upgrade: (typeof UPGRADES)[number]; on?: boolean; onOpen?: () => void }) {
  const IconC = u.icon;
  const state = on === undefined ? null : on;
  return (
    <div className={cx("flex gap-3 rounded-lg border p-3 transition-colors",
      state ? "border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/5" : "border-[hsl(var(--border))]")}>
      <div className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
        state ? "bg-[hsl(var(--primary))] text-white" : "bg-[hsl(var(--muted))]", !state && muted)}>
        <IconC className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{u.name}</span>
          {state === true && <Badge tone="success" dot>On</Badge>}
          {state === false && <span className={cx("inline-flex items-center gap-1 text-[11px]", muted)}><Lock className="h-3 w-3" aria-hidden />Off</span>}
        </div>
        <p className={cx("mt-0.5 text-xs", muted)}>{u.description}</p>
        {state && onOpen && <button type="button" onClick={onOpen} className="mt-1.5 rounded-sm text-xs font-medium text-[hsl(var(--primary))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]">Open tools →</button>}
      </div>
    </div>
  );
}

