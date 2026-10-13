"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from "react";
import { Binary, Bot, BookOpen, CandlestickChart, ChevronsUpDown, Fuel, FlaskConical, Lock, Receipt, RefreshCw, Search, Wallet, type LucideProps } from "lucide-react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { NETWORKS, NETWORK_IDS, detectInput, explorerUrl, type DetectedInput, type EthNetwork } from "./networks";
import { AgentAvatar, AgentTab, type AgentsState } from "./agent-tab";
import { TradeTab } from "./trade-tab";
import { AddressTool, DecodeTool, GasTool, ReadTool, TxTool } from "./inspect-tools";
import { SimulateTab } from "./simulate-tab";
import { Button, Notice, TextInput, cx, json, muted, type Env, type Seed, type SelectedAgent, type Tab } from "./ui";

// The Ethereum panel shell. The sidebar's agent switcher decides who the
// Overview / Trade / Simulate views act as; the debug tools and quotes
// work without one. Every chain read goes through this mod's server routes,
// so keyed RPC URLs never reach the browser.

interface NavItem { id: Tab; label: string; icon: ComponentType<LucideProps>; capability?: string }

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Agent",
    items: [
      { id: "agent", label: "Overview", icon: Bot },
      { id: "trade", label: "Trade", icon: CandlestickChart, capability: "eth-trade" },
    ],
  },
  {
    group: "Debug",
    items: [
      { id: "tx", label: "Transaction", icon: Receipt, capability: "eth-inspect" },
      { id: "address", label: "Address", icon: Wallet, capability: "eth-inspect" },
      { id: "read", label: "Read contract", icon: BookOpen, capability: "eth-inspect" },
      { id: "decode", label: "Decode", icon: Binary, capability: "eth-inspect" },
    ],
  },
  { group: "Build", items: [{ id: "simulate", label: "Simulate & send", icon: FlaskConical, capability: "eth-simulate" }] },
  { group: "Chain", items: [{ id: "gas", label: "Gas & network", icon: Fuel }] },
];

const STORAGE_KEY = "ethereum-mod:prefs";
interface Prefs { network: EthNetwork; agentId: string | null }

function loadPrefs(): Prefs {
  const fallback: Prefs = { network: "mainnet", agentId: null };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && NETWORK_IDS.includes(saved.network)) return { ...fallback, ...saved };
  } catch { /* storage unavailable */ }
  return fallback;
}

const OPTION_COLORS = "bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))]";
const DETECTED_LABEL: Record<DetectedInput, string> = { tx: "Transaction", address: "Address", ens: "ENS name", data: "Calldata" };
const DETECTED_TAB: Record<DetectedInput, Tab> = { tx: "tx", address: "address", ens: "address", data: "decode" };

interface Status { blockNumber: string; gasPriceGwei: string; baseFeeGwei: string | null }

function EthereumPanel({ address, api }: PanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { network, agentId } = prefs;
  const [agents, setAgents] = useState<SelectedAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("agent");
  const [seeds, setSeeds] = useState<Partial<Record<Tab, Seed>>>({});
  const [search, setSearch] = useState("");
  const [searchMiss, setSearchMiss] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  const refreshAgents = useCallback(() => {
    setAgentsError(null);
    json<{ agents: SelectedAgent[] }>(api("my-agents"))
      .then(({ agents: list }) => {
        setAgents(list);
        setPrefs((p) => ({ ...p, agentId: list.some((a) => a.agentId === p.agentId) ? p.agentId : list.length === 1 ? list[0].agentId : null }));
      })
      .catch((err: Error) => { setAgents(null); setAgentsError(err.message); });
  }, [api]);
  useEffect(refreshAgents, [refreshAgents]);

  const agent = agents?.find((a) => a.agentId === agentId) ?? null;
  const agentsState: AgentsState = { status: agentsError ? "error" : agents === null ? "loading" : "ready", count: agents?.length ?? 0, error: agentsError, retry: refreshAgents };

  // Calls this mod's API as the selected agent: agentId in the query string and, for JSON bodies, in the body.
  const agentApi = useCallback((path: string, init?: RequestInit) => {
    if (!agentId) return Promise.resolve(Response.json({ error: "Pick an agent first" }, { status: 400 }));
    const sep = path.includes("?") ? "&" : "?";
    let reqBody = init?.body;
    if (typeof reqBody === "string") {
      try { reqBody = JSON.stringify({ ...JSON.parse(reqBody), agentId }); } catch { /* leave non-JSON bodies alone */ }
    }
    return api(`${path}${sep}agentId=${encodeURIComponent(agentId)}`, { ...init, body: reqBody });
  }, [api, agentId]);

  const refreshStatus = useCallback(() => {
    setStatusError(null);
    json<{ status: Status }>(api(`dev/status?network=${network}`)).then((d) => setStatus(d.status)).catch((err: Error) => { setStatus(null); setStatusError(err.message); });
  }, [api, network]);
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

  const env: Env = useMemo(() => ({
    network, agent, agentApi, api, refreshAgents, go,
    explorer: (kind: "tx" | "address", id: string) => explorerUrl(kind, id, network),
  }), [network, agent, agentApi, api, refreshAgents, go]);

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
      go(DETECTED_TAB[detected], search.trim());
      setSearch("");
    }
  }

  const locked = (item: NavItem) => !!agent && !!item.capability && !agent.capabilities[item.capability];
  const info = NETWORKS[network];

  return (
    <div className="min-h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <header className="border-b border-[hsl(var(--border))]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-[#627EEA] to-[#8A92B2] text-lg font-semibold text-white" aria-hidden>◆</div>
            <div>
              <h1 className="text-base font-semibold leading-tight">Ethereum</h1>
              <p className={cx("text-xs", muted)}>Developer upgrades for your agents</p>
            </div>
          </div>

          <form className="order-3 w-full md:order-none md:max-w-md md:flex-1" onSubmit={onSearch} role="search">
            <label htmlFor="eth-search" className="sr-only">Search a transaction, address, ENS name or calldata</label>
            <div className="relative">
              <Search className={cx("pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2", muted)} aria-hidden />
              <TextInput id="eth-search" ref={searchRef} mono placeholder="Tx hash, address, name.eth or calldata" className="pl-9 pr-28" value={search}
                onChange={(e) => { setSearch(e.target.value); setSearchMiss(false); }} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2">
                {search.trim()
                  ? <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", detected ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]" : cx("bg-[hsl(var(--muted))]", muted))}>{detected ? `${DETECTED_LABEL[detected]} ↵` : "Unknown"}</span>
                  : <kbd className={cx("rounded border border-[hsl(var(--border))] px-1.5 font-mono text-[11px]", muted)}>/</kbd>}
              </span>
            </div>
            {searchMiss && <p className={cx("mt-1 text-xs", muted)}>That isn&apos;t a transaction hash, address, ENS name or calldata.</p>}
          </form>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Network" className="inline-flex rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-0.5">
              {NETWORK_IDS.map((id) => (
                <button key={id} type="button" role="radio" aria-checked={network === id} onClick={() => setPrefs((p) => ({ ...p, network: id }))}
                  className={cx("h-8 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
                    network === id ? "bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm" : cx(muted, "hover:text-[hsl(var(--foreground))]"))}>
                  {NETWORKS[id].label}
                </button>
              ))}
            </div>
            <button type="button" onClick={refreshStatus} title={status ? `gas ${Number(status.gasPriceGwei).toFixed(3)} gwei · refresh` : "Refresh"}
              className={cx("inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs tabular-nums hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]", muted)}>
              <span className="relative flex h-2 w-2" aria-hidden>
                {status && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-50 motion-reduce:animate-none" />}
                <span className={cx("relative inline-flex h-2 w-2 rounded-full", status ? "bg-green-500" : statusError ? "bg-red-500" : "bg-[hsl(var(--muted-foreground))]/40")} />
              </span>
              {status ? `block ${Number(status.blockNumber).toLocaleString()}` : statusError ? "offline" : "connecting…"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:px-6">
        <aside className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:self-start">
          <div>
            <label htmlFor="eth-agent" className={cx("mb-1.5 block text-[11px] font-semibold uppercase tracking-wider", muted)}>Acting as</label>
            <div className="relative rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2.5 transition-colors focus-within:ring-2 focus-within:ring-[hsl(var(--ring))] hover:border-[hsl(var(--primary))]/40">
              <div className="flex items-center gap-2.5">
                {agent ? <AgentAvatar name={agent.name} /> : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--muted))]"><Bot className={cx("h-4 w-4", muted)} aria-hidden /></div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{agent?.name ?? (agentsState.status === "loading" ? "Loading agents…" : agentsState.status === "error" ? "Agents unavailable" : agents?.length ? "Pick an agent" : "No agents")}</div>
                  <div className={cx("truncate text-xs", muted)}>{agent ? `${agent.orgName} · ${Object.values(agent.capabilities).filter(Boolean).length} upgrades` : "Optional for debug tools"}</div>
                </div>
                <ChevronsUpDown className={cx("h-4 w-4 shrink-0", muted)} aria-hidden />
              </div>
              {/* Invisible native select over the card; needs explicit popover colors or the open list is white-on-white in dark mode. */}
              <select id="eth-agent" className={cx("absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed", OPTION_COLORS)}
                value={agentId ?? ""} disabled={!agents?.length} onChange={(e) => setPrefs((p) => ({ ...p, agentId: e.target.value || null }))}>
                <option value="" className={OPTION_COLORS}>No agent</option>
                {[...new Set((agents ?? []).map((a) => a.orgName))].map((org) => (
                  <optgroup key={org} label={org} className={OPTION_COLORS}>
                    {agents!.filter((a) => a.orgName === org).map((a) => <option key={a.agentId} value={a.agentId} className={OPTION_COLORS}>{a.name}</option>)}
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

          <nav aria-label="Ethereum tools" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
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

        <main className="min-w-0 space-y-4">
          {statusError && <Notice tone="warning" title={`Can't reach ${info.label}`} action={<Button className="h-8" icon={RefreshCw} onClick={refreshStatus}>Retry</Button>}>{statusError}</Notice>}
          {!info.testnet && (tab === "simulate") && <Notice tone="warning">You&apos;re on {info.label} mainnet. Simulations only — agents sign on Sepolia and Base Sepolia.</Notice>}
          {/* Views stay mounted (hidden) so results survive navigation; keyed by network + agent so switching resets stale results. */}
          <div key={`${network}:${agentId ?? ""}`}>
            <div hidden={tab !== "agent"}><AgentTab env={env} agents={agentsState} /></div>
            <div hidden={tab !== "trade"}><TradeTab env={env} /></div>
            <div hidden={tab !== "tx"}><TxTool env={env} seed={seeds.tx} /></div>
            <div hidden={tab !== "address"}><AddressTool env={env} seed={seeds.address} fallback={agent?.devWallet ?? address} /></div>
            <div hidden={tab !== "read"}><ReadTool env={env} seed={seeds.read} /></div>
            <div hidden={tab !== "decode"}><DecodeTool env={env} seed={seeds.decode} /></div>
            <div hidden={tab !== "simulate"}><SimulateTab env={env} /></div>
            <div hidden={tab !== "gas"}><GasTool env={env} status={status} /></div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { ethereum: EthereumPanel } });
