/**
 * Hyperliquid Executor — Places orders via the official Python SDK, run
 * inside a Docker container (same isolation model as the "docker" task
 * type). There is no official TypeScript SDK — Hyperliquid's exchange API
 * uses a custom msgpack + EIP-712 signing scheme that's easy to get subtly
 * wrong reimplemented from scratch, so this wraps the reference Python
 * implementation instead of hand-rolling request signing.
 *
 * Requires an `agent-guild-hyperliquid` image with `hyperliquid-python-sdk`
 * installed (see docker/hyperliquid/Dockerfile) and HYPERLIQUID_PRIVATE_KEY
 * available to the worker.
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running, pid?, progress? }
 */

import { execute as dockerExecute, cancel as dockerCancel, getStatus as dockerGetStatus } from "./docker.mjs";

const IMAGE = process.env.HYPERLIQUID_IMAGE || "agent-guild-hyperliquid:latest";

/**
 * Payload fields:
 *   agentId: string
 *   coin: string        — e.g. "ETH"
 *   isBuy: boolean
 *   sizeUsd: number
 *   orderType: "market" | "limit" (default "market")
 *   limitPrice?: number — required if orderType is "limit"
 *   reduceOnly?: boolean — set when closing/reducing a position (see mod's POST /close)
 */
export async function execute(task, logCallback) {
  const { payload, timeoutMs = 30000 } = task;
  const { agentId, coin, isBuy, sizeUsd, orderType = "market", limitPrice, reduceOnly = false } = payload;

  if (!coin || isBuy == null || !sizeUsd) {
    throw new Error("Hyperliquid task missing 'coin', 'isBuy', or 'sizeUsd' in payload");
  }

  // Image's ENTRYPOINT is already ["python", "place_order.py"] — only the
  // argparse flags go in `command` (see docker/hyperliquid/Dockerfile).
  const dockerTask = {
    payload: {
      image: IMAGE,
      command: [
        "--coin", coin,
        "--side", isBuy ? "buy" : "sell",
        "--size-usd", String(sizeUsd),
        "--order-type", orderType,
        ...(limitPrice ? ["--limit-price", String(limitPrice)] : []),
        ...(reduceOnly ? ["--reduce-only"] : []),
      ],
      envVars: {
        HYPERLIQUID_PRIVATE_KEY: process.env.HYPERLIQUID_PRIVATE_KEY || "",
        HYPERLIQUID_NETWORK: process.env.HYPERLIQUID_NETWORK || "testnet",
      },
      networkMode: "bridge", // needs outbound access to api.hyperliquid.xyz
    },
    timeoutMs,
  };

  const result = await dockerExecute(dockerTask, logCallback);
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

export const cancel = dockerCancel;
export const getStatus = dockerGetStatus;
