"use client";

import { useEffect, useState, type FormEvent } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";

type Network = "testnet" | "mainnet";

interface Position {
  coin: string;
  size: number;
  notionalUsd: number;
  entryPrice: number;
  unrealizedPnl: number;
}

interface TradeRecord {
  id: string;
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  fillPrice?: number;
  realizedPnl?: number;
  status: "opened" | "closed";
}

interface Strategy {
  id: string;
  type: "dca" | "grid" | "signal";
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  pendingSignal: boolean;
}

interface RiskConfig {
  leverage: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
}

type Tab = "trade" | "positions" | "strategies" | "history" | "risk";

const TABS: { id: Tab; label: string }[] = [
  { id: "trade", label: "Trade" },
  { id: "positions", label: "Positions" },
  { id: "strategies", label: "Strategies" },
  { id: "history", label: "History" },
  { id: "risk", label: "Risk limits" },
];

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const labelClass = "block text-sm font-medium text-foreground mb-1";

function primaryButtonClass(extra = "") {
  return (
    "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground " +
    "transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
    extra
  );
}

function secondaryButtonClass(extra = "") {
  return (
    "inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium " +
    "transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
    extra
  );
}

function Badge({ tone, children }: { tone: "neutral" | "success" | "danger" | "warning"; children: React.ReactNode }) {
  const toneClass = {
    neutral: "bg-muted text-muted-foreground",
    success: "bg-green-600/10 text-green-700 dark:text-green-400",
    danger: "bg-destructive/10 text-destructive",
    warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}`}>{children}</span>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="font-medium text-sm text-card-foreground">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4" role="status">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground motion-reduce:animate-none"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className={secondaryButtonClass("shrink-0")} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function TradingPanel({ api }: PanelProps) {
  const [orgId, setOrgId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [wallet, setWallet] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("trade");

  // Shared, in-memory only — never written to localStorage, never sent anywhere
  // but this mod's own API, and re-entered whenever the panel reloads. This is
  // the agent's own passphrase decrypting its own stored Hyperliquid key; the
  // platform never retains it (see server.ts's resolveAgentWallet).
  const [masterSecret, setMasterSecret] = useState("");

  // ── Wallet setup ───────────────────────────────────────────────────────────
  const [walletStatus, setWalletStatus] = useState<{ hasWallet: boolean; network: Network | null } | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletKeyInput, setWalletKeyInput] = useState("");
  const [walletNetwork, setWalletNetwork] = useState<Network>("testnet");
  const [walletFormOpen, setWalletFormOpen] = useState(false);
  const [walletActionStatus, setWalletActionStatus] = useState<string | null>(null);

  async function loadWalletStatus() {
    if (!agentId) return;
    setWalletLoading(true);
    try {
      const resp = await api(`wallet/${agentId}`);
      const data = await resp.json();
      setWalletStatus({ hasWallet: !!data.hasWallet, network: data.network ?? null });
    } finally {
      setWalletLoading(false);
    }
  }

  async function saveWallet(e: FormEvent) {
    e.preventDefault();
    if (!agentId || !orgId) return;
    setWalletActionStatus("saving…");
    const resp = await api("wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, privateKey: walletKeyInput, masterSecret, network: walletNetwork }),
    });
    const data = await resp.json();
    if (data.error) {
      setWalletActionStatus(`error: ${data.error}`);
      return;
    }
    setWalletActionStatus("saved");
    setWalletKeyInput("");
    setWalletFormOpen(false);
    loadWalletStatus();
  }

  async function removeWallet() {
    if (!agentId) return;
    if (!confirm("Remove this agent's Hyperliquid wallet? It will need a new key before it can trade again.")) return;
    setWalletActionStatus("removing…");
    await api(`wallet/${agentId}`, { method: "DELETE" });
    setWalletActionStatus(null);
    loadWalletStatus();
  }

  useEffect(() => {
    if (agentId) loadWalletStatus();
  }, [agentId]);

  const network: Network = walletStatus?.network ?? "testnet";

  // ── Trade form ───────────────────────────────────────────────────────────
  const [coin, setCoin] = useState("ETH");
  const [sizeUsd, setSizeUsd] = useState("10");
  const [isBuy, setIsBuy] = useState(true);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverage] = useState("");
  const [stopLossPct, setStopLossPct] = useState("");
  const [takeProfitPct, setTakeProfitPct] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tradeStatus, setTradeStatus] = useState<string | null>(null);
  const [tradeSubmitting, setTradeSubmitting] = useState(false);
  const [livePrice, setLivePrice] = useState<number | null>(null);

  useEffect(() => {
    if (!coin) return;
    let cancelled = false;
    async function poll() {
      try {
        const resp = await api(`price/${coin}?network=${network}`);
        const data = await resp.json();
        if (!cancelled) setLivePrice(data.price ?? null);
      } catch {
        if (!cancelled) setLivePrice(null);
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, network, api]);

  async function submitTrade(e: FormEvent) {
    e.preventDefault();
    setTradeSubmitting(true);
    setTradeStatus("submitting…");
    try {
      const resp = await api("trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId, agentId, coin, isBuy, sizeUsd: Number(sizeUsd), orderType, masterSecret,
          limitPrice: orderType === "limit" ? Number(limitPrice) : undefined,
          leverage: leverage ? Number(leverage) : undefined,
          stopLossPct: stopLossPct ? Number(stopLossPct) : undefined,
          takeProfitPct: takeProfitPct ? Number(takeProfitPct) : undefined,
        }),
      });
      const data = await resp.json();
      if (data.error) {
        setTradeStatus(`error: ${data.error}`);
        return;
      }
      setTaskId(data.taskId);
      setTradeStatus("queued");
    } finally {
      setTradeSubmitting(false);
    }
  }

  async function checkStatus() {
    if (!taskId) return;
    const resp = await api(`status/${taskId}`);
    const data = await resp.json();
    setTradeStatus(data.status ?? data.error);
  }

  // ── Positions / account ────────────────────────────────────────────────────
  const [positions, setPositions] = useState<Position[] | "loading" | "error" | null>(null);
  const [accountValue, setAccountValue] = useState<number | null>(null);
  const [closingCoin, setClosingCoin] = useState<string | null>(null);

  async function refreshAccount() {
    if (!wallet) return;
    setPositions("loading");
    try {
      const [posResp, acctResp] = await Promise.all([
        api(`positions/${wallet}?network=${network}`),
        api(`account/${wallet}?network=${network}`),
      ]);
      const posData = await posResp.json();
      const acctData = await acctResp.json();
      if (posData.error) {
        setPositions("error");
        return;
      }
      setPositions(posData.positions ?? []);
      setAccountValue(acctData.accountValue ?? null);
    } catch {
      setPositions("error");
    }
  }

  async function closePosition(positionCoin: string) {
    setClosingCoin(positionCoin);
    const resp = await api("close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, wallet, coin: positionCoin, masterSecret }),
    });
    const data = await resp.json();
    setClosingCoin(null);
    if (data.error) {
      setTradeStatus(`error closing ${positionCoin}: ${data.error}`);
      return;
    }
    setTaskId(data.taskId);
    setTradeStatus(`closing ${positionCoin} — task ${data.taskId}`);
    refreshAccount();
  }

  // ── Risk config ────────────────────────────────────────────────────────────
  const [riskMaxPosition, setRiskMaxPosition] = useState("100");
  const [riskMaxDailyLoss, setRiskMaxDailyLoss] = useState("20");
  const [riskLeverage, setRiskLeverage] = useState("1");
  const [riskConfig, setRiskConfigState] = useState<RiskConfig | null>(null);
  const [riskStatus, setRiskStatus] = useState<string | null>(null);

  async function loadRiskConfig() {
    if (!agentId) return;
    const resp = await api(`risk-config/${agentId}`);
    const data = await resp.json();
    setRiskConfigState(data.config ?? null);
    if (data.config) {
      setRiskMaxPosition(String(data.config.maxPositionUsd));
      setRiskMaxDailyLoss(String(data.config.maxDailyLossUsd));
      setRiskLeverage(String(data.config.leverage));
    }
  }

  async function saveRiskConfig(e: FormEvent) {
    e.preventDefault();
    setRiskStatus("saving…");
    const resp = await api("risk-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId, agentId,
        leverage: Number(riskLeverage),
        maxPositionUsd: Number(riskMaxPosition),
        maxDailyLossUsd: Number(riskMaxDailyLoss),
      }),
    });
    const data = await resp.json();
    setRiskStatus(data.error ? `error: ${data.error}` : "saved");
    if (!data.error) loadRiskConfig();
  }

  // ── History ─────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<{ trades: TradeRecord[]; stats: { totalPnl: number; winRate: number; count: number } } | "loading" | "error" | null>(null);

  async function loadHistory() {
    if (!agentId) return;
    setHistory("loading");
    try {
      const resp = await api(`history/${agentId}`);
      const data = await resp.json();
      if (data.error) {
        setHistory("error");
        return;
      }
      setHistory(data);
    } catch {
      setHistory("error");
    }
  }

  // ── Strategies ─────────────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState<Strategy[] | "loading" | "error" | null>(null);
  const [strategyType, setStrategyType] = useState<"dca" | "grid" | "signal">("dca");
  const [strategyCoin, setStrategyCoin] = useState("ETH");
  const [strategySizeUsd, setStrategySizeUsd] = useState("10");
  const [dcaIntervalMin, setDcaIntervalMin] = useState("60");
  const [gridLower, setGridLower] = useState("");
  const [gridUpper, setGridUpper] = useState("");
  const [gridLevels, setGridLevels] = useState("5");
  const [strategyStatus, setStrategyStatus] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);

  async function loadStrategies() {
    if (!agentId) return;
    setStrategies("loading");
    try {
      const resp = await api(`strategy/${agentId}`);
      const data = await resp.json();
      if (data.error) {
        setStrategies("error");
        return;
      }
      setStrategies(data.strategies ?? []);
    } catch {
      setStrategies("error");
    }
  }

  async function createStrategy(e: FormEvent) {
    e.preventDefault();
    setStrategyStatus("creating…");
    const params =
      strategyType === "dca" ? { intervalMs: Number(dcaIntervalMin) * 60_000 } :
      strategyType === "grid" ? { lowerPrice: Number(gridLower), upperPrice: Number(gridUpper), levels: Number(gridLevels) } :
      {};
    const resp = await api("strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, wallet, type: strategyType, coin: strategyCoin, sizeUsd: Number(strategySizeUsd), params }),
    });
    const data = await resp.json();
    setStrategyStatus(data.error ? `error: ${data.error}` : "created");
    if (!data.error) loadStrategies();
  }

  async function toggleStrategy(id: string, enabled: boolean) {
    await api(`strategy/${id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    loadStrategies();
  }

  async function fireSignal(id: string) {
    setStrategyStatus(`firing ${id}…`);
    const resp = await api(`strategy/${id}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ masterSecret }),
    });
    const data = await resp.json();
    setStrategyStatus(data.error ? `error: ${data.error}` : `fired — task ${data.taskId}`);
  }

  async function executePending(id: string) {
    setExecutingId(id);
    setStrategyStatus(null);
    try {
      const resp = await api(`strategy/${id}/execute-pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterSecret }),
      });
      const data = await resp.json();
      setStrategyStatus(data.error ? `error: ${data.error}` : `executed — task ${data.taskId}`);
      loadStrategies();
    } finally {
      setExecutingId(null);
    }
  }

  function loadAgentData() {
    loadWalletStatus();
    loadRiskConfig();
    loadHistory();
    loadStrategies();
  }

  const pendingStrategies = Array.isArray(strategies) ? strategies.filter((s) => s.pendingSignal) : [];

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Hyperliquid Trading</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Each agent trades with its own Hyperliquid wallet, signed by a GatewayAgent worker running the official SDK.
          There is no shared platform key — set a wallet below before trading.
        </p>
      </div>

      <Section title="Agent">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="orgId" className={labelClass}>Org ID</label>
            <input id="orgId" name="orgId" className={inputClass} value={orgId} onChange={(e) => setOrgId(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="agentId" className={labelClass}>Agent ID</label>
            <input
              id="agentId" name="agentId" className={inputClass} value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              onBlur={loadAgentData}
              autoComplete="off"
            />
          </div>
        </div>
        <div>
          <label htmlFor="wallet" className={labelClass}>Hyperliquid wallet address</label>
          <input
            id="wallet" name="wallet" className={inputClass} placeholder="0x…" value={wallet}
            onChange={(e) => setWallet(e.target.value)} autoComplete="off"
          />
          <p className="text-xs text-muted-foreground mt-1">The public address for the key set below — used to look up positions and account value.</p>
        </div>
        <div>
          <label htmlFor="masterSecret" className={labelClass}>Passphrase</label>
          <input
            id="masterSecret" name="masterSecret" type="password" className={inputClass}
            placeholder="Decrypts this agent's wallet — never stored" value={masterSecret}
            onChange={(e) => setMasterSecret(e.target.value)} autoComplete="off"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Held only in this tab while it&apos;s open. Required for every trade, close, or strategy execution below.
          </p>
        </div>
      </Section>

      <Section title="Wallet">
        {walletLoading ? (
          <Spinner label="Checking wallet status…" />
        ) : walletStatus?.hasWallet ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge tone="success">Wallet set</Badge>
              <Badge tone={walletStatus.network === "mainnet" ? "danger" : "neutral"}>{walletStatus.network}</Badge>
            </div>
            <div className="flex gap-2">
              <button type="button" className={secondaryButtonClass()} onClick={() => setWalletFormOpen((v) => !v)}>
                Rotate key
              </button>
              <button type="button" className={secondaryButtonClass("text-destructive hover:bg-destructive/10")} onClick={removeWallet}>
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <Badge tone="warning">No wallet set — this agent can&apos;t trade yet</Badge>
            <button type="button" className={primaryButtonClass()} onClick={() => setWalletFormOpen(true)} disabled={!agentId || !orgId}>
              Set wallet
            </button>
          </div>
        )}

        {walletFormOpen && (
          <form className="space-y-2 border-t border-border pt-3" onSubmit={saveWallet}>
            <div>
              <label htmlFor="walletKey" className={labelClass}>Hyperliquid private key</label>
              <input
                id="walletKey" name="walletKey" type="password" className={inputClass} required
                value={walletKeyInput} onChange={(e) => setWalletKeyInput(e.target.value)} autoComplete="new-password"
              />
            </div>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label htmlFor="walletNetwork" className={labelClass}>Network</label>
                <select
                  id="walletNetwork" name="walletNetwork" className={inputClass}
                  value={walletNetwork} onChange={(e) => setWalletNetwork(e.target.value as Network)}
                >
                  <option value="testnet">Testnet</option>
                  <option value="mainnet">Mainnet</option>
                </select>
              </div>
              <button type="submit" className={primaryButtonClass()} disabled={!masterSecret || !walletKeyInput}>
                Save
              </button>
            </div>
            {!masterSecret && <p className="text-xs text-muted-foreground">Enter a passphrase above first — it encrypts this key.</p>}
          </form>
        )}
        {walletActionStatus && <p className="text-xs text-muted-foreground">{walletActionStatus}</p>}
      </Section>

      {pendingStrategies.length > 0 && (
        <Section title="Pending signals" description="Triggered by a strategy's conditions — needs your passphrase to actually place the trade.">
          <div className="space-y-2">
            {pendingStrategies.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md bg-amber-500/10 px-3 py-2">
                <span className="text-sm">
                  {s.type} · {s.coin} · ${s.sizeUsd}
                </span>
                <button
                  type="button"
                  className={primaryButtonClass()}
                  onClick={() => executePending(s.id)}
                  disabled={!masterSecret || executingId === s.id}
                >
                  {executingId === s.id ? "Executing…" : "Execute"}
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <div role="tablist" aria-label="Trading sections" className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
              (activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "trade" && (
        <Section title="Place a trade">
          <form className="space-y-3" onSubmit={submitTrade}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="coin" className={labelClass}>Coin</label>
                <input id="coin" name="coin" className={inputClass} value={coin} onChange={(e) => setCoin(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="sizeUsd" className={labelClass}>Size (USD)</label>
                <input
                  id="sizeUsd" name="sizeUsd" type="number" min="0" step="0.01" className={inputClass}
                  value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} required
                />
              </div>
            </div>
            {livePrice != null && <p className="text-sm text-muted-foreground">Mid price: ${livePrice.toLocaleString()}</p>}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="orderType" className={labelClass}>Order type</label>
                <select id="orderType" name="orderType" className={inputClass} value={orderType} onChange={(e) => setOrderType(e.target.value as "market" | "limit")}>
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                </select>
              </div>
              {orderType === "limit" && (
                <div>
                  <label htmlFor="limitPrice" className={labelClass}>Limit price</label>
                  <input id="limitPrice" name="limitPrice" type="number" min="0" step="0.01" className={inputClass} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} required />
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="leverage" className={labelClass}>Leverage</label>
                <input id="leverage" name="leverage" type="number" min="1" className={inputClass} value={leverage} onChange={(e) => setLeverage(e.target.value)} />
              </div>
              <div>
                <label htmlFor="stopLossPct" className={labelClass}>Stop-loss %</label>
                <input id="stopLossPct" name="stopLossPct" type="number" min="0" className={inputClass} value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} />
              </div>
              <div>
                <label htmlFor="takeProfitPct" className={labelClass}>Take-profit %</label>
                <input id="takeProfitPct" name="takeProfitPct" type="number" min="0" className={inputClass} value={takeProfitPct} onChange={(e) => setTakeProfitPct(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="isBuy" name="isBuy" type="checkbox" checked={isBuy} onChange={(e) => setIsBuy(e.target.checked)} className="h-4 w-4 rounded border-input focus-visible:ring-2 focus-visible:ring-ring" />
              <label htmlFor="isBuy" className="text-sm">Buy (unchecked = sell)</label>
            </div>
            <div className="flex gap-2">
              <button type="submit" className={primaryButtonClass()} disabled={tradeSubmitting || !masterSecret || !walletStatus?.hasWallet}>
                {tradeSubmitting ? "Placing…" : "Place trade"}
              </button>
              <button type="button" className={secondaryButtonClass()} onClick={checkStatus} disabled={!taskId}>
                Check status
              </button>
            </div>
            {!walletStatus?.hasWallet && <p className="text-xs text-muted-foreground">Set a wallet above before trading.</p>}
            {taskId && <p className="text-xs text-muted-foreground">task: {taskId}</p>}
            {tradeStatus && <p className="text-sm text-muted-foreground">{tradeStatus}</p>}
          </form>
        </Section>
      )}

      {activeTab === "positions" && (
        <Section title="Positions & account">
          <button type="button" className={secondaryButtonClass()} onClick={refreshAccount} disabled={!wallet}>
            Refresh
          </button>
          {accountValue != null && <p className="text-sm text-muted-foreground">Account equity: ${accountValue.toFixed(2)}</p>}

          {positions === "loading" && <Spinner label="Loading positions…" />}
          {positions === "error" && <ErrorNote message="Couldn't load positions." onRetry={refreshAccount} />}
          {positions === null && <p className="text-sm text-muted-foreground">Enter a wallet address and refresh to see positions.</p>}
          {Array.isArray(positions) && positions.length === 0 && <p className="text-sm text-muted-foreground">No open positions.</p>}
          {Array.isArray(positions) && positions.length > 0 && (
            <div className="space-y-2">
              {positions.map((p) => (
                <div key={p.coin} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <div>
                    <div className="font-medium text-foreground">{p.coin} {p.size > 0 ? "long" : "short"}</div>
                    <div className="text-muted-foreground">
                      ${Math.abs(p.notionalUsd).toFixed(2)} notional · entry ${p.entryPrice.toFixed(2)} ·{" "}
                      <span className={p.unrealizedPnl >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}{p.unrealizedPnl.toFixed(2)} PnL
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={secondaryButtonClass()}
                    onClick={() => closePosition(p.coin)}
                    disabled={closingCoin === p.coin || !masterSecret}
                  >
                    {closingCoin === p.coin ? "Closing…" : "Close"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {activeTab === "strategies" && (
        <Section title="Strategies" description="DCA and grid conditions are detected automatically but still need your passphrase to execute (see Pending signals above).">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{Array.isArray(strategies) ? `${strategies.length} strategies` : ""}</span>
            <button type="button" className={secondaryButtonClass()} onClick={loadStrategies}>Refresh</button>
          </div>

          {strategies === "loading" && <Spinner label="Loading strategies…" />}
          {strategies === "error" && <ErrorNote message="Couldn't load strategies." onRetry={loadStrategies} />}
          {Array.isArray(strategies) && strategies.length === 0 && <p className="text-sm text-muted-foreground">No strategies yet — create one below.</p>}
          {Array.isArray(strategies) && strategies.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
              <span className="flex items-center gap-2">
                {s.type} · {s.coin} · ${s.sizeUsd}
                {!s.enabled && <Badge tone="neutral">disabled</Badge>}
                {s.pendingSignal && <Badge tone="warning">pending</Badge>}
              </span>
              <div className="flex gap-2">
                {s.type === "signal" && (
                  <button type="button" className={secondaryButtonClass()} onClick={() => fireSignal(s.id)} disabled={!masterSecret}>
                    Fire
                  </button>
                )}
                <button type="button" className={secondaryButtonClass()} onClick={() => toggleStrategy(s.id, !s.enabled)}>
                  {s.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))}

          <form className="space-y-2 border-t border-border pt-3" onSubmit={createStrategy}>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="strategyType" className={labelClass}>Type</label>
                <select id="strategyType" name="strategyType" className={inputClass} value={strategyType} onChange={(e) => setStrategyType(e.target.value as typeof strategyType)}>
                  <option value="dca">DCA</option>
                  <option value="grid">Grid</option>
                  <option value="signal">Signal</option>
                </select>
              </div>
              <div>
                <label htmlFor="strategyCoin" className={labelClass}>Coin</label>
                <input id="strategyCoin" name="strategyCoin" className={inputClass} value={strategyCoin} onChange={(e) => setStrategyCoin(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="strategySizeUsd" className={labelClass}>Size (USD)</label>
                <input id="strategySizeUsd" name="strategySizeUsd" type="number" min="0" className={inputClass} value={strategySizeUsd} onChange={(e) => setStrategySizeUsd(e.target.value)} required />
              </div>
            </div>
            {strategyType === "dca" && (
              <div>
                <label htmlFor="dcaInterval" className={labelClass}>Interval (minutes)</label>
                <input id="dcaInterval" name="dcaInterval" type="number" min="1" className={inputClass} value={dcaIntervalMin} onChange={(e) => setDcaIntervalMin(e.target.value)} required />
              </div>
            )}
            {strategyType === "grid" && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label htmlFor="gridLower" className={labelClass}>Lower price</label>
                  <input id="gridLower" name="gridLower" type="number" min="0" className={inputClass} value={gridLower} onChange={(e) => setGridLower(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="gridUpper" className={labelClass}>Upper price</label>
                  <input id="gridUpper" name="gridUpper" type="number" min="0" className={inputClass} value={gridUpper} onChange={(e) => setGridUpper(e.target.value)} required />
                </div>
                <div>
                  <label htmlFor="gridLevels" className={labelClass}>Levels</label>
                  <input id="gridLevels" name="gridLevels" type="number" min="1" className={inputClass} value={gridLevels} onChange={(e) => setGridLevels(e.target.value)} required />
                </div>
              </div>
            )}
            <button type="submit" className={primaryButtonClass()} disabled={!agentId || !wallet}>Create strategy</button>
            {strategyStatus && <p className="text-sm text-muted-foreground">{strategyStatus}</p>}
          </form>
        </Section>
      )}

      {activeTab === "history" && (
        <Section title="Trade history">
          <button type="button" className={secondaryButtonClass()} onClick={loadHistory}>Refresh</button>
          {history === "loading" && <Spinner label="Loading history…" />}
          {history === "error" && <ErrorNote message="Couldn't load trade history." onRetry={loadHistory} />}
          {history && history !== "loading" && history !== "error" && (
            <>
              {history.stats.count === 0 ? (
                <p className="text-sm text-muted-foreground">No closed trades yet.</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {history.stats.count} closed trades · win rate {(history.stats.winRate * 100).toFixed(0)}% ·{" "}
                    <span className={history.stats.totalPnl >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                      {history.stats.totalPnl >= 0 ? "+" : ""}{history.stats.totalPnl.toFixed(2)} total PnL
                    </span>
                  </p>
                  <div className="space-y-1">
                    {history.trades.map((t) => (
                      <div key={t.id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                        <span>{t.coin} {t.isBuy ? "buy" : "sell"} ${t.sizeUsd} ({t.status})</span>
                        {t.realizedPnl != null && (
                          <span className={t.realizedPnl >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                            {t.realizedPnl >= 0 ? "+" : ""}{t.realizedPnl.toFixed(2)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </Section>
      )}

      {activeTab === "risk" && (
        <Section title="Risk limits" description="Enforced on every trade this agent places, manual or strategy-fired.">
          <form className="space-y-2" onSubmit={saveRiskConfig}>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="riskLeverage" className={labelClass}>Leverage</label>
                <input id="riskLeverage" name="riskLeverage" type="number" min="1" className={inputClass} value={riskLeverage} onChange={(e) => setRiskLeverage(e.target.value)} />
              </div>
              <div>
                <label htmlFor="riskMaxPosition" className={labelClass}>Max position $</label>
                <input id="riskMaxPosition" name="riskMaxPosition" type="number" min="0" className={inputClass} value={riskMaxPosition} onChange={(e) => setRiskMaxPosition(e.target.value)} />
              </div>
              <div>
                <label htmlFor="riskMaxDailyLoss" className={labelClass}>Max daily loss $</label>
                <input id="riskMaxDailyLoss" name="riskMaxDailyLoss" type="number" min="0" className={inputClass} value={riskMaxDailyLoss} onChange={(e) => setRiskMaxDailyLoss(e.target.value)} />
              </div>
            </div>
            <button type="submit" className={primaryButtonClass()} disabled={!agentId}>Save risk limits</button>
            {riskConfig && (
              <p className="text-sm text-muted-foreground">
                Current: {riskConfig.leverage}x, max ${riskConfig.maxPositionUsd}/trade, max ${riskConfig.maxDailyLossUsd}/day loss
              </p>
            )}
            {riskStatus && <p className="text-sm text-muted-foreground">{riskStatus}</p>}
          </form>
        </Section>
      )}
    </div>
  );
}

export default defineClientMod({ panels: { trading: TradingPanel } });
