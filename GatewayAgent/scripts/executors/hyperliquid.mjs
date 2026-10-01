/**
 * Hyperliquid Executor — Places orders via the official Python SDK, run as a
 * direct subprocess of the GatewayAgent worker. There is no official
 * TypeScript SDK — Hyperliquid's exchange API uses a custom msgpack + EIP-712
 * signing scheme that's easy to get subtly wrong reimplemented from scratch,
 * so this wraps the reference Python implementation instead of hand-rolling
 * request signing.
 *
 * Runs as a plain subprocess (not a nested Docker container) so this worker
 * can be deployed to PaaS hosts like Railway that don't expose a Docker
 * socket. The command itself is fixed (`python3 place_order.py <flags>`,
 * built from numeric/enum fields only — see below) rather than
 * attacker-supplied, so the process-level isolation Docker would otherwise
 * provide isn't needed here the way it is for the generic "docker"/"shell"
 * task types. The worker's image must have `python3` and
 * `hyperliquid-python-sdk` installed and this file's sibling
 * `place_order.py` present (see docker/railway/Dockerfile for a combined
 * Node+Python worker image).
 *
 * There is no shared worker-level trading key — every agent brings its own
 * Hyperliquid wallet (see the hyperliquid-trading mod's POST /wallet and
 * the zero-knowledge note in hyperliquid-store.ts), so `payload.privateKey`
 * and `payload.network` are this specific task's agent's own decrypted key,
 * supplied fresh by the mod for this one trade — never a static secret this
 * worker holds across tasks. HYPERLIQUID_PRIVATE_KEY/HYPERLIQUID_NETWORK env
 * vars are only a fallback for local testing (e.g. `gateway-agent run
 * hyperliquid '{...}'` without going through the mod).
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running, pid?, progress? }
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute as shellExecute, cancel as shellCancel, getStatus as shellGetStatus } from "./shell.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACE_ORDER_SCRIPT = process.env.HYPERLIQUID_SCRIPT_PATH || join(__dirname, "../../docker/hyperliquid/place_order.py");
const PYTHON_BIN = process.env.HYPERLIQUID_PYTHON_BIN || "python3";

/**
 * Payload fields:
 *   agentId: string
 *   coin: string        — e.g. "ETH"
 *   isBuy: boolean
 *   sizeUsd: number
 *   privateKey: string  — this agent's own Hyperliquid key, decrypted
 *                         server-side for this one task (see file header);
 *                         falls back to HYPERLIQUID_PRIVATE_KEY for local testing
 *   network?: "testnet" | "mainnet" — falls back to HYPERLIQUID_NETWORK, then "testnet"
 *   orderType: "market" | "limit" (default "market")
 *   limitPrice?: number — required if orderType is "limit"
 *   reduceOnly?: boolean — set when closing/reducing a position (see mod's POST /close)
 *   leverage?: number — sets account leverage for the coin before ordering
 *   stopLossPct?: number — attaches a reduce-only stop-loss trigger this % through the fill
 *   takeProfitPct?: number — attaches a reduce-only take-profit trigger this % through the fill
 */
export async function execute(task, logCallback) {
  const { payload, timeoutMs = 30000 } = task;
  const {
    agentId, coin, isBuy, sizeUsd, privateKey, network, orderType = "market", limitPrice, reduceOnly = false,
    leverage, stopLossPct, takeProfitPct,
  } = payload;

  if (!coin || isBuy == null || !sizeUsd) {
    throw new Error("Hyperliquid task missing 'coin', 'isBuy', or 'sizeUsd' in payload");
  }
  const resolvedKey = privateKey || process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!resolvedKey) {
    throw new Error("Hyperliquid task missing 'privateKey' in payload (and no HYPERLIQUID_PRIVATE_KEY fallback set)");
  }

  const shellTask = {
    payload: {
      command: PYTHON_BIN,
      args: [
        PLACE_ORDER_SCRIPT,
        "--coin", coin,
        "--side", isBuy ? "buy" : "sell",
        "--size-usd", String(sizeUsd),
        "--order-type", orderType,
        ...(limitPrice ? ["--limit-price", String(limitPrice)] : []),
        ...(reduceOnly ? ["--reduce-only"] : []),
        ...(leverage ? ["--leverage", String(leverage)] : []),
        ...(stopLossPct ? ["--stop-loss-pct", String(stopLossPct)] : []),
        ...(takeProfitPct ? ["--take-profit-pct", String(takeProfitPct)] : []),
      ],
      shell: false, // argv built from numeric/enum fields above — no shell interpolation needed
      env: {
        HYPERLIQUID_PRIVATE_KEY: resolvedKey,
        HYPERLIQUID_NETWORK: network || process.env.HYPERLIQUID_NETWORK || "testnet",
      },
    },
    timeoutMs,
  };

  const result = await shellExecute(shellTask, logCallback);
  const stdout = result.data?.stdout ?? "";
  const stderr = result.data?.stderr ?? "";

  // place_order.py prints a single JSON line on success: {fillPrice, sz, oid, ...}
  let fill = null;
  try {
    const lastLine = stdout.trim().split("\n").pop();
    fill = JSON.parse(lastLine);
  } catch {
    // Non-JSON output — surface raw stdout/stderr, exit code still governs success
  }

  return {
    data: { agentId, coin, isBuy, sizeUsd, fill, stdout, stderr },
    artifacts: [],
    executionTimeMs: result.executionTimeMs ?? 0,
    exitCode: result.exitCode,
  };
}

export const cancel = shellCancel;
export const getStatus = shellGetStatus;
