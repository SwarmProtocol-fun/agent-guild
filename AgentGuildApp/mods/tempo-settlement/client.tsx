"use client";

import { useCallback, useEffect, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  invoiceRef?: string;
  void?: boolean;
  voidReason?: string;
  at: string;
}

interface Stats {
  settlementCount: number;
  voidCount: number;
  totalUsdc: number;
  avgUsdc: number;
  uniqueAgents: number;
  topAgents: { agentId: string; totalUsdc: number; count: number }[];
}

interface FeeEstimate {
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
}

function SettlementsPanel({ api }: PanelProps) {
  const [history, setHistory] = useState<SettlementRecord[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { hashVerified: boolean }>>({});
  const [voiding, setVoiding] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState("");
  const [includeVoid, setIncludeVoid] = useState(false);
  const [estimate, setEstimate] = useState<FeeEstimate | "loading" | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadHistory = useCallback(() => {
    const params = new URLSearchParams();
    if (agentFilter) params.set("agentId", agentFilter);
    if (includeVoid) params.set("includeVoid", "true");
    api(`history?${params.toString()}`).then((r) => r.json()).then((d) => setHistory(d.history)).catch(() => setHistory([]));
  }, [api, agentFilter, includeVoid]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    api("stats").then((r) => r.json()).then(setStats).catch(() => setStats(null));
  }, [api]);

  async function checkBalance() {
    if (!wallet) return;
    const r = await api(`balance/${wallet}`);
    const d = await r.json();
    setBalance(d.usdc ?? null);
  }

  async function verify(txSig: string) {
    setVerifying(txSig);
    const r = await api(`verify/${txSig}`);
    const d = await r.json();
    setVerifyResult((prev) => ({ ...prev, [txSig]: d }));
    setVerifying(null);
  }

  async function voidSettlement(txSig: string) {
    const reason = window.prompt("Reason for voiding this settlement?");
    if (reason == null) return;
    setVoiding(txSig);
    await api(`void/${txSig}`, { method: "POST", body: JSON.stringify({ reason }) });
    setVoiding(null);
    loadHistory();
    api("stats").then((r) => r.json()).then(setStats).catch(() => {});
  }

  async function loadEstimate() {
    setEstimate("loading");
    const r = await api("estimate");
    const d = await r.json();
    setEstimate(d);
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const r = await api("export");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tempo-settlements.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Tempo Settlement</h1>
      <p className="text-sm text-muted-foreground">
        Stablecoin micropayments + on-chain receipt hashes for completed GatewayAgent jobs, settled on Tempo (Moderato testnet).
        Settlements can carry an invoice reference for reconciliation, be batched, or metered and flushed to cut per-transaction overhead.
      </p>

      {stats && (
        <div className="border rounded-lg p-3 text-sm grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div><div className="text-muted-foreground">Settlements</div><div className="font-medium">{stats.settlementCount}</div></div>
          <div><div className="text-muted-foreground">Total USDC</div><div className="font-medium">${stats.totalUsdc.toFixed(2)}</div></div>
          <div><div className="text-muted-foreground">Avg USDC</div><div className="font-medium">${stats.avgUsdc.toFixed(2)}</div></div>
          <div><div className="text-muted-foreground">Agents</div><div className="font-medium">{stats.uniqueAgents}</div></div>
          <div><div className="text-muted-foreground">Voided</div><div className="font-medium">{stats.voidCount}</div></div>
          {stats.topAgents.length > 0 && (
            <div className="col-span-2 sm:col-span-5 text-muted-foreground">
              Top: {stats.topAgents.map((a) => `${a.agentId} ($${a.totalUsdc.toFixed(2)})`).join(", ")}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center text-sm">
        <input className="border rounded px-2 py-1 flex-1 min-w-[160px]" placeholder="wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} />
        <button className="border rounded px-3 py-1" onClick={checkBalance}>Check balance</button>
        {balance != null && <span className="text-muted-foreground">${balance.toFixed(2)} USDC</span>}
        <button className="border rounded px-3 py-1" onClick={loadEstimate}>Fee estimate</button>
        {estimate === "loading" && <span className="text-muted-foreground">loading…</span>}
        {estimate && estimate !== "loading" && (
          <span className="text-muted-foreground">gas price: {estimate.gasPrice ?? "n/a"}</span>
        )}
        <button className="border rounded px-3 py-1" onClick={exportCsv} disabled={exporting}>
          {exporting ? "exporting…" : "Export CSV"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-sm">
        <input className="border rounded px-2 py-1" placeholder="filter by agentId" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} />
        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
          show voided
        </label>
      </div>

      <div className="space-y-2">
        {history == null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {history?.length === 0 && <p className="text-sm text-muted-foreground">No settlements yet.</p>}
        {history?.map((s) => (
          <div key={s.txSig} className={`border rounded-lg p-3 text-sm flex justify-between items-center ${s.void ? "opacity-60" : ""}`}>
            <div>
              <div className="font-medium">
                {s.agentId} {s.void && <span className="text-red-600">(voided{s.voidReason ? `: ${s.voidReason}` : ""})</span>}
              </div>
              <div className="text-muted-foreground">
                task {s.taskId} · ${s.amountUsdc.toFixed(2)} USDC{s.invoiceRef ? ` · invoice ${s.invoiceRef}` : ""}
              </div>
              {verifyResult[s.txSig] && (
                <div className={verifyResult[s.txSig].hashVerified ? "text-green-600" : "text-red-600"}>
                  {verifyResult[s.txSig].hashVerified ? "✓ receipt hash verified on-chain" : "✗ hash mismatch"}
                </div>
              )}
            </div>
            <div className="flex gap-3 items-center">
              <button className="text-blue-500 hover:underline" onClick={() => verify(s.txSig)} disabled={verifying === s.txSig}>
                {verifying === s.txSig ? "checking…" : "verify"}
              </button>
              {!s.void && (
                <button className="text-red-500 hover:underline" onClick={() => voidSettlement(s.txSig)} disabled={voiding === s.txSig}>
                  {voiding === s.txSig ? "voiding…" : "void"}
                </button>
              )}
              <a href={s.explorerUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                view tx
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { settlements: SettlementsPanel } });
