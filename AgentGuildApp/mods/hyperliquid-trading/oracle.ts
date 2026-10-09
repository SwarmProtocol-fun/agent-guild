/**
 * Hyperliquid oracle prices, two ways:
 *
 * - On-chain: HyperEVM's read precompile at 0x…0807 returns HyperCore's
 *   perp oracle price for an asset index, as of the latest L1 state when the
 *   EVM block was built. Raw value is scaled by 10^(6 − szDecimals).
 * - WebSocket: the `activeAssetCtx` subscription pushes oraclePx, markPx and
 *   midPx for one coin roughly every second.
 *
 * Validators only publish a new oracle price every ~3s, so neither source
 * can be fresher than that; markPx/midPx move faster.
 *
 * Shared by server.ts and client.tsx — no Node-only imports.
 */

export type HlNetwork = "testnet" | "mainnet";

export const ORACLE_PX_PRECOMPILE = "0x0000000000000000000000000000000000000807";

export function hlEvmRpcUrl(network: HlNetwork): string {
  return network === "mainnet"
    ? process.env.HYPERLIQUID_EVM_RPC_MAINNET || "https://rpc.hyperliquid.xyz/evm"
    : process.env.HYPERLIQUID_EVM_RPC_TESTNET || "https://rpc.hyperliquid-testnet.xyz/evm";
}

export function hlWsUrl(network: HlNetwork): string {
  return network === "mainnet" ? "wss://api.hyperliquid.xyz/ws" : "wss://api.hyperliquid-testnet.xyz/ws";
}

/** ABI-encodes a perp asset index as the precompile's single uint32 argument. */
export function encodeOracleCall(assetIndex: number): string {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`Invalid asset index: ${assetIndex}`);
  return "0x" + assetIndex.toString(16).padStart(64, "0");
}

/** Decodes the precompile's uint64 return into a human price for a perp with `szDecimals`. */
export function decodeOraclePx(result: string, szDecimals: number): number {
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error("Empty or malformed precompile result");
  const raw = Number(BigInt("0x" + hex));
  return raw / 10 ** (6 - szDecimals);
}

export interface PerpAssetMeta {
  index: number;
  szDecimals: number;
}

/** Finds a coin's asset index (its position in `meta.universe`) and szDecimals. */
export function findPerpAsset(universe: { name: string; szDecimals: number }[], coin: string): PerpAssetMeta | null {
  const index = universe.findIndex((a) => a.name.toUpperCase() === coin.toUpperCase());
  return index === -1 ? null : { index, szDecimals: universe[index].szDecimals };
}

/** Reads one perp's oracle price from the HyperEVM precompile via eth_call. */
export async function readOraclePxOnchain(
  asset: PerpAssetMeta,
  network: HlNetwork,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const resp = await fetchFn(hlEvmRpcUrl(network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: ORACLE_PX_PRECOMPILE, data: encodeOracleCall(asset.index) }, "latest"],
    }),
  });
  if (!resp.ok) throw new Error(`HyperEVM RPC failed: ${resp.status}`);
  const body = (await resp.json()) as { result?: string; error?: { message?: string } };
  if (body.error || !body.result) throw new Error(`Oracle precompile error: ${body.error?.message ?? "no result"}`);
  const px = decodeOraclePx(body.result, asset.szDecimals);
  if (!(px > 0)) throw new Error("Oracle precompile returned zero");
  return px;
}

export interface LiveAssetPx {
  coin: string;
  oraclePx: number | null;
  markPx: number | null;
  midPx: number | null;
}

export function activeAssetCtxSubscription(coin: string, method: "subscribe" | "unsubscribe" = "subscribe") {
  return { method, subscription: { type: "activeAssetCtx", coin } };
}

/** Parses an `activeAssetCtx` WebSocket message; anything else (acks, pongs, spot ctxs) returns null. */
export function parseActiveAssetCtx(message: unknown): LiveAssetPx | null {
  const msg = message as { channel?: string; data?: { coin?: string; ctx?: Record<string, unknown> } };
  if (msg?.channel !== "activeAssetCtx" || !msg.data?.coin || !msg.data.ctx) return null;
  const num = (v: unknown) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n > 0 ? n : null;
  };
  const { ctx } = msg.data;
  return { coin: msg.data.coin, oraclePx: num(ctx.oraclePx), markPx: num(ctx.markPx), midPx: num(ctx.midPx) };
}
