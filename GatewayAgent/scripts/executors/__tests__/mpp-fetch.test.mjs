/**
 * Tests for the mpp-fetch executor's safety-critical path: a payment cap
 * must never be bypassed. `mppx`/`viem` are devDependencies here (see
 * package.json) purely to test against the real packages — the published
 * gateway-agent package stays zero-dependency; consumers install `mppx`
 * and `viem` themselves only if they use the "mpp-fetch" task type.
 *
 * Run with: npm test (node --test)
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo as tempoServer } from "mppx/server";
import { execute } from "../mpp-fetch.mjs";

const RECIPIENT = privateKeyToAccount(`0x${"2".repeat(64)}`).address;
const CLIENT_KEY = `0x${"1".repeat(64)}`;
const CURRENCY = "0x20c0000000000000000000000000000000000001";
const CHALLENGE_AMOUNT_USDC = "5"; // every fake server below demands 5 USDC

let server;
let port;

before(async () => {
  const payment = Mppx.create({
    methods: [tempoServer.charge({ testnet: true })],
    secretKey: "x".repeat(32),
  });

  server = createServer(async (req, res) => {
    const request = new Request(`http://localhost${req.url}`, { method: req.method });
    const result = await payment.charge({
      amount: CHALLENGE_AMOUNT_USDC,
      currency: CURRENCY,
      decimals: 6,
      recipient: RECIPIENT,
    })(request);

    if (result.status === 402) {
      const challenge = result.challenge;
      res.writeHead(challenge.status, Object.fromEntries(challenge.headers.entries()));
      res.end(await challenge.text());
      return;
    }
    res.writeHead(200);
    res.end("paid!");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

after(() => server.close());

beforeEach(() => {
  process.env.TEMPO_MPP_CLIENT_PRIVATE_KEY = CLIENT_KEY;
  delete process.env.TEMPO_USDC_ADDRESS;
});

test("rejects a task missing 'url'", async () => {
  await assert.rejects(() => execute({ payload: { maxAmountUsdc: 1 } }, () => {}), /missing 'url'/);
});

test("rejects a task missing 'maxAmountUsdc'", async () => {
  await assert.rejects(() => execute({ payload: { url: "http://x" } }, () => {}), /maxAmountUsdc/);
});

test("rejects when TEMPO_MPP_CLIENT_PRIVATE_KEY is not configured", async () => {
  delete process.env.TEMPO_MPP_CLIENT_PRIVATE_KEY;
  await assert.rejects(
    () => execute({ payload: { url: "http://x", maxAmountUsdc: 1 } }, () => {}),
    /TEMPO_MPP_CLIENT_PRIVATE_KEY/,
  );
});

test("declines a challenge above maxAmountUsdc and never pays", async () => {
  const logs = [];
  const result = await execute(
    { payload: { url: `http://localhost:${port}/resource`, maxAmountUsdc: 0.01 } }, // cap << the 5 USDC challenge
    (lines) => logs.push(...lines),
  );

  assert.equal(result.data.status, 402, "must stay declined, not silently succeed or pay");
  assert.ok(logs.some((l) => l.includes("declined")), "must log the decline decision");
  assert.ok(!logs.some((l) => l.includes("within cap")), "must never cross into the pay branch");
});

test("attempts payment when the challenge is within maxAmountUsdc", async () => {
  const logs = [];
  await execute(
    { payload: { url: `http://localhost:${port}/resource`, maxAmountUsdc: 10 } }, // cap > the 5 USDC challenge
    (lines) => logs.push(...lines),
  );

  assert.ok(!logs.some((l) => l.includes("declined")), "must not decline a challenge within budget");
});

test("declines when allowedCurrency doesn't match the challenge's currency", async () => {
  const logs = [];
  const result = await execute(
    {
      payload: {
        url: `http://localhost:${port}/resource`,
        maxAmountUsdc: 10, // plenty of budget
        allowedCurrency: "0x20c0000000000000000000000000000000009999", // wrong token
      },
    },
    (lines) => logs.push(...lines),
  );

  assert.equal(result.data.status, 402);
  assert.ok(logs.some((l) => l.includes("does not match expected")));
});
