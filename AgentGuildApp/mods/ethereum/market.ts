/**
 * Read-only Ethereum mainnet market data: USD prices from DefiLlama and
 * best-route swap quotes from the KyberSwap aggregator (both keyless).
 * Nothing here signs or builds a swap — a quote is information for the
 * agent to reason with, and paper trades fill against it.
 */
import { getAddress, isAddress } from "viem";
import { DevtoolsInputError, toRaw, toUi } from "./devtools";

const LLAMA = process.env.DEFILLAMA_COINS_URL || "https://coins.llama.fi";
const KYBER = process.env.KYBERSWAP_API_URL || "https://aggregator-api.kyberswap.com";
const TIMEOUT_MS = 10_000;

/** KyberSwap's placeholder for native ETH. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Symbols an agent can use instead of an address. Ethereum mainnet. */
export const SYMBOL_TOKENS: Record<string, string> = {
  ETH: NATIVE,
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC,
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  LDO: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
  PEPE: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  SHIB: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
  STETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
};

const SYMBOL_BY_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym === "STETH" ? "stETH" : sym]),
);

/** A symbol from SYMBOL_TOKENS or a 0x token address (checksummed). */
export function resolveToken(value: string, label = "token"): string {
  const v = String(value ?? "").trim();
  const bySymbol = SYMBOL_TOKENS[v.toUpperCase()];
  if (bySymbol) return bySymbol;
  if (!isAddress(v, { strict: false })) throw new DevtoolsInputError(`${label} must be a symbol (${Object.keys(SYMBOL_TOKENS).slice(0, 6).join(", ")}…) or a 0x token address`);
  return getAddress(v);
}

export const symbolOf = (token: string) => SYMBOL_BY_TOKEN[token.toLowerCase()] ?? null;
const llamaId = (token: string) => `ethereum:${token.toLowerCase() === NATIVE.toLowerCase() ? "0x0000000000000000000000000000000000000000" : token}`;

async function getJson<T>(url: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) as T };
  } catch {
    throw new Error(`${new URL(url).host} returned ${res.status}: ${text.slice(0, 160)}`);
  }
}

export interface TokenPrice {
  token: string;
  symbol: string | null;
  usdPrice: number | null;
  priceChange24hPct: number | null;
  decimals: number | null;
}

/** USD prices for up to 30 tokens (symbols or addresses). Unknown tokens come back with usdPrice null. */
export async function tokenPrices(inputs: string[], fetchImpl: typeof fetch = fetch): Promise<TokenPrice[]> {
  const tokens = [...new Set(inputs.map((t) => resolveToken(t)))];
  if (tokens.length === 0 || tokens.length > 30) throw new DevtoolsInputError("Pass 1–30 tokens");
  const ids = tokens.map(llamaId).join(",");
  const [prices, changes] = await Promise.all([
    getJson<{ coins: Record<string, { price?: number; symbol?: string; decimals?: number }> }>(`${LLAMA}/prices/current/${ids}?searchWidth=4h`, fetchImpl),
    getJson<{ coins: Record<string, number> }>(`${LLAMA}/percentage/${ids}`, fetchImpl).catch(() => ({ status: 0, data: { coins: {} as Record<string, number> } })),
  ]);
  if (prices.status >= 400) throw new Error(`DefiLlama ${prices.status}`);
  return tokens.map((token) => {
    const row = prices.data.coins?.[llamaId(token)];
    const change = changes.data.coins?.[llamaId(token)];
    return {
      token,
      symbol: symbolOf(token) ?? row?.symbol ?? null,
      usdPrice: typeof row?.price === "number" ? row.price : null,
      priceChange24hPct: typeof change === "number" ? change : null,
      decimals: token === NATIVE ? 18 : typeof row?.decimals === "number" ? row.decimals : null,
    };
  });
}

export interface SwapQuote {
  inputToken: string;
  outputToken: string;
  inAmount: string;
  outAmount: string;
  /** Worst case after slippage. */
  minOutAmount: string;
  inUi: string;
  outUi: string;
  minOutUi: string;
  /** Output per one unit of input, in UI units. */
  rate: number;
  /** (in USD − out USD) / in USD, from KyberSwap's own valuations. */
  priceImpactPct: number;
  slippageBps: number;
  usdValue: number | null;
  /** What the swap would cost in gas on mainnet right now. */
  gasUsd: number | null;
  route: string[];
  inDecimals: number;
  outDecimals: number;
  inSymbol: string | null;
  outSymbol: string | null;
}

interface KyberRoute {
  code: number;
  message: string;
  data?: {
    routeSummary: {
      amountIn: string; amountInUsd: string; amountOut: string; amountOutUsd: string; gasUsd: string;
      route: { exchange: string }[][];
    };
  };
}

/**
 * Best-route quote for swapping `amount` (UI units of the input token) on
 * Ethereum mainnet. Decimals come from DefiLlama, so any listed token works.
 */
export async function swapQuote(
  params: { inputToken: string; outputToken: string; amount: string | number; slippageBps?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<SwapQuote> {
  const inputToken = resolveToken(params.inputToken, "inputToken");
  const outputToken = resolveToken(params.outputToken, "outputToken");
  if (inputToken === outputToken) throw new DevtoolsInputError("inputToken and outputToken are the same token");
  const slippageBps = params.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) throw new DevtoolsInputError("slippageBps must be an integer 1–1000");

  const [inInfo, outInfo] = await tokenPrices([inputToken, outputToken], fetchImpl);
  if (inInfo.decimals == null || outInfo.decimals == null) {
    throw new DevtoolsInputError(`No price listing for ${inInfo.decimals == null ? inputToken : outputToken} — is it an Ethereum mainnet ERC-20?`);
  }
  const raw = toRaw(params.amount, inInfo.decimals);

  const qs = new URLSearchParams({ tokenIn: inputToken, tokenOut: outputToken, amountIn: raw.toString() });
  const { status, data } = await getJson<KyberRoute>(`${KYBER}/ethereum/api/v1/routes?${qs}`, fetchImpl, { headers: { "x-client-id": "agent-guild" } });
  if (status >= 500) throw new Error(`KyberSwap ${status}: ${data.message}`);
  if (data.code !== 0 || !data.data) throw new DevtoolsInputError(`KyberSwap: ${data.message || "no route"}`);
  const s = data.data.routeSummary;

  const out = BigInt(s.amountOut);
  const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  const inUi = toUi(s.amountIn, inInfo.decimals);
  const outUi = toUi(s.amountOut, outInfo.decimals);
  const inUsd = Number(s.amountInUsd);
  const outUsd = Number(s.amountOutUsd);
  return {
    inputToken, outputToken,
    inAmount: s.amountIn, outAmount: s.amountOut, minOutAmount: minOut.toString(),
    inUi, outUi, minOutUi: toUi(minOut, outInfo.decimals),
    rate: Number(outUi) / Number(inUi),
    priceImpactPct: inUsd > 0 && outUsd > 0 ? Math.max(((inUsd - outUsd) / inUsd) * 100, 0) : 0,
    slippageBps,
    usdValue: inUsd > 0 ? inUsd : inInfo.usdPrice != null ? Number(inUi) * inInfo.usdPrice : null,
    gasUsd: Number.isFinite(Number(s.gasUsd)) ? Number(s.gasUsd) : null,
    route: [...new Set(s.route.flat().map((h) => h.exchange))],
    inDecimals: inInfo.decimals, outDecimals: outInfo.decimals,
    inSymbol: inInfo.symbol, outSymbol: outInfo.symbol,
  };
}
