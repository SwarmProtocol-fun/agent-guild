"use client";

import { useState } from "react";
import { defineClientMod, type PanelProps } from "@swarm/sdk";

interface Position {
  coin: string;
  size: number;
  notionalUsd: number;
  entryPrice: number;
  unrealizedPnl: number;
}

function TradingPanel({ api }: PanelProps) {
  const [orgId, setOrgId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [wallet, setWallet] = useState("");
  const [coin, setCoin] = useState("ETH");
  const [sizeUsd, setSizeUsd] = useState("10");
  const [isBuy, setIsBuy] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [accountValue, setAccountValue] = useState<number | null>(null);

  async function submitTrade() {
    setStatus("submitting…");
    const resp = await api("trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, coin, isBuy, sizeUsd: Number(sizeUsd) }),
    });
    const data = await resp.json();
    if (data.error) {
      setStatus(`error: ${data.error}`);
      return;
    }
    setTaskId(data.taskId);
    setStatus("queued");
  }

  async function checkStatus() {
    if (!taskId) return;
    const resp = await api(`status/${taskId}`);
    const data = await resp.json();
    setStatus(data.status ?? data.error);
  }

  async function refreshAccount() {
    if (!wallet) return;
    const [posResp, acctResp] = await Promise.all([api(`positions/${wallet}`), api(`account/${wallet}`)]);
    const posData = await posResp.json();
    const acctData = await acctResp.json();
    setPositions(posData.positions ?? []);
    setAccountValue(acctData.accountValue ?? null);
  }

  async function closePosition(positionCoin: string) {
    setStatus(`closing ${positionCoin}…`);
    const resp = await api("close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, wallet, coin: positionCoin }),
    });
    const data = await resp.json();
    if (data.error) {
      setStatus(`error: ${data.error}`);
      return;
    }
    setTaskId(data.taskId);
    setStatus(`closing ${positionCoin} — task ${data.taskId}`);
  }

  return (
    <div className="p-6 space-y-6 max-w-lg">
      <div>
        <h1 className="text-xl font-semibold">Hyperliquid Trading</h1>
        <p className="text-sm text-muted-foreground">
          Places orders via a GatewayAgent job running the official Hyperliquid SDK. Requires a worker registered with the <code>hyperliquid</code> tag.
        </p>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex gap-2">
          <input className="border rounded px-2 py-1 w-1/2" placeholder="orgId" value={orgId} onChange={(e) => setOrgId(e.target.value)} />
          <input className="border rounded px-2 py-1 w-1/2" placeholder="agentId" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </div>
        <input className="border rounded px-2 py-1 w-full" placeholder="wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} />
        <button className="border rounded px-3 py-1" onClick={refreshAccount} disabled={!wallet}>Refresh account</button>
        {accountValue != null && <p className="text-muted-foreground">Account equity: ${accountValue.toFixed(2)}</p>}
      </div>

      {positions != null && positions.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-sm">Open positions</h2>
          {positions.map((p) => (
            <div key={p.coin} className="border rounded-lg p-3 text-sm flex justify-between items-center">
              <div>
                <div className="font-medium">{p.coin} {p.size > 0 ? "long" : "short"}</div>
                <div className="text-muted-foreground">
                  ${Math.abs(p.notionalUsd).toFixed(2)} notional · entry ${p.entryPrice.toFixed(2)} ·{" "}
                  <span className={p.unrealizedPnl >= 0 ? "text-green-600" : "text-red-600"}>
                    {p.unrealizedPnl >= 0 ? "+" : ""}{p.unrealizedPnl.toFixed(2)} PnL
                  </span>
                </div>
              </div>
              <button className="border rounded px-3 py-1" onClick={() => closePosition(p.coin)}>Close</button>
            </div>
          ))}
        </div>
      )}
      {positions != null && positions.length === 0 && <p className="text-sm text-muted-foreground">No open positions.</p>}

      <div className="space-y-2 text-sm border-t pt-4">
        <h2 className="font-medium">Place a trade</h2>
        <input className="border rounded px-2 py-1 w-full" placeholder="coin (e.g. ETH)" value={coin} onChange={(e) => setCoin(e.target.value)} />
        <input className="border rounded px-2 py-1 w-full" placeholder="size (USD)" value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isBuy} onChange={(e) => setIsBuy(e.target.checked)} /> Buy (unchecked = sell)
        </label>
        <div className="flex gap-2">
          <button className="border rounded px-3 py-1" onClick={submitTrade}>Place trade</button>
          <button className="border rounded px-3 py-1" onClick={checkStatus} disabled={!taskId}>Check status</button>
        </div>
        {taskId && <p className="text-muted-foreground">task: {taskId}</p>}
        {status && <p className="text-muted-foreground">status: {status}</p>}
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { trading: TradingPanel } });
