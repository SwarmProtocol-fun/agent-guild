"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Connection } from "@solana/web3.js";
import {
  Activity, Bot, Bug, ChevronsUpDown, Coins, FileCode, Fingerprint, FlaskConical, Hammer, Lock, Receipt, RefreshCw, Search, Wallet, type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { PUBLIC_RPC, clusterStatus, detectInput, explorerUrl, type Cluster, type ClusterStatus } from "./devtools";
import { AccountTool, ErrorTool, IdlTool, NetworkTool, PdaTool, TxTool } from "./inspect-tools";
import { AgentAvatar, AgentTab, type AgentsState } from "./agent-tab";
import { SimulateTab } from "./simulate-tab";
import { AnchorTab } from "./anchor-tab";
import { SettlementTab } from "./settlement-tab";
import { Button, Notice, TextInput, cx, muted, type Env, type Seed, type SelectedAgent, type Tab } from "./ui";

// The Solana panel shell. The sidebar's agent switcher decides who the
// Agent / Simulate / Anchor views act as; the debug tools work without one.

interface NavItem { id: Tab; label: string; icon: ComponentType<LucideProps>; capability?: string }

const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Agent", items: [{ id: "agent", label: "Overview", icon: Bot }] },
  {
    group: "Debug",
    items: [
      { id: "tx", label: "Transaction", icon: Receipt, capability: "solana-dev-inspect" },
      { id: "account", label: "Account", icon: Wallet, capability: "solana-dev-inspect" },
      { id: "idl", label: "Program IDL", icon: FileCode, capability: "solana-dev-inspect" },
      { id: "pda", label: "PDA", icon: Fingerprint, capability: "solana-dev-inspect" },
      { id: "error", label: "Errors", icon: Bug, capability: "solana-dev-inspect" },
    ],
  },
  {
    group: "Build",
    items: [
      { id: "simulate", label: "Simulate & send", icon: FlaskConical, capability: "solana-dev-simulate" },
      { id: "anchor", label: "Anchor programs", icon: Hammer, capability: "solana-dev-anchor" },
    ],
  },
  { group: "Chain", items: [{ id: "network", label: "Network", icon: Activity }, { id: "settlement", label: "Settlement", icon: Coins, capability: "solana-settlement" }] },
];

const CLUSTERS: { id: Cluster; label: string }[] = [
  { id: "devnet", label: "Devnet" },
  { id: "testnet", label: "Testnet" },
  { id: "mainnet-beta", label: "Mainnet" },
  { id: "localnet", label: "Local" },
  { id: "custom", label: "Custom" },
];
const STORAGE_KEY = "solana-mod:prefs";

interface Prefs { cluster: Cluster; customUrl: string; agentId: string | null }

function loadPrefs(): Prefs {
  const fallback: Prefs = { cluster: "devnet", customUrl: "", agentId: null };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && CLUSTERS.some((c) => c.id === saved.cluster)) return { ...fallback, ...saved };
  } catch { /* storage unavailable */ }
  return fallback;
}

const DETECTED_LABEL = { tx: "Transaction", address: "Address", error: "Error code" } as const;

function SolanaPanel({ modId, address, api }: PanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { cluster, customUrl, agentId } = prefs;
  const [customDraft, setCustomDraft] = useState(customUrl);
  const [agents, setAgents] = useState<SelectedAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("agent");
  const [seeds, setSeeds] = useState<Partial<Record<Tab, Seed>>>({});
  const [search, setSearch] = useState("");
  const [searchMiss, setSearchMiss] = useState(false);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  const refreshAgents = useCallback(() => {
    setAgentsError(null);
    api("my-agents")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? `Request failed (${r.status})`);
        const list: SelectedAgent[] = d.agents ?? [];
        setAgents(list);
        // Keep the remembered agent if it still exists, else pre-select when there's only one.
        setPrefs((p) => ({ ...p, agentId: list.some((a) => a.agentId === p.agentId) ? p.agentId : list.length === 1 ? list[0].agentId : null }));
      })
      .catch((err: Error) => { setAgents(null); setAgentsError(err.message); });
  }, [api]);
  useEffect(refreshAgents, [refreshAgents]);

  const agent = agents?.find((a) => a.agentId === agentId) ?? null;
  const agentsState: AgentsState = {
    status: agentsError ? "error" : agents === null ? "loading" : "ready",
    count: agents?.length ?? 0,
    error: agentsError,
    retry: refreshAgents,
  };

  // Calls this mod's API as the selected agent: agentId in the query string and, for JSON bodies, in the body.
  const agentApi = useCallback((path: string, init?: RequestInit) => {
    if (!agentId) return Promise.resolve(Response.json({ error: "Pick an agent first" }, { status: 400 }));
    const sep = path.includes("?") ? "&" : "?";
    let body = init?.body;
    if (typeof body === "string") {
      try { body = JSON.stringify({ ...JSON.parse(body), agentId }); } catch { /* leave non-JSON bodies alone */ }
    }
    return api(`${path}${sep}agentId=${encodeURIComponent(agentId)}`, { ...init, body });
  }, [api, agentId]);

  const rpcUrl = cluster === "custom" ? customUrl : PUBLIC_RPC[cluster];
  const conn = useMemo(() => (/^https?:\/\//.test(rpcUrl) ? new Connection(rpcUrl, "confirmed") : null), [rpcUrl]);

  const refreshStatus = useCallback(() => {
    if (!conn) return;
    setStatusError(null);
    clusterStatus(conn).then(setStatus).catch((err) => {
      setStatus(null);
      setStatusError(cluster === "localnet" ? "No validator at 127.0.0.1:8899 — start one with solana-test-validator." : (err as Error).message);
    });
  }, [conn, cluster]);
  useEffect(() => {
    setStatus(null);
    refreshStatus();
    const t = setInterval(refreshStatus, 30_000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const go = useCallback((target: Tab, value: string) => {
    if (value) setSeeds((s) => ({ ...s, [target]: { value, nonce: (s[target]?.nonce ?? 0) + 1 } }));
    setTab(target);
  }, []);

  const env: Env | null = useMemo(() => conn && {
    conn, cluster, customUrl, agent, agentApi, refreshAgents, go,
    explorer: (kind: "tx" | "address", id: string) => explorerUrl(kind, id, cluster, customUrl),
  }, [conn, cluster, customUrl, agent, agentApi, refreshAgents, go]);

  // "/" focuses the command bar, like most developer tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const detected = detectInput(search);
  function onSearch(e: FormEvent) {
    e.preventDefault();
    setSearchMiss(!detected);
    if (detected) {
      go(detected === "address" ? "account" : detected, search.trim());
      setSearch("");
    }
  }

  const locked = (item: NavItem) => !!agent && !!item.capability && !agent.capabilities[item.capability];

  return (
    <div className="min-h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* Header */}
      <header className="border-b border-[hsl(var(--border))]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[#7221FA] to-[#27A0FD] text-lg font-semibold text-white" aria-hidden>◎</div>
            <div>
              <h1 className="text-base font-semibold leading-tight">Solana</h1>
              <p className={cx("text-xs", muted)}>Developer upgrades for your agents</p>
            </div>
          </div>

          <form className="order-3 w-full md:order-none md:max-w-md md:flex-1" onSubmit={onSearch} role="search">
            <label htmlFor="solana-search" className="sr-only">Search a signature, address or error code</label>
            <div className="relative">
              <Search className={cx("pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2", muted)} aria-hidden />
              <TextInput id="solana-search" ref={searchRef} mono placeholder="Signature, address or error"
                className="pl-9 pr-24" value={search}
                onChange={(e) => { setSearch(e.target.value); setSearchMiss(false); }} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2">
                {search.trim()
                  ? <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", detected ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]" : "bg-[hsl(var(--muted))]", !detected && muted)}>{detected ? `${DETECTED_LABEL[detected]} ↵` : "Unknown"}</span>
                  : <kbd className={cx("rounded border border-[hsl(var(--border))] px-1.5 font-mono text-[11px]", muted)}>/</kbd>}
              </span>
            </div>
            {searchMiss && <p className={cx("mt-1 text-xs", muted)}>That isn&apos;t a signature, address or error code.</p>}
          </form>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Cluster" className="inline-flex rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-0.5">
              {CLUSTERS.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={cluster === c.id}
                  onClick={() => setPrefs((p) => ({ ...p, cluster: c.id }))}
                  className={cx("h-8 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
                    cluster === c.id ? "bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm" : cx(muted, "hover:text-[hsl(var(--foreground))]"),
                    c.id === "mainnet-beta" && cluster === c.id && "text-amber-700 dark:text-amber-300")}>
                  {c.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={refreshStatus} title={status ? `solana-core ${status.version} · refresh` : "Refresh"}
              className={cx("inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs tabular-nums hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]", muted)}>
              <span className="relative flex h-2 w-2" aria-hidden>
                {status && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-50 motion-reduce:animate-none" />}
                <span className={cx("relative inline-flex h-2 w-2 rounded-full", status ? "bg-green-500" : statusError ? "bg-red-500" : "bg-[hsl(var(--muted-foreground))]/40")} />
              </span>
              {status ? `slot ${status.slot.toLocaleString()}` : statusError ? "offline" : "connecting…"}
              <span className="sr-only">{status ? "connected" : statusError ? "offline" : "connecting"}</span>
            </button>
          </div>
        </div>
        {cluster === "custom" && (
          <form className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-3 lg:px-6" onSubmit={(e) => { e.preventDefault(); setPrefs((p) => ({ ...p, customUrl: customDraft.trim() })); }}>
            <label htmlFor="solana-rpc" className="shrink-0 text-xs font-medium">RPC URL</label>
            <TextInput id="solana-rpc" mono placeholder="https://your-rpc.example.com" value={customDraft} onChange={(e) => setCustomDraft(e.target.value)} className="max-w-md" />
            <Button type="submit">Connect</Button>
          </form>
        )}
      </header>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:px-6">
        {/* Sidebar */}
        <aside className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:self-start">
          <div>
            <label htmlFor="solana-agent" className={cx("mb-1.5 block text-[11px] font-semibold uppercase tracking-wider", muted)}>Acting as</label>
            <div className="relative rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2.5 transition-colors focus-within:ring-2 focus-within:ring-[hsl(var(--ring))] hover:border-[hsl(var(--primary))]/40">
              <div className="flex items-center gap-2.5">
                {agent ? <AgentAvatar name={agent.name} /> : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--muted))]"><Bot className={cx("h-4 w-4", muted)} aria-hidden /></div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{agent?.name ?? (agentsState.status === "loading" ? "Loading agents…" : agentsState.status === "error" ? "Agents unavailable" : agents?.length ? "Pick an agent" : "No agents")}</div>
                  <div className={cx("truncate text-xs", muted)}>
                    {agent ? `${agent.orgName} · ${Object.values(agent.capabilities).filter(Boolean).length} upgrades` : "Optional for debug tools"}
                  </div>
                </div>
                <ChevronsUpDown className={cx("h-4 w-4 shrink-0", muted)} aria-hidden />
              </div>
              <select id="solana-agent" className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                value={agentId ?? ""} disabled={!agents?.length}
                onChange={(e) => setPrefs((p) => ({ ...p, agentId: e.target.value || null }))}>
                <option value="">No agent</option>
                {[...new Set((agents ?? []).map((a) => a.orgName))].map((org) => (
                  <optgroup key={org} label={org}>
                    {agents!.filter((a) => a.orgName === org).map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            {agentsState.status === "error" && (
              <button type="button" onClick={refreshAgents} className="mt-1.5 inline-flex items-center gap-1 rounded-sm text-xs text-red-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] dark:text-red-400">
                <RefreshCw className="h-3 w-3" aria-hidden />Couldn&apos;t load agents — retry
              </button>
            )}
          </div>

          <nav aria-label="Solana tools" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
            <div className="flex gap-1 lg:block lg:space-y-4">
              {NAV.map((g) => (
                <div key={g.group} className="flex gap-1 lg:block lg:space-y-0.5">
                  <div className={cx("hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider lg:block", muted)}>{g.group}</div>
                  {g.items.map((item) => {
                    const active = tab === item.id;
                    const isLocked = locked(item);
                    return (
                      <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={active ? "page" : undefined}
                        title={isLocked ? `${agent!.name} doesn't have this upgrade yet` : undefined}
                        className={cx("flex h-9 w-full shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
                          active ? "bg-[hsl(var(--primary))]/10 font-medium text-[hsl(var(--primary))]" : cx(muted, "hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"))}>
                        <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="flex-1 text-left">{item.label}</span>
                        {isLocked && <Lock className="h-3 w-3 opacity-60" aria-label="Upgrade not enabled" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </nav>
        </aside>

        {/* Main */}
        <main className="min-w-0 space-y-4">
          {statusError && (
            <Notice tone="warning" title={`Can't reach ${cluster}`} action={<Button className="h-8" icon={RefreshCw} onClick={refreshStatus}>Retry</Button>}>{statusError}</Notice>
          )}
          {cluster === "mainnet-beta" && <Notice tone="warning">You&apos;re on mainnet. Reads and simulations only — agents never sign here.</Notice>}
          {!env ? (
            <Notice tone="info" title="Enter an RPC URL">Custom clusters need an http(s) RPC endpoint.</Notice>
          ) : (
            // Views stay mounted (hidden) so results survive navigation; keyed by
            // RPC + agent so switching either resets now-stale results.
            <div key={`${rpcUrl}:${agentId ?? ""}`}>
              <div hidden={tab !== "agent"}><AgentTab env={env} modId={modId} agents={agentsState} /></div>
              <div hidden={tab !== "tx"}><TxTool env={env} seed={seeds.tx} /></div>
              <div hidden={tab !== "account"}><AccountTool env={env} seed={seeds.account} /></div>
              <div hidden={tab !== "idl"}><IdlTool env={env} seed={seeds.idl} /></div>
              <div hidden={tab !== "pda"}><PdaTool env={env} /></div>
              <div hidden={tab !== "error"}><ErrorTool env={env} seed={seeds.error} /></div>
              <div hidden={tab !== "simulate"}><SimulateTab env={env} /></div>
              <div hidden={tab !== "anchor"}><AnchorTab env={env} seed={seeds.anchor} /></div>
              <div hidden={tab !== "network"}><NetworkTool env={env} status={status} address={agent?.devWallet ?? address} /></div>
              <div hidden={tab !== "settlement"}><SettlementTab api={api} /></div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { solana: SolanaPanel } });
