import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY, PolicyInputError, classifyTool, costIn, describeOrder, estimateNotional, evaluateOrder, normalizePolicy, priceIn,
  reviewToolFor, warningsIn, type Policy,
} from "../../../../mods/robinhood-trading/policy";
import { parseSse, resultValue } from "../../../../mods/robinhood-trading/mcp";
import { quoteArgs } from "../../../../mods/robinhood-trading/robinhood";

const open: Policy = { ...DEFAULT_POLICY, approval: "never", maxOrderUsd: 500, maxDailyUsd: 1000, maxDailyOrders: 5 };
const none = { orders: 0, usd: 0 };

describe("classifyTool", () => {
  it("sorts Robinhood's tools into read / write / trade / cancel", () => {
    expect(classifyTool("get_portfolio")).toBe("read");
    expect(classifyTool("search")).toBe("read");
    expect(classifyTool("review_equity_order")).toBe("read");
    expect(classifyTool("place_equity_order")).toBe("trade");
    expect(classifyTool("place_option_order")).toBe("trade");
    expect(classifyTool("cancel_equity_order")).toBe("cancel");
    expect(classifyTool("add_to_watchlist")).toBe("write");
    expect(classifyTool("update_watchlist")).toBe("write");
    // Unknown tools never default to read.
    expect(classifyTool("transfer_funds")).toBe("write");
  });

  it("maps an order tool to its dry run", () => {
    expect(reviewToolFor("place_equity_order")).toBe("review_equity_order");
  });
});

describe("describeOrder / estimateNotional", () => {
  it("reads common field names", () => {
    const o = describeOrder("place_equity_order", { symbol: "aapl", side: "BUY", quantity: "2", type: "limit", limit_price: "190.5" });
    expect(o).toMatchObject({ assetClass: "equity", symbol: "AAPL", side: "buy", quantity: 2, price: 190.5, orderType: "limit" });
    expect(estimateNotional(o, null)).toBe(381);
  });

  it("uses a dollar amount as-is and a market price when there's no limit", () => {
    expect(estimateNotional(describeOrder("place_equity_order", { symbol: "SPY", side: "buy", dollar_amount: "25" }), 999)).toBe(25);
    expect(estimateNotional(describeOrder("place_equity_order", { symbol: "SPY", side: "buy", quantity: 3 }), 500)).toBe(1500);
    expect(estimateNotional(describeOrder("place_equity_order", { symbol: "SPY", side: "buy", quantity: 3 }), null)).toBeNull();
  });

  it("prices option contracts at 100 shares", () => {
    const o = describeOrder("place_option_order", { chain_symbol: "AAPL", side: "buy", quantity: 2, price: 1.2 });
    expect(o.assetClass).toBe("option");
    expect(estimateNotional(o, null)).toBe(240);
  });
});

describe("evaluateOrder", () => {
  const buy = describeOrder("place_equity_order", { symbol: "AAPL", side: "buy", dollar_amount: 100 });

  it("allows an order inside every limit when approval is off", () => {
    expect(evaluateOrder(open, buy, 100, none)).toEqual({ outcome: "allow", reasons: [], notionalUsd: 100 });
  });

  it("holds every order under the default policy", () => {
    const v = evaluateOrder(DEFAULT_POLICY, buy, 100, none);
    expect(v.outcome).toBe("approve");
  });

  it("holds an order of unknown size even when approval is off", () => {
    expect(evaluateOrder(open, buy, null, none).outcome).toBe("approve");
  });

  it("holds over the threshold only", () => {
    const p = { ...open, approval: "over_threshold" as const, approvalThresholdUsd: 50 };
    expect(evaluateOrder(p, buy, 40, none).outcome).toBe("allow");
    expect(evaluateOrder(p, buy, 60, none).outcome).toBe("approve");
  });

  it("refuses past the per-order, daily dollar and daily count limits", () => {
    expect(evaluateOrder(open, buy, 501, none).outcome).toBe("deny");
    expect(evaluateOrder(open, buy, 100, { orders: 0, usd: 950 }).reasons[0]).toMatch(/daily limit/);
    expect(evaluateOrder(open, buy, 10, { orders: 5, usd: 0 }).reasons[0]).toMatch(/Daily order limit/);
  });

  it("refusal beats hold: a denied order never reaches the approval queue", () => {
    expect(evaluateOrder({ ...DEFAULT_POLICY, maxOrderUsd: 10 }, buy, 100, none).outcome).toBe("deny");
  });

  it("enforces symbol lists, asset switches and the master switch", () => {
    expect(evaluateOrder({ ...open, allowedSymbols: ["SPY"] }, buy, 10, none).outcome).toBe("deny");
    expect(evaluateOrder({ ...open, blockedSymbols: ["AAPL"] }, buy, 10, none).outcome).toBe("deny");
    expect(evaluateOrder({ ...open, tradingEnabled: false }, buy, 10, none).outcome).toBe("deny");
    const opt = describeOrder("place_option_order", { symbol: "AAPL", side: "buy", quantity: 1, price: 0.5 });
    expect(evaluateOrder(open, opt, 50, none).reasons[0]).toMatch(/Options/);
    expect(evaluateOrder({ ...open, allowOptions: true }, opt, 50, none).outcome).toBe("allow");
    expect(evaluateOrder(open, describeOrder("place_equity_order", { side: "buy", quantity: 1 }), 10, none).reasons[0]).toMatch(/no symbol/);
  });
});

describe("normalizePolicy", () => {
  it("merges an edit and splits symbol strings", () => {
    const p = normalizePolicy({ allowedSymbols: "spy, qqq  aapl", maxOrderUsd: "75.555", approval: "over_threshold" });
    expect(p.allowedSymbols).toEqual(["SPY", "QQQ", "AAPL"]);
    expect(p.maxOrderUsd).toBe(75.56);
    expect(p.approval).toBe("over_threshold");
    expect(p.maxDailyUsd).toBe(DEFAULT_POLICY.maxDailyUsd);
  });

  it("rejects bad values", () => {
    expect(() => normalizePolicy({ approval: "sometimes" })).toThrow(PolicyInputError);
    expect(() => normalizePolicy({ maxOrderUsd: -1 })).toThrow(PolicyInputError);
    expect(() => normalizePolicy({ maxDailyOrders: 1.5 })).toThrow(PolicyInputError);
  });
});

describe("reading Robinhood replies", () => {
  it("finds prices, costs and warnings in nested results", () => {
    const review = { order: { estimated_cost: { amount: "381.00" }, price: "190.5" }, warnings: [{ message: "Market is closed" }, "Pattern day trader"] };
    expect(costIn(review)).toBe(381);
    expect(priceIn({ quotes: [{ symbol: "AAPL", last_trade_price: "190.10" }] })).toBe(190.1);
    expect(warningsIn(review)).toEqual(["Market is closed", "Pattern day trader"]);
  });

  it("builds quote arguments from the tool's schema", () => {
    expect(quoteArgs({ name: "q", inputSchema: { properties: { symbols: { type: "array" } } } }, "AAPL")).toEqual({ symbols: ["AAPL"] });
    expect(quoteArgs({ name: "q", inputSchema: { properties: { symbol: { type: "string" } } } }, "AAPL")).toEqual({ symbol: "AAPL" });
  });

  it("parses an SSE reply and skips other messages", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
    expect(parseSse(body, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(parseSse(body, 8)).toBeNull();
  });

  it("prefers structured content, then JSON text, then text", () => {
    expect(resultValue({ structuredContent: { a: 1 }, content: [{ type: "text", text: "x" }] })).toEqual({ a: 1 });
    expect(resultValue({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
    expect(resultValue({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });
});
