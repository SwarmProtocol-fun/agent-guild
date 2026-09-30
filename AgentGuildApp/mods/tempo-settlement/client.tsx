"use client";

import { useEffect, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  invoiceRef?: string;
  at: string;
}

function SettlementsPanel({ api }: PanelProps) {
  const [history, setHistory] = useState<SettlementRecord[] | null>(null);
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { hashVerified: boolean }>>({});

  useEffect(() => {
    api("history").then((r) => r.json()).then((d) => setHistory(d.history)).catch(() => setHistory([]));
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

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Tempo Settlement</h1>
      <p className="text-sm text-muted-foreground">
        Stablecoin micropayments + on-chain receipt hashes for completed GatewayAgent jobs, settled on Tempo (Moderato testnet).
        Settlements can carry an invoice reference for reconciliation.
      </p>

      <div className="flex gap-2 items-center text-sm">
        <input className="border rounded px-2 py-1 flex-1" placeholder="wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} />
        <button className="border rounded px-3 py-1" onClick={checkBalance}>Check balance</button>
        {balance != null && <span className="text-muted-foreground">${balance.toFixed(2)} USDC</span>}
      </div>

      <div className="space-y-2">
        {history == null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {history?.length === 0 && <p className="text-sm text-muted-foreground">No settlements yet.</p>}
        {history?.map((s) => (
          <div key={s.txSig} className="border rounded-lg p-3 text-sm flex justify-between items-center">
            <div>
              <div className="font-medium">{s.agentId}</div>
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
