"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Connection } from "@solana/web3.js";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { PUBLIC_RPC, clusterStatus, detectInput, explorerUrl, type Cluster, type ClusterStatus } from "./devtools";
import { AccountTool, ErrorTool, IdlTool, NetworkTool, PdaTool, TxTool } from "./inspect-tools";
import { AgentTab } from "./agent-tab";
import { SimulateTab } from "./simulate-tab";
import { AnchorTab } from "./anchor-tab";
import { SettlementTab } from "./settlement-tab";
import { ErrorNote, buttonClass, inputClass, muted, type Env, type Seed, type SelectedAgent, type Tab } from "./ui";

// The Solana panel. The agent picker decides who the Agent / Simulate /
// Anchor tabs act as; the read & debug tools work with or without one.

const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "tx", label: "Transaction" },
  { id: "account", label: "Account" },
  { id: "idl", label: "Program IDL" },
  { id: "pda", label: "PDA" },
  { id: "error", label: "Errors" },
  { id: "simulate", label: "Simulate" },
  { id: "anchor", label: "Anchor" },
  { id: "network", label: "Network" },
  { id: "settlement", label: "Settlement" },
];

const CLUSTERS: Cluster[] = ["devnet", "testnet", "mainnet-beta", "localnet", "custom"];
const STORAGE_KEY = "solana-mod:prefs";

interface Prefs { cluster: Cluster; customUrl: string; agentId: string | null }

function loadPrefs(): Prefs {
  const fallback: Prefs = { cluster: "devnet", customUrl: "", agentId: null };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && CLUSTERS.includes(saved.cluster)) return { ...fallback, ...saved };
  } catch { /* storage unavailable */ }
  return fallback;
}

function SolanaPanel({ modId, address, api }: PanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { cluster, customUrl, agentId } = prefs;
  const [customDraft, setCustomDraft] = useState(customUrl);
  const [agents, setAgents] = useState<SelectedAgent[] | "loading" | "error">("loading");
  const [tab, setTab] = useState<Tab>("agent");
  const [seeds, setSeeds] = useState<Partial<Record<Tab, Seed>>>({});
  const [search, setSearch] = useState("");
  const [searchMiss, setSearchMiss] = useState(false);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  const refreshAgents = useCallback(() => {
    api("my-agents")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        const list: SelectedAgent[] = d.agents ?? [];
        setAgents(list);
        // Pre-select the only agent, or drop a remembered one that's gone.
        setPrefs((p) => ({ ...p, agentId: list.some((a) => a.agentId === p.agentId) ? p.agentId : list.length === 1 ? list[0].agentId : null }));
      })
      .catch(() => setAgents("error"));
  }, [api]);
  useEffect(refreshAgents, [refreshAgents]);

  const agent = Array.isArray(agents) ? agents.find((a) => a.agentId === agentId) ?? null : null;

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
      setStatusError(cluster === "localnet" ? "No validator at 127.0.0.1:8899 — run solana-test-validator." : (err as Error).message);
    });
  }, [conn, cluster]);
  useEffect(() => { setStatus(null); refreshStatus(); }, [refreshStatus]);

  const go = useCallback((target: Tab, value: string) => {
    setSeeds((s) => ({ ...s, [target]: { value, nonce: (s[target]?.nonce ?? 0) + 1 } }));
    setTab(target);
  }, []);

  const env: Env | null = useMemo(() => conn && {
    conn, cluster, customUrl, agent, agentApi, refreshAgents, go,
    explorer: (kind: "tx" | "address", id: string) => explorerUrl(kind, id, cluster, customUrl),
  }, [conn, cluster, customUrl, agent, agentApi, refreshAgents, go]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const kind = detectInput(search);
    setSearchMiss(!kind);
    if (kind) go(kind === "address" ? "account" : kind, search.trim());
  }

  return (
    <div className="max-w-4xl mx-auto space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${status ? "bg-green-500" : statusError ? "bg-red-500" : "bg-[hsl(var(--muted-foreground))]/40"}`} aria-hidden="true" />
          <h1 className="text-sm font-semibold uppercase tracking-wide">Solana</h1>
          {status && <span className={`text-xs ${muted} font-mono`}>v{status.version} · slot {status.slot.toLocaleString()}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={inputClass} aria-label="agent" value={agentId ?? ""}
            onChange={(e) => setPrefs((p) => ({ ...p, agentId: e.target.value || null }))}>
            <option value="">{agents === "loading" ? "Loading agents…" : agents === "error" ? "Couldn't load agents" : "No agent"}</option>
            {Array.isArray(agents) && agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>{a.name} · {a.orgName}</option>
            ))}
          </select>
          <select className={inputClass} value={cluster} aria-label="cluster" onChange={(e) => setPrefs((p) => ({ ...p, cluster: e.target.value as Cluster }))}>
            {CLUSTERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {cluster === "custom" && (
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); setPrefs((p) => ({ ...p, customUrl: customDraft.trim() })); }}>
              <input className={`${inputClass} w-56 font-mono text-xs`} placeholder="https://your-rpc…" value={customDraft} onChange={(e) => setCustomDraft(e.target.value)} spellCheck={false} />
              <button type="submit" className={buttonClass()}>Use</button>
            </form>
          )}
          <button type="button" className={buttonClass()} onClick={refreshStatus} aria-label="refresh cluster status">↻</button>
        </div>
      </div>
      {statusError && <ErrorNote message={statusError} />}

      <form className="flex gap-2" onSubmit={onSearch}>
        <input className={`${inputClass} flex-1 font-mono text-xs`} placeholder="Paste a signature, address, or error code…" value={search}
          onChange={(e) => { setSearch(e.target.value); setSearchMiss(false); }} spellCheck={false} />
        <button type="submit" className={buttonClass(true)} disabled={!env || !search.trim()}>Go</button>
      </form>
      {searchMiss && <p className={`text-xs ${muted}`}>Couldn&apos;t tell what that is — pick a tool below.</p>}

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[hsl(var(--border))]">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium uppercase tracking-wide border-b-2 -mb-px ${tab === t.id ? "border-[hsl(var(--primary))] text-[hsl(var(--foreground))]" : `border-transparent ${muted} hover:text-[hsl(var(--foreground))]`}`}>
            {t.label}
          </button>
        ))}
      </div>

      {!env ? (
        <ErrorNote message="Enter an http(s) RPC URL to use a custom cluster." />
      ) : (
        // Tools stay mounted (hidden) so results survive tab switches; keyed by
        // RPC + agent so switching either resets now-stale results.
        <div key={`${rpcUrl}:${agentId ?? ""}`}>
          <div hidden={tab !== "agent"}><AgentTab env={env} modId={modId} /></div>
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
    </div>
  );
}

export default defineClientMod({ panels: { solana: SolanaPanel } });
