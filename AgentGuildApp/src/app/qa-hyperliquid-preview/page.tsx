"use client";

/** TEMPORARY QA harness for the hyperliquid-trading mod — not part of the app, delete before committing. */

import mod from "../../../mods/hyperliquid-trading/client";
import marketCoins from "./market-fixture.json";

const TradingPanel = mod.panels!.trading;

const positions = [
  { coin: "ETH", size: 2.5, notionalUsd: 7250.4, entryPrice: 2820.1, unrealizedPnl: 115.25 },
  { coin: "SOL", size: -40, notionalUsd: -4732.0, entryPrice: 121.4, unrealizedPnl: -62.8 },
];

const strategies = [
  { id: "strat_1", type: "dca", coin: "BTC", sizeUsd: 50, enabled: true, pendingSignal: true, webhookToken: null },
  { id: "strat_2", type: "grid", coin: "ETH", sizeUsd: 20, enabled: true, pendingSignal: false, webhookToken: null },
  { id: "strat_3", type: "signal", coin: "SOL", sizeUsd: 30, enabled: false, pendingSignal: false, webhookToken: "abc123" },
];

const history = {
  trades: [
    { id: "t1", coin: "ETH", isBuy: true, sizeUsd: 100, fillPrice: 2800, realizedPnl: 12.4, status: "closed" },
    { id: "t2", coin: "BTC", isBuy: false, sizeUsd: 200, fillPrice: 84000, realizedPnl: -8.1, status: "closed" },
    { id: "t3", coin: "SOL", isBuy: true, sizeUsd: 50, status: "opened" },
  ],
  stats: { totalPnl: 4.3, winRate: 0.5, count: 2 },
};

async function mockApi(path: string): Promise<Response> {
  const [base] = path.split("?");
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

  if (base === "market") return json({ coins: marketCoins });
  if (base.startsWith("wallet/")) return json({ hasWallet: true, network: "testnet" });
  if (base.startsWith("price/")) {
    const coin = base.split("/")[1];
    const hit = (marketCoins as { coin: string; markPx: number }[]).find((c) => c.coin === coin);
    return json({ coin, price: hit?.markPx ?? 100 });
  }
  if (base.startsWith("positions/")) return json({ positions });
  if (base.startsWith("account/")) return json({ accountValue: 12450.32, marginUsed: 2100.5, totalPositionValue: 11982.4 });
  if (base.startsWith("risk-config/")) return json({ config: { leverage: 3, maxPositionUsd: 500, maxDailyLossUsd: 100 } });
  if (base.startsWith("strategy/") && base.endsWith("/pending")) return json({ strategies: strategies.filter((s) => s.pendingSignal) });
  if (base.startsWith("strategy/")) return json({ strategies });
  if (base.startsWith("history/")) return json(history);
  if (base.startsWith("referral/")) return json({ code: "agent_demo", referredBy: null, referredCount: 3, totalVolumeUsd: 980.5, rewardUsd: 4.9 });
  return json({ ok: true });
}

export default function QaHyperliquidPreview() {
  return <TradingPanel modId="hyperliquid-trading" address="0xDemoAgentWallet" api={mockApi} />;
}
