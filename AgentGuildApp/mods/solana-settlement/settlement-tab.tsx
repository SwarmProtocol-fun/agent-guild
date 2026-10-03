"use client";

import { useEffect, useState } from "react";

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  reputationUpdated: boolean;
  at: string;
}

interface SlashingEntry {
  proposalId: string;
  asn: string;
  agent: string;
  amount: number;
  reason: string;
  proposer: string;
  resolvedAt: number;
  proposalAddress: string;
}

interface ScoreEvent {
  signature: string;
  blockTime: number | null;
  payload: unknown;
}

/** USDC job settlement on Solana — the mod's original feature, now one tab of the Solana panel. */
export function SettlementTab({ api }: { api: (path: string, init?: RequestInit) => Promise<Response> }) {
  const [history, setHistory] = useState<SettlementRecord[] | null>(null);
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, { hashVerified: boolean }>>({});

  const [asn, setAsn] = useState("");
  const [slashing, setSlashing] = useState<SlashingEntry[] | null>(null);
  const [events, setEvents] = useState<ScoreEvent[] | null>(null);
  const [asnLoading, setAsnLoading] = useState<"slashing" | "events" | null>(null);

  const [mintWallet, setMintWallet] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintResult, setMintResult] = useState<string | null>(null);

  useEffect(() => {
    api("history").then((r) => r.json()).then((d) => setHistory(d.history)).catch(() => setHistory([]));
  }, [api]);

  async function checkBalance() {
    if (!wallet) return;
    const r = await api(`balance/${wallet}`);
    const d = await r.json();
    setBalance(d.usdc ?? null);
  }

  async function checkRegistered() {
    if (!wallet) return;
    const r = await api(`registered/${wallet}`);
    const d = await r.json();
    setRegistered(d.registered ?? null);
  }

  async function verify(txSig: string) {
    setVerifying(txSig);
    const r = await api(`verify/${txSig}`);
    const d = await r.json();
    setVerifyResult((prev) => ({ ...prev, [txSig]: d }));
    setVerifying(null);
  }

  async function loadSlashing() {
    if (!asn) return;
    setAsnLoading("slashing");
    const r = await api(`slashing/${asn}`);
    const d = await r.json();
    setSlashing(d.history ?? []);
    setAsnLoading(null);
  }

  async function loadEvents() {
    if (!asn) return;
    setAsnLoading("events");
    const r = await api(`events/${asn}`);
    const d = await r.json();
    setEvents(d.events ?? []);
    setAsnLoading(null);
  }

  async function mintIdentity() {
    if (!mintWallet) return;
    setMinting(true);
    setMintResult(null);
    const r = await api("identity/mint", { method: "POST", body: JSON.stringify({ agentAddress: mintWallet }) });
    const d = await r.json();
    setMintResult(r.ok ? `✓ minted ${d.mint}` : `✗ ${d.error}`);
    setMinting(false);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        USDC payments + on-chain receipt hashes for completed GatewayAgent jobs, settled on Solana devnet.
      </p>

      <div className="flex gap-2 items-center text-sm">
        <input className="border rounded px-2 py-1 flex-1" placeholder="wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} />
        <button className="border rounded px-3 py-1" onClick={checkBalance}>Check balance</button>
        {balance != null && <span className="text-muted-foreground">${balance.toFixed(2)} USDC</span>}
        <button className="border rounded px-3 py-1" onClick={checkRegistered}>Check registration</button>
        {registered != null && (
          <span className={registered ? "text-green-600" : "text-red-600"}>{registered ? "✓ registered" : "✗ not registered"}</span>
        )}
      </div>

      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">ASN on-chain lookup</div>
        <div className="flex gap-2 items-center">
          <input className="border rounded px-2 py-1 flex-1" placeholder="ASN" value={asn} onChange={(e) => setAsn(e.target.value)} />
          <button className="border rounded px-3 py-1" onClick={loadSlashing} disabled={asnLoading === "slashing"}>
            {asnLoading === "slashing" ? "loading…" : "Slashing history"}
          </button>
          <button className="border rounded px-3 py-1" onClick={loadEvents} disabled={asnLoading === "events"}>
            {asnLoading === "events" ? "loading…" : "Score events"}
          </button>
        </div>
        {slashing != null && (
          <div className="space-y-1">
            {slashing.length === 0 && <p className="text-muted-foreground">No approved penalty proposals for this ASN.</p>}
            {slashing.map((p) => (
              <div key={p.proposalAddress} className="text-red-600">
                −{p.amount} credit · {p.reason} · {new Date(p.resolvedAt * 1000).toLocaleString()}
              </div>
            ))}
          </div>
        )}
        {events != null && (
          <div className="space-y-1">
            {events.length === 0 && <p className="text-muted-foreground">No score events for this ASN.</p>}
            {events.map((e) => (
              <div key={e.signature} className="text-muted-foreground">
                {e.blockTime ? new Date(e.blockTime * 1000).toLocaleString() : "pending"} · {JSON.stringify(e.payload)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Mint soulbound identity token (platform admin)</div>
        <div className="flex gap-2 items-center">
          <input className="border rounded px-2 py-1 flex-1" placeholder="agent wallet address" value={mintWallet} onChange={(e) => setMintWallet(e.target.value)} />
          <button className="border rounded px-3 py-1" onClick={mintIdentity} disabled={minting}>
            {minting ? "minting…" : "Mint"}
          </button>
        </div>
        {mintResult && <div className={mintResult.startsWith("✓") ? "text-green-600" : "text-red-600"}>{mintResult}</div>}
      </div>

      <div className="space-y-2">
        {history == null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {history?.length === 0 && <p className="text-sm text-muted-foreground">No settlements yet.</p>}
        {history?.map((s) => (
          <div key={s.txSig} className="border rounded-lg p-3 text-sm flex justify-between items-center">
            <div>
              <div className="font-medium">{s.agentId}</div>
              <div className="text-muted-foreground">task {s.taskId} · ${s.amountUsdc.toFixed(2)} USDC</div>
              <div className={s.reputationUpdated ? "text-green-600" : "text-muted-foreground"}>
                {s.reputationUpdated ? "✓ credit/trust score updated on-chain" : "reputation not updated (agent not registered on-chain?)"}
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

