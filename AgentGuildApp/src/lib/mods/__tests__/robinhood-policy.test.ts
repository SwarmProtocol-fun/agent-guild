import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLICY, PolicyInputError, classifyTool, costIn, describeOrder, estimateNotional, evaluateOrder, findAgenticAccounts, maskAccountNumbers, normalizePolicy, priceIn, riskIn,
  reviewToolFor, shapeOrder, warningsIn, type Policy,
} from "../../../../mods/robinhood-trading/policy";
import { PROTOCOL_VERSION, parseSse, resultValue } from "../../../../mods/robinhood-trading/mcp";
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
    expect(classifyTool("preview_crypto_order")).toBe("read");
    expect(classifyTool("exercise_option")).toBe("trade");
    expect(classifyTool("cancel_equity_order")).toBe("cancel");
    expect(classifyTool("add_to_watchlist")).toBe("write");
    expect(classifyTool("update_watchlist")).toBe("write");
    // Unknown tools never default to read.
    expect(classifyTool("transfer_funds")).toBe("write");
  });

  it("maps an order tool to its dry run and leaves exercise alone", () => {
    expect(reviewToolFor("place_equity_order")).toBe("review_equity_order");
    expect(reviewToolFor("place_option_order")).toBe("review_option_order");
    expect(reviewToolFor("place_crypto_order")).toBe("preview_crypto_order");
    expect(reviewToolFor("exercise_option")).toBe("");
    expect(PROTOCOL_VERSION).toBe("2025-11-25");
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

  it("prices a long option at 100 shares and a debit spread at the premium", () => {
    const o = describeOrder("place_option_order", { chain_symbol: "AAPL", side: "buy", quantity: 2, price: 1.2 });
    expect(o.assetClass).toBe("option");
    expect(estimateNotional(o, null)).toBe(240);
    const debit = describeOrder("place_option_order", {
      chain_symbol: "HOOD", direction: "debit", quantity: 8, price: 2.55, type: "limit",
      legs: [
        { option_id: "a", side: "buy", position_effect: "open" },
        { option_id: "b", side: "sell", position_effect: "open" },
      ],
    });
    expect(estimateNotional(debit, 999)).toBe(2040);
  });

  it("does not treat a credit or a short option as if the premium were the risk", () => {
    const credit = describeOrder("place_option_order", {
      chain_symbol: "HOOD", direction: "credit", quantity: 5, price: 1.2,
      legs: [
        { option_id: "a", side: "sell", position_effect: "open" },
        { option_id: "b", side: "buy", position_effect: "open" },
      ],
    });
    expect(estimateNotional(credit, null)).toBeNull();
    expect(evaluateOrder(open, credit, null, none).outcome).toBe("approve");
    const naked = describeOrder("place_option_order", {
      chain_symbol: "HOOD", quantity: 1, price: 1.5,
      legs: [{ option_id: "a", side: "sell", position_effect: "open" }],
    });
    expect(estimateNotional(naked, null)).toBeNull();
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
    expect(evaluateOrder({ ...open, allowOptions: false }, opt, 50, none).reasons[0]).toMatch(/Options/);
    expect(evaluateOrder(open, opt, 50, none).outcome).toBe("allow");
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
    expect(riskIn({ order: { collateral: { amount: "1900.00" }, estimated_cost: { amount: "600" } } })).toBe(1900);
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

const LEGS = [
  { option_id: "11111111-1111-4111-8111-111111111111", side: "buy", position_effect: "open" },
  { option_id: "22222222-2222-4222-8222-222222222222", side: "sell", position_effect: "open" },
];

describe("shapeOrder", () => {
  it("keeps chain_symbol on the review and ref_id on the place", () => {
    const shaped = shapeOrder("place_option_order", {
      chain_symbol: "hood", quantity: 8, price: "2.55", direction: "debit",
      legs: LEGS, ref_id: "33333333-3333-4333-8333-333333333333", extra: "nope",
    });
    expect(shaped.issues).toEqual([]);
    expect(shaped.reviewArgs).toMatchObject({ chain_symbol: "HOOD", underlying_type: "equity", direction: "debit", type: "limit", quantity: "8" });
    expect(shaped.reviewArgs).not.toHaveProperty("ref_id");
    expect(shaped.reviewArgs).not.toHaveProperty("extra");
    expect(shaped.placeArgs).not.toHaveProperty("chain_symbol");
    expect(shaped.placeArgs).not.toHaveProperty("underlying_type");
    expect(shaped.placeArgs.ref_id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("rejects an option market order before it can be sent", () => {
    const shaped = shapeOrder("place_option_order", { quantity: 1, type: "market", legs: [LEGS[0]] });
    expect(shaped.issues.join(" ")).toMatch(/limit/);
  });

  it("finds the agentic account and masks the number", () => {
    const accounts = findAgenticAccounts({ results: [{ account_number: "00008451", agentic_allowed: false }, { account_number: "00006632", agentic_allowed: true, option_level: "option_level_3" }] });
    expect(accounts.map((a) => a.accountNumber)).toEqual(["00006632"]);
    expect(maskAccountNumbers({ account_number: "00006632", legs: LEGS })).toMatchObject({ account_number: "••••6632" });
  });
});
