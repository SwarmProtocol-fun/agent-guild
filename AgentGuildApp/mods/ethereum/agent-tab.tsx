"use client";

import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  ArrowLeftRight, BookOpen, Bot, CandlestickChart, Droplets, FlaskConical, History, LineChart, Lock, Plug, RefreshCw, Rocket, ScanSearch, Send, Sparkles, Wallet, type LucideProps,
} from "lucide-react";
import {
  Addr, Badge, Button, Card, CodeBlock, EmptyState, ErrorNote, Field, Notice, Select, Skeleton, Stat, TextInput, amt, cx, json, muted, timeAgo,
  type Env, type Tab,
} from "./ui";
import { NETWORKS, SIGNING_NETWORKS, type EthNetwork } from "./networks";

// The Overview tab: what the selected agent has been upgraded with, its
// testnet wallet, how to plug its runtime in, and a live feed of what it did.

export const UPGRADES: { key: string; name: string; description: string; icon: ComponentType<LucideProps>; tab: Tab }[] = [
  { key: "eth-inspect", name: "Read & debug chain", icon: ScanSearch, tab: "tx", description: "Decode failed transactions, inspect addresses, proxies and tokens, read contracts, check gas, prices and swap quotes." },
  { key: "eth-simulate", name: "Simulate calls", icon: FlaskConical, tab: "simulate", description: "Dry-run any call or deployment on any network — mainnet included — for the result, gas and a decoded revert." },
  { key: "eth-testnet", name: "Act on testnets", icon: Send, tab: "simulate", description: "Sign with its own wallet on Sepolia and Base Sepolia: send transactions, transfer ETH and tokens, deploy contracts." },
  { key: "eth-trade", name: "Trade (paper)", icon: CandlestickChart, tab: "trade", description: "Swap any Ethereum token at live KyberSwap quotes, paying real gas, in a 10k USDC paper wallet with limits you set." },
];

export interface AgentsState { status: "loading" | "error" | "ready"; count: number; error: string | null; retry: () => void }

interface Me {
  capabilities: Record<string, boolean>;
  devWallet: { address: string; balances: Record<string, string | null> } | null;
  faucets: Record<string, { label: string; url: string }[]>;
}

interface Activity { at: string; via: "agent" | "session"; action: string; network?: EthNetwork; ok: boolean; summary: string; hash?: string; explorerUrl?: string }

const ACTION_ICON: Record<string, ComponentType<LucideProps>> = {
  inspect: ScanSearch, read: BookOpen, decode: ScanSearch, simulate: FlaskConical, send: Send, transfer: Send, deploy: Rocket,
  "create-wallet": Wallet, price: LineChart, quote: ArrowLeftRight, "paper-swap": CandlestickChart, "paper-reset": CandlestickChart, policy: Lock,
};
const ACTION_LABEL: Record<string, string> = {
  inspect: "Inspected", read: "Read contract", decode: "Decoded", simulate: "Simulated", send: "Sent transaction", transfer: "Transferred", deploy: "Deployed contract",
  "create-wallet": "Created wallet", price: "Checked prices", quote: "Swap quote", "paper-swap": "Paper swap", "paper-reset": "Paper wallet reset", policy: "Limits changed",
};

export function initials(name: string) {
  return name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "A";
}

export function AgentAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const dims = { sm: "h-7 w-7 text-[11px]", md: "h-9 w-9 text-xs", lg: "h-12 w-12 text-base" }[size];
  return (
    <div className={cx("flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#7221FA] to-[#27A0FD] font-semibold text-white", dims)} aria-hidden>
      {initials(name)}
    </div>
  );
}

export function AgentTab({ env, agents }: { env: Env; agents: AgentsState }) {
  const agent = env.agent;
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [sendNet, setSendNet] = useState<EthNetwork>("sepolia");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("0.001");
  const [sendToken, setSendToken] = useState("");

  const agentId = agent?.agentId;
  const { agentApi } = env;
  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const [meData, act] = await Promise.all([json<Me>(agentApi("me")), json<{ activity: Activity[] }>(agentApi("activity")).catch(() => ({ activity: [] }))]);
      setMe(meData);
      setMeError(null);
      setActivity(act.activity);
    } catch (err) {
      setMeError((err as Error).message);
    }
  }, [agentId, agentApi]);

  useEffect(() => {
    setMe(null);
    setActivity(null);
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(label: string, path: string, payload: Record<string, unknown>, describe: (d: Record<string, unknown>) => { ok: boolean; text: string }) {
    setBusy(label);
    setNote(null);
    try {
      setNote(describe(await json<Record<string, unknown>>(env.agentApi(path, { method: "POST", body: JSON.stringify(payload) }))));
      env.refreshAgents();
      await load();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!agent) {
    if (agents.status === "loading") return <div className="space-y-4"><Skeleton className="h-24" /><div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div></div>;
    if (agents.status === "error") {
      return <Notice title="Couldn't load your agents" action={<Button icon={RefreshCw} onClick={agents.retry}>Retry</Button>}>{agents.error ?? "The agent list request failed."} The debug tools still work without an agent.</Notice>;
    }
    if (agents.count === 0) {
      return (
        <EmptyState icon={Bot} title="No agents in your organizations yet">
          <p>Create an agent first, then come back to give it Ethereum upgrades.</p>
          <a href="/agents" className="mt-3 inline-flex h-9 items-center rounded-md bg-[hsl(var(--primary))] px-3 text-sm font-medium text-white">Go to Agents</a>
        </EmptyState>
      );
    }
    return (
      <div className="space-y-4">
        <Notice tone="info" title="Pick an agent in the sidebar">Upgrades are granted per org; pick an agent to see what it has and to act as it.</Notice>
        <div className="grid gap-3 sm:grid-cols-2">{UPGRADES.map((u) => <UpgradeTile key={u.key} upgrade={u} />)}</div>
      </div>
    );
  }

  const caps = me?.capabilities ?? agent.capabilities;
  const enabled = UPGRADES.filter((u) => caps[u.key]).length;
  const canTestnet = !!caps["eth-testnet"];
  const toolsUrl = typeof window === "undefined" ? "/api/mods/ethereum/agent/tools" : `${window.location.origin}/api/mods/ethereum/agent/tools`;

  return (
    <div className="space-y-4">
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
            {SIGNING_NETWORKS.map((n) => (
              <Stat key={n} label={NETWORKS[n].label} value={me ? (me.devWallet?.balances[n] != null ? `${amt(me.devWallet.balances[n]!, 5)} ETH` : "—") : "…"} />
            ))}
          </div>
        </div>
      </Card>

      {meError && <ErrorNote message={meError} onRetry={load} />}

      <Card title="Upgrades" description="Each one unlocks a set of tools for this agent. Granted per org."
        actions={enabled < UPGRADES.length && agent.isOwner ? (
          <Button variant="primary" icon={Sparkles} loading={busy === "upgrade"}
            onClick={() => act("upgrade", "upgrade", { orgId: agent.orgId }, (d) => ({ ok: true, text: `Enabled ${(d.enabled as string[]).length} upgrade(s) for ${agent.orgName}` }))}>Enable all</Button>
        ) : undefined}>
        <div className="grid gap-3 sm:grid-cols-2">{UPGRADES.map((u) => <UpgradeTile key={u.key} upgrade={u} on={!!caps[u.key]} onOpen={() => env.go(u.tab, "")} />)}</div>
        {enabled < UPGRADES.length && !agent.isOwner && <p className={cx("mt-3 text-xs", muted)}>Only the owner of {agent.orgName} can enable upgrades.</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Wallet className="h-4 w-4" aria-hidden />Dev wallet</span>}
          description="The agent's own key for Sepolia and Base Sepolia. Separate from its payout wallets; never leaves the server.">
          {!me ? <Skeleton className="h-28" /> : !me.devWallet ? (
            <div className="space-y-3">
              <p className={cx("text-sm", muted)}>No dev wallet yet. The agent can create one itself with <code className="font-mono">eth_create_wallet</code>.</p>
              <Button variant="primary" icon={Wallet} disabled={!canTestnet} loading={busy === "wallet"}
                onClick={() => act("wallet", "dev/wallet", {}, (d) => ({ ok: true, text: `Created ${d.address}` }))}>Create dev wallet</Button>
              {!canTestnet && <p className={cx("text-xs", muted)}>Needs the “Act on testnets” upgrade.</p>}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className={cx("text-xs", muted)}>Address (same on every network)</div>
                <Addr value={me.devWallet.address} env={env} />
              </div>
              <div className="space-y-1.5">
                <div className={cx("flex items-center gap-1.5 text-xs", muted)}><Droplets className="h-3.5 w-3.5" aria-hidden />Fund it from a faucet — paste the address there</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {SIGNING_NETWORKS.flatMap((n) => (me.faucets[n] ?? []).map((f) => (
                    <a key={`${n}-${f.label}`} className="text-sm text-[hsl(var(--primary))] hover:underline" href={f.url} target="_blank" rel="noreferrer">{NETWORKS[n].label} · {f.label} ↗</a>
                  )))}
                </div>
              </div>
              <form className="space-y-2 border-t border-[hsl(var(--border))]/60 pt-3" onSubmit={(e) => {
                e.preventDefault();
                act("send", "dev/transfer", { network: sendNet, to: sendTo.trim(), amount: sendAmount.trim(), token: sendToken.trim() || undefined }, (d) => ({
                  ok: d.status === "success" || d.status === "pending",
                  text: d.status === "success" ? `Sent ${d.amountUi} ${d.symbol} to ${String(d.to).slice(0, 10)}…` : d.status === "pending" ? `Sent — still pending (${d.hash})` : `${d.status}: ${d.error ?? "failed"}`,
                }));
              }}>
                <Field label="Send to">{(id) => <TextInput id={id} mono placeholder="0x… or name.eth" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />}</Field>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Network">{(id) => (
                    <Select id={id} value={sendNet} onChange={(e) => setSendNet(e.target.value as EthNetwork)}>
                      {SIGNING_NETWORKS.map((n) => <option key={n} value={n}>{NETWORKS[n].label}</option>)}
                    </Select>
                  )}</Field>
                  <Field label="Amount" className="w-28">{(id) => <TextInput id={id} mono inputMode="decimal" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />}</Field>
                  <Field label="Token" className="min-w-0 flex-1 basis-40">{(id) => <TextInput id={id} mono placeholder="Empty = ETH" value={sendToken} onChange={(e) => setSendToken(e.target.value)} />}</Field>
                  <Button type="submit" icon={Send} disabled={!canTestnet || !sendTo.trim() || !sendAmount.trim()} loading={busy === "send"}>Send</Button>
                </div>
              </form>
            </div>
          )}
          {note && <div className="mt-3"><Notice tone={note.ok ? "success" : "danger"}>{note.text}</Notice></div>}
        </Card>

        <Card title={<span className="flex items-center gap-2"><Plug className="h-4 w-4" aria-hidden />Connect the agent</span>}
          description="Agents on the Agent Guild CLI or MCP server already have these tools. Other runtimes load the definitions and sign each call.">
          <div className="space-y-3">
            <CodeBlock title="From the agent's machine" code={"agent-guild mod tools ethereum\nagent-guild mod call ethereum eth_me"} maxHeight="max-h-24" wrap />
            <CodeBlock title="Tool definitions (any runtime)" code={`curl ${toolsUrl}`} maxHeight="max-h-24" wrap />
            <ol className={cx("list-decimal space-y-1 pl-4 text-xs", muted)}>
              <li>Call <code className="font-mono text-[hsl(var(--foreground))]">eth_me</code> to see its upgrades and wallet.</li>
              <li>On a failed tx, <code className="font-mono text-[hsl(var(--foreground))]">eth_inspect_transaction</code> gives the decoded revert reason.</li>
              <li>Always <code className="font-mono text-[hsl(var(--foreground))]">eth_simulate</code> before <code className="font-mono text-[hsl(var(--foreground))]">eth_send</code> — sends that would revert are refused anyway.</li>
              <li>Trade on paper with <code className="font-mono text-[hsl(var(--foreground))]">eth_paper_swap</code>, within the limits on the Trade tab.</li>
            </ol>
          </div>
        </Card>
      </div>

      <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4" aria-hidden />Activity</span>} description="What this agent has done with the mod, newest first. Updates live.">
        {activity === null ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          : activity.length === 0 ? <p className={cx("py-6 text-center text-sm", muted)}>Nothing yet — actions the agent takes through its Ethereum tools show up here.</p>
          : (
            <ol className="space-y-0.5">
              {activity.map((a, i) => {
                const IconC = ACTION_ICON[a.action] ?? Bot;
                return (
                  <li key={`${a.at}-${i}`} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[hsl(var(--accent))]/40">
                    <div className={cx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", a.ok ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]" : "bg-red-500/10 text-red-600 dark:text-red-400")}>
                      <IconC className="h-3.5 w-3.5" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 text-sm">
                        <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                        {!a.ok && <Badge tone="danger">failed</Badge>}
                        {a.network && <span className={cx("text-xs", muted)}>{NETWORKS[a.network]?.label ?? a.network}</span>}
                        {a.via === "session" && <span className={cx("text-xs", muted)}>· by you</span>}
                      </div>
                      <div className={cx("truncate text-xs", muted)} title={a.summary}>{a.summary}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {a.explorerUrl && <a className="inline-flex h-7 items-center rounded-md px-2 text-xs hover:bg-[hsl(var(--accent))]" href={a.explorerUrl} target="_blank" rel="noreferrer">View tx ↗</a>}
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
    <div className={cx("flex gap-3 rounded-lg border p-3 transition-colors", state ? "border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/5" : "border-[hsl(var(--border))]")}>
      <div className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", state ? "bg-[hsl(var(--primary))] text-white" : cx("bg-[hsl(var(--muted))]", muted))}>
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
