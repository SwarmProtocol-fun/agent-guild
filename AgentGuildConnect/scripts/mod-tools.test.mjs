import test from "node:test";
import assert from "node:assert/strict";
import { buildToolRequest, checkModId, formatToolList } from "./mod-tools.mjs";

const markets = { name: "polymarket_markets", method: "GET", path: "markets", input_schema: { properties: { q: {} } } };
const account = { name: "polymarket_account", method: "GET", path: "account/{agentId}", input_schema: { properties: {} } };
const order = {
  name: "polymarket_order", method: "POST", path: "order",
  input_schema: { properties: { conditionId: {}, outcomeIndex: {}, side: {}, usd: {} }, required: ["conditionId", "outcomeIndex", "side"] },
};
const toggle = { name: "polymarket_bot_toggle", method: "POST", path: "bots/{id}/toggle", input_schema: { properties: { id: {}, enabled: {} } } };

test("GET leftovers go to the query string", () => {
  assert.deepEqual(buildToolRequest(markets, { q: "bitcoin" }, "a1"), { method: "GET", path: "markets", query: { q: "bitcoin" }, body: undefined });
  assert.deepEqual(buildToolRequest(markets, {}, "a1").query, {});
});

test("{agentId} comes from this agent, not the input", () => {
  assert.equal(buildToolRequest(account, { agentId: "someone-else" }, "me 1").path, "account/me%201");
});

test("POST leftovers go to the body; path params are removed from it", () => {
  const order1 = buildToolRequest(order, { conditionId: "0xabc", outcomeIndex: 0, side: "buy", usd: 10 }, "a1");
  assert.deepEqual(order1, { method: "POST", path: "order", query: {}, body: { conditionId: "0xabc", outcomeIndex: 0, side: "buy", usd: 10 } });
  const t = buildToolRequest(toggle, { id: "b/../x", enabled: false }, "a1");
  assert.equal(t.path, "bots/b%2F..%2Fx/toggle");
  assert.deepEqual(t.body, { enabled: false });
});

test("missing path param and bad input are refused", () => {
  assert.throws(() => buildToolRequest(toggle, { enabled: true }, "a1"), /needs id/);
  assert.throws(() => buildToolRequest(markets, [], "a1"), /JSON object/);
  assert.throws(() => buildToolRequest({ ...markets, method: "DELETE" }, {}, "a1"), /unsupported method/);
});

test("mod ids can't escape /api/mods/<mod>", () => {
  assert.equal(checkModId("polymarket-trading"), "polymarket-trading");
  for (const bad of ["../v1", "Polymarket", "a/b", "", undefined]) assert.throws(() => checkModId(bad));
});

test("tool list marks optional args", () => {
  const text = formatToolList("polymarket-trading", [order, markets]);
  assert.match(text, /polymarket_order\(conditionId, outcomeIndex, side, usd\?\)  POST order/);
  assert.match(text, /polymarket_markets\(q\?\)  GET markets/);
  assert.equal(formatToolList("x", []), "x: no agent tools");
});
