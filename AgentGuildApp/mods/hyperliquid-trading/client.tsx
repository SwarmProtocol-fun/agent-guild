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
  type: "dca" | "grid" | "signal" | "sniper";
  coin: string;
  sizeUsd: number;
  enabled: boolean;
  pendingSignal: boolean;
  webhookToken: string | null;
}

interface RiskConfig {
  leverage: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
}

interface ReferralStats {
  code: string;
  referredBy: string | null;
  referredCount: number;
  totalVolumeUsd: number;
  rewardUsd: number;
}

interface MarketCoin {
  coin: string;
  markPx: number;
  change24hPct: number;
  volume24hUsd: number;
  openInterestUsd: number;
  fundingRatePct: number;
  maxLeverage: number;
}

type Tab = "market" | "trade" | "positions" | "strategies" | "history" | "risk" | "referral";
type MarketSort = "volume" | "price" | "change" | "funding";

const TABS: { id: Tab; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "trade", label: "Trade" },
  { id: "positions", label: "Positions" },
  { id: "strategies", label: "Strategies" },
  { id: "history", label: "History" },
  { id: "risk", label: "Risk limits" },
  { id: "referral", label: "Referral" },
];

const MARKET_SORTS: { id: MarketSort; label: string }[] = [
  { id: "volume", label: "Vol" },
  { id: "price", label: "Price" },
  { id: "change", label: "24h%" },
  { id: "funding", label: "Funding" },
];

function formatPrice(n: number) {
  return n.toLocaleString(undefined, n >= 1 ? { maximumFractionDigits: 2, minimumFractionDigits: 2 } : { maximumFractionDigits: 6 });
}

function formatCompactUsd(n: number) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const inputClass =
  "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const labelClass = "block text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1";

const monoClass = "font-mono tabular-nums";

function pnlClass(value: number) {
  return value >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive";
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function PulseDot({ tone }: { tone: "live" | "idle" | "danger" }) {
  const color = { live: "bg-green-500", idle: "bg-muted-foreground/40", danger: "bg-destructive" }[tone];
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
      {tone === "live" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`} />}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

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
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${toneClass}`}>
      {children}
    </span>
  );
}

function Section({ title, description, dense, right, children }: {
  title: string;
  description?: string;
  dense?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-card-foreground">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {right}
      </div>
      <div className={dense ? "p-2 space-y-2" : "p-3 space-y-3"}>{children}</div>
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

  // ── Market overview ────────────────────────────────────────────────────────
  const [marketCoins, setMarketCoins] = useState<MarketCoin[] | "loading" | "error" | null>(null);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSort, setMarketSort] = useState<MarketSort>("volume");

  async function loadMarket() {
    setMarketCoins((prev) => (Array.isArray(prev) ? prev : "loading"));
    try {
      const resp = await api(`market?network=${network}`);
      const data = await resp.json();
      if (data.error) {
        setMarketCoins("error");
        return;
      }
      setMarketCoins(data.coins ?? []);
    } catch {
      setMarketCoins("error");
    }
  }

  useEffect(() => {
    if (activeTab !== "market") return;
    loadMarket();
    const id = setInterval(loadMarket, 15000);
    return () => clearInterval(id);
  }, [activeTab, network]);

  const filteredMarket = Array.isArray(marketCoins)
    ? marketCoins
        .filter((c) => c.coin.toLowerCase().includes(marketQuery.toLowerCase()))
        .sort((a, b) => {
          if (marketSort === "price") return b.markPx - a.markPx;
          if (marketSort === "change") return b.change24hPct - a.change24hPct;
          if (marketSort === "funding") return b.fundingRatePct - a.fundingRatePct;
          return b.volume24hUsd - a.volume24hUsd;
        })
    : [];

  function pickCoin(c: string) {
    setCoin(c);
    setActiveTab("trade");
  }

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

  // ── Referral ───────────────────────────────────────────────────────────────
  const [referral, setReferral] = useState<ReferralStats | "loading" | "error" | null>(null);
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralStatus, setReferralStatus] = useState<string | null>(null);

  async function loadReferral() {
    if (!agentId) return;
    setReferral("loading");
    try {
      const resp = await api(`referral/${agentId}?orgId=${encodeURIComponent(orgId)}`);
      const data = await resp.json();
      setReferral(data);
    } catch {
      setReferral("error");
    }
  }

  async function applyReferral(e: FormEvent) {
    e.preventDefault();
    setReferralStatus("applying…");
    const resp = await api("referral/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, referralCode: referralCodeInput }),
    });
    const data = await resp.json();
    setReferralStatus(data.error ? `error: ${data.error}` : "applied");
    if (!data.error) {
      setReferralCodeInput("");
      loadReferral();
    }
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
  const [strategyType, setStrategyType] = useState<"dca" | "grid" | "signal" | "sniper">("dca");
  const [strategyCoin, setStrategyCoin] = useState("ETH");
  const [strategySizeUsd, setStrategySizeUsd] = useState("10");
  const [dcaIntervalMin, setDcaIntervalMin] = useState("60");
  const [gridLower, setGridLower] = useState("");
  const [gridUpper, setGridUpper] = useState("");
  const [gridLevels, setGridLevels] = useState("5");
  const [sniperMode, setSniperMode] = useState<"new-listing" | "price-above" | "price-below">("new-listing");
  const [sniperTargetPrice, setSniperTargetPrice] = useState("");
  const [strategyStatus, setStrategyStatus] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [webhookBusyId, setWebhookBusyId] = useState<string | null>(null);

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
      strategyType === "sniper" ? { mode: sniperMode, ...(sniperMode !== "new-listing" ? { targetPrice: Number(sniperTargetPrice) } : {}) } :
      {};
    const coin = strategyType === "sniper" && sniperMode === "new-listing" ? strategyCoin || "ANY" : strategyCoin;
    const resp = await api("strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, agentId, wallet, type: strategyType, coin, sizeUsd: Number(strategySizeUsd), params }),
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

  async function issueWebhook(id: string) {
    setWebhookBusyId(id);
    try {
      const resp = await api(`strategy/${id}/webhook-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, agentId }),
      });
      const data = await resp.json();
      if (data.error) {
        setStrategyStatus(`error: ${data.error}`);
        return;
      }
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setWebhookUrls((prev) => ({ ...prev, [id]: `${origin}${data.path}` }));
    } finally {
      setWebhookBusyId(null);
    }
  }

  async function revokeWebhook(id: string) {
    setWebhookBusyId(id);
    try {
      await api(`strategy/${id}/webhook-token`, { method: "DELETE" });
      setWebhookUrls((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setWebhookBusyId(null);
    }
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
    loadReferral();
  }

  const pendingStrategies = Array.isArray(strategies) ? strategies.filter((s) => s.pendingSignal) : [];

  return (
    <div className="max-w-3xl mx-auto space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between gap-3 rounded-sm border border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <PulseDot tone={walletStatus?.hasWallet ? "live" : "idle"} />
          <h1 className="text-sm font-semibold uppercase tracking-wide text-foreground">Hyperliquid Trading</h1>
          {walletStatus?.hasWallet && (
            <Badge tone={walletStatus.network === "mainnet" ? "danger" : "neutral"}>{walletStatus.network}</Badge>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs">
          {livePrice != null && (
            <span className="text-muted-foreground">
              {coin} <span className={`${monoClass} text-foreground`}>${livePrice.toLocaleString()}</span>
            </span>
          )}
          {accountValue != null && (
            <span className="text-muted-foreground">
              Equity <span className={`${monoClass} text-foreground`}>${accountValue.toFixed(2)}</span>
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground px-1">
        Each agent trades with its own wallet via a GatewayAgent worker running the official SDK — no shared platform key.
      </p>

      <Section title="Agent" dense>
        <div className="grid grid-cols-3 gap-2">
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
          <div>
            <label htmlFor="wallet" className={labelClass}>Wallet address</label>
            <input
              id="wallet" name="wallet" className={`${inputClass} ${monoClass}`} placeholder="0x…" value={wallet}
              onChange={(e) => setWallet(e.target.value)} autoComplete="off"
            />
          </div>
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

      <Section
        title="Wallet"
        dense
        right={
          walletStatus?.hasWallet ? (
            <div className="flex gap-2">
              <button type="button" className={secondaryButtonClass()} onClick={() => setWalletFormOpen((v) => !v)}>
                Rotate key
              </button>
              <button type="button" className={secondaryButtonClass("text-destructive hover:bg-destructive/10")} onClick={removeWallet}>
                Remove
              </button>
            </div>
          ) : (
            <button type="button" className={primaryButtonClass()} onClick={() => setWalletFormOpen(true)} disabled={!agentId || !orgId}>
              Set wallet
            </button>
          )
        }
      >
        {walletLoading ? (
          <Spinner label="Checking wallet status…" />
        ) : walletStatus?.hasWallet ? (
          <div className="flex items-center gap-2">
            <Badge tone="success">Wallet set</Badge>
          </div>
        ) : (
          <Badge tone="warning">No wallet set — this agent can&apos;t trade yet</Badge>
        )}

        {walletFormOpen && (
          <form className="space-y-2 border-t border-border pt-2" onSubmit={saveWallet}>
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
        <div className="rounded-sm border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 border-b border-amber-500/20 px-3 py-1.5">
            <PulseDot tone="danger" />
            <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Pending signals
            </span>
            <span className="text-xs text-muted-foreground">— needs your passphrase to fire</span>
          </div>
          <div className="divide-y divide-amber-500/10">
            {pendingStrategies.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span className={monoClass}>
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
        </div>
      )}

      <div role="tablist" aria-label="Trading sections" className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map((tab) => {
          const count =
            tab.id === "positions" ? (Array.isArray(positions) ? positions.length : null) :
            tab.id === "strategies" ? (Array.isArray(strategies) ? strategies.length : null) :
            tab.id === "history" ? (history && history !== "loading" && history !== "error" ? history.stats.count : null) :
            null;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={
                "px-2.5 py-1.5 text-xs font-medium uppercase tracking-wide border-b-2 -mb-px whitespace-nowrap transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                (activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground")
              }
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {count != null && <span className={`ml-1 ${monoClass} text-muted-foreground`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {activeTab === "market" && (
        <Section
          title="Market overview"
          dense
          description="Every tradeable perp, ranked by 24h volume — click a row to load it into Trade."
          right={
            <div className="flex items-center gap-2">
              <div className="flex rounded-sm border border-border overflow-hidden">
                {MARKET_SORTS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={
                      "px-2 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors " +
                      (marketSort === s.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
                    }
                    onClick={() => setMarketSort(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <input
                className={`${inputClass} ${monoClass} w-24`}
                placeholder="search"
                value={marketQuery}
                onChange={(e) => setMarketQuery(e.target.value)}
              />
              <button type="button" className={secondaryButtonClass()} onClick={loadMarket}>Refresh</button>
            </div>
          }
        >
          {marketCoins === "loading" && <Spinner label="Loading market…" />}
          {marketCoins === "error" && <ErrorNote message="Couldn't load market overview." onRetry={loadMarket} />}
          {Array.isArray(marketCoins) && filteredMarket.length === 0 && (
            <p className="text-sm text-muted-foreground">No coins match &quot;{marketQuery}&quot;.</p>
          )}
          {Array.isArray(marketCoins) && filteredMarket.length > 0 && (
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="pb-1 font-medium">Coin</th>
                    <th className="pb-1 font-medium text-right">Price</th>
                    <th className="pb-1 font-medium text-right">24h %</th>
                    <th className="pb-1 font-medium text-right">Volume</th>
                    <th className="pb-1 font-medium text-right">OI</th>
                    <th className="pb-1 font-medium text-right">Funding</th>
                    <th className="pb-1 font-medium text-right">Max lev</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredMarket.map((c) => (
                    <tr
                      key={c.coin}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => pickCoin(c.coin)}
                    >
                      <td className="py-1.5 font-medium text-foreground">{c.coin}</td>
                      <td className={`py-1.5 text-right ${monoClass} text-foreground`}>${formatPrice(c.markPx)}</td>
                      <td className={`py-1.5 text-right ${monoClass} ${pnlClass(c.change24hPct)}`}>{signed(c.change24hPct)}%</td>
                      <td className={`py-1.5 text-right ${monoClass} text-muted-foreground`}>{formatCompactUsd(c.volume24hUsd)}</td>
                      <td className={`py-1.5 text-right ${monoClass} text-muted-foreground`}>{formatCompactUsd(c.openInterestUsd)}</td>
                      <td className={`py-1.5 text-right ${monoClass} ${pnlClass(c.fundingRatePct)}`}>{c.fundingRatePct.toFixed(4)}%</td>
                      <td className={`py-1.5 text-right ${monoClass} text-muted-foreground`}>{c.maxLeverage}x</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {activeTab === "trade" && (
        <Section title="Place a trade" dense>
          <form className="space-y-2" onSubmit={submitTrade}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="coin" className={labelClass}>Coin</label>
                <input id="coin" name="coin" className={`${inputClass} ${monoClass}`} value={coin} onChange={(e) => setCoin(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="sizeUsd" className={labelClass}>Size (USD)</label>
                <input
                  id="sizeUsd" name="sizeUsd" type="number" min="0" step="0.01" className={`${inputClass} ${monoClass}`}
                  value={sizeUsd} onChange={(e) => setSizeUsd(e.target.value)} required
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-sm border border-border bg-background px-2.5 py-1.5">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <PulseDot tone={livePrice != null ? "live" : "idle"} />
                Mid price
              </span>
              <span className={`${monoClass} text-sm text-foreground`}>
                {livePrice != null ? `$${livePrice.toLocaleString()}` : "—"}
              </span>
            </div>
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
        <Section
          title="Positions & account"
          dense
          right={
            <div className="flex items-center gap-3">
              {accountValue != null && (
                <span className="text-xs text-muted-foreground">
                  Equity <span className={`${monoClass} text-foreground`}>${accountValue.toFixed(2)}</span>
                </span>
              )}
              <button type="button" className={secondaryButtonClass()} onClick={refreshAccount} disabled={!wallet}>
                Refresh
              </button>
            </div>
          }
        >
          {positions === "loading" && <Spinner label="Loading positions…" />}
          {positions === "error" && <ErrorNote message="Couldn't load positions." onRetry={refreshAccount} />}
          {positions === null && <p className="text-sm text-muted-foreground">Enter a wallet address and refresh to see positions.</p>}
          {Array.isArray(positions) && positions.length === 0 && <p className="text-sm text-muted-foreground">No open positions.</p>}
          {Array.isArray(positions) && positions.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1 font-medium">Coin</th>
                  <th className="pb-1 font-medium text-right">Notional</th>
                  <th className="pb-1 font-medium text-right">Entry</th>
                  <th className="pb-1 font-medium text-right">PnL</th>
                  <th className="pb-1 font-medium text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {positions.map((p) => (
                  <tr key={p.coin}>
                    <td className="py-1.5">
                      <span className="font-medium text-foreground">{p.coin}</span>{" "}
                      <Badge tone={p.size > 0 ? "success" : "danger"}>{p.size > 0 ? "long" : "short"}</Badge>
                    </td>
                    <td className={`py-1.5 text-right ${monoClass} text-foreground`}>${Math.abs(p.notionalUsd).toFixed(2)}</td>
                    <td className={`py-1.5 text-right ${monoClass} text-muted-foreground`}>${p.entryPrice.toFixed(2)}</td>
                    <td className={`py-1.5 text-right ${monoClass} ${pnlClass(p.unrealizedPnl)}`}>{signed(p.unrealizedPnl)}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        className={secondaryButtonClass()}
                        onClick={() => closePosition(p.coin)}
                        disabled={closingCoin === p.coin || !masterSecret}
                      >
                        {closingCoin === p.coin ? "Closing…" : "Close"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {activeTab === "strategies" && (
        <Section
          title="Strategies"
          dense
          description="DCA, grid, and sniper conditions are detected automatically but still need your passphrase to execute (see Pending signals above)."
          right={<button type="button" className={secondaryButtonClass()} onClick={loadStrategies}>Refresh</button>}
        >
          {strategies === "loading" && <Spinner label="Loading strategies…" />}
          {strategies === "error" && <ErrorNote message="Couldn't load strategies." onRetry={loadStrategies} />}
          {Array.isArray(strategies) && strategies.length === 0 && <p className="text-sm text-muted-foreground">No strategies yet — create one below.</p>}
          {Array.isArray(strategies) && strategies.length > 0 && (
            <div className="divide-y divide-border rounded-sm border border-border">
              {strategies.map((s) => (
                <div key={s.id} className="p-2 text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-2 ${monoClass}`}>
                      <Badge tone="neutral">{s.type}</Badge>
                      {s.coin} · ${s.sizeUsd}
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

                  {s.type === "signal" && (
                    <div className="border-t border-border pt-2 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        {webhookUrls[s.id] || s.webhookToken ? (
                          <>
                            <code className={`text-xs text-muted-foreground truncate ${monoClass}`}>
                              {webhookUrls[s.id] ?? "webhook configured — generate again to view the URL"}
                            </code>
                            <button
                              type="button"
                              className={secondaryButtonClass("text-destructive hover:bg-destructive/10 shrink-0")}
                              onClick={() => revokeWebhook(s.id)}
                              disabled={webhookBusyId === s.id}
                            >
                              Revoke webhook
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="text-xs text-muted-foreground">No webhook — paste a URL from TradingView to fire this strategy externally.</span>
                            <button type="button" className={secondaryButtonClass("shrink-0")} onClick={() => issueWebhook(s.id)} disabled={webhookBusyId === s.id}>
                              {webhookBusyId === s.id ? "Generating…" : "Generate webhook"}
                            </button>
                          </>
                        )}
                      </div>
                      {webhookUrls[s.id] && (
                        <p className="text-xs text-amber-600 dark:text-amber-500">
                          TradingView&apos;s alert body for this webhook must include your wallet passphrase
                          (masterSecret) in plain text — it will be stored and transmitted by TradingView&apos;s
                          infrastructure, outside this platform&apos;s control. Only use a passphrase you&apos;re
                          comfortable exposing to that third party.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <form className="space-y-2 border-t border-border pt-3" onSubmit={createStrategy}>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="strategyType" className={labelClass}>Type</label>
                <select id="strategyType" name="strategyType" className={inputClass} value={strategyType} onChange={(e) => setStrategyType(e.target.value as typeof strategyType)}>
                  <option value="dca">DCA</option>
                  <option value="grid">Grid</option>
                  <option value="signal">Signal</option>
                  <option value="sniper">Sniper</option>
                </select>
              </div>
              <div>
                <label htmlFor="strategyCoin" className={labelClass}>Coin</label>
                <input
                  id="strategyCoin" name="strategyCoin" className={inputClass} value={strategyCoin}
                  onChange={(e) => setStrategyCoin(e.target.value)}
                  placeholder={strategyType === "sniper" && sniperMode === "new-listing" ? "ANY (or a specific coin)" : undefined}
                  required={!(strategyType === "sniper" && sniperMode === "new-listing")}
                />
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
            {strategyType === "sniper" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="sniperMode" className={labelClass}>Trigger</label>
                  <select id="sniperMode" name="sniperMode" className={inputClass} value={sniperMode} onChange={(e) => setSniperMode(e.target.value as typeof sniperMode)}>
                    <option value="new-listing">New listing</option>
                    <option value="price-above">Price rises above</option>
                    <option value="price-below">Price falls below</option>
                  </select>
                </div>
                {sniperMode !== "new-listing" && (
                  <div>
                    <label htmlFor="sniperTargetPrice" className={labelClass}>Target price</label>
                    <input id="sniperTargetPrice" name="sniperTargetPrice" type="number" min="0" className={inputClass} value={sniperTargetPrice} onChange={(e) => setSniperTargetPrice(e.target.value)} required />
                  </div>
                )}
                {sniperMode === "new-listing" && (
                  <p className="text-xs text-muted-foreground self-end pb-2 col-span-1">
                    Fires once, the moment a new Hyperliquid perp lists. Auto-disarms after firing.
                  </p>
                )}
              </div>
            )}
            <button type="submit" className={primaryButtonClass()} disabled={!agentId || !wallet}>Create strategy</button>
            {strategyStatus && <p className="text-sm text-muted-foreground">{strategyStatus}</p>}
          </form>
        </Section>
      )}

      {activeTab === "history" && (
        <Section
          title="Trade history"
          dense
          right={<button type="button" className={secondaryButtonClass()} onClick={loadHistory}>Refresh</button>}
        >
          {history === "loading" && <Spinner label="Loading history…" />}
          {history === "error" && <ErrorNote message="Couldn't load trade history." onRetry={loadHistory} />}
          {history && history !== "loading" && history !== "error" && (
            <>
              {history.stats.count === 0 ? (
                <p className="text-sm text-muted-foreground">No closed trades yet.</p>
              ) : (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span><span className={`${monoClass} text-foreground`}>{history.stats.count}</span> closed</span>
                    <span>win rate <span className={`${monoClass} text-foreground`}>{(history.stats.winRate * 100).toFixed(0)}%</span></span>
                    <span>
                      total <span className={`${monoClass} ${pnlClass(history.stats.totalPnl)}`}>{signed(history.stats.totalPnl)}</span>
                    </span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="pb-1 font-medium">Coin</th>
                        <th className="pb-1 font-medium text-right">Size</th>
                        <th className="pb-1 font-medium text-right">Status</th>
                        <th className="pb-1 font-medium text-right">PnL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {history.trades.map((t) => (
                        <tr key={t.id}>
                          <td className="py-1.5">
                            <span className="font-medium text-foreground">{t.coin}</span>{" "}
                            <Badge tone={t.isBuy ? "success" : "danger"}>{t.isBuy ? "buy" : "sell"}</Badge>
                          </td>
                          <td className={`py-1.5 text-right ${monoClass} text-foreground`}>${t.sizeUsd}</td>
                          <td className="py-1.5 text-right text-xs text-muted-foreground">{t.status}</td>
                          <td className={`py-1.5 text-right ${monoClass} ${t.realizedPnl != null ? pnlClass(t.realizedPnl) : "text-muted-foreground"}`}>
                            {t.realizedPnl != null ? signed(t.realizedPnl) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </Section>
      )}

      {activeTab === "risk" && (
        <Section title="Risk limits" dense description="Enforced on every trade this agent places, manual or strategy-fired.">
          <form className="space-y-2" onSubmit={saveRiskConfig}>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label htmlFor="riskLeverage" className={labelClass}>Leverage</label>
                <input id="riskLeverage" name="riskLeverage" type="number" min="1" className={`${inputClass} ${monoClass}`} value={riskLeverage} onChange={(e) => setRiskLeverage(e.target.value)} />
              </div>
              <div>
                <label htmlFor="riskMaxPosition" className={labelClass}>Max position $</label>
                <input id="riskMaxPosition" name="riskMaxPosition" type="number" min="0" className={`${inputClass} ${monoClass}`} value={riskMaxPosition} onChange={(e) => setRiskMaxPosition(e.target.value)} />
              </div>
              <div>
                <label htmlFor="riskMaxDailyLoss" className={labelClass}>Max daily loss $</label>
                <input id="riskMaxDailyLoss" name="riskMaxDailyLoss" type="number" min="0" className={`${inputClass} ${monoClass}`} value={riskMaxDailyLoss} onChange={(e) => setRiskMaxDailyLoss(e.target.value)} />
              </div>
            </div>
            <button type="submit" className={primaryButtonClass()} disabled={!agentId}>Save risk limits</button>
            {riskConfig && (
              <p className={`text-xs text-muted-foreground ${monoClass}`}>
                Current: {riskConfig.leverage}x, max ${riskConfig.maxPositionUsd}/trade, max ${riskConfig.maxDailyLossUsd}/day loss
              </p>
            )}
            {riskStatus && <p className="text-sm text-muted-foreground">{riskStatus}</p>}
          </form>
        </Section>
      )}

      {activeTab === "referral" && (
        <Section title="Referral" dense description="Refer another agent and earn a cut of the trading volume it generates.">
          {referral === "loading" && <Spinner label="Loading referral stats…" />}
          {referral === "error" && <ErrorNote message="Couldn't load referral stats." onRetry={loadReferral} />}
          {referral && referral !== "loading" && referral !== "error" && (
            <>
              <div>
                <p className={labelClass}>Your referral code</p>
                <code className={`text-sm ${monoClass}`}>{referral.code}</code>
                <p className="text-xs text-muted-foreground mt-1">Share this agent ID — anyone who applies it below counts toward your referral stats.</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="rounded-sm border border-border p-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Referred agents</div>
                  <div className={`font-medium ${monoClass}`}>{referral.referredCount}</div>
                </div>
                <div className="rounded-sm border border-border p-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Volume generated</div>
                  <div className={`font-medium ${monoClass}`}>${referral.totalVolumeUsd.toFixed(2)}</div>
                </div>
                <div className="rounded-sm border border-border p-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Reward earned</div>
                  <div className={`font-medium ${monoClass} text-green-600 dark:text-green-400`}>${referral.rewardUsd.toFixed(2)}</div>
                </div>
              </div>
              {referral.referredBy ? (
                <p className="text-sm text-muted-foreground">Referred by <code className={monoClass}>{referral.referredBy}</code>.</p>
              ) : (
                <form className="flex gap-2 items-end border-t border-border pt-3" onSubmit={applyReferral}>
                  <div className="flex-1">
                    <label htmlFor="referralCodeInput" className={labelClass}>Have a referral code?</label>
                    <input
                      id="referralCodeInput" name="referralCodeInput" className={inputClass}
                      value={referralCodeInput} onChange={(e) => setReferralCodeInput(e.target.value)}
                      placeholder="Referring agent's ID"
                    />
                  </div>
                  <button type="submit" className={primaryButtonClass()} disabled={!agentId || !referralCodeInput}>Apply</button>
                </form>
              )}
              {referralStatus && <p className="text-sm text-muted-foreground">{referralStatus}</p>}
            </>
          )}
        </Section>
      )}
    </div>
  );
}

export default defineClientMod({ panels: { trading: TradingPanel } });
