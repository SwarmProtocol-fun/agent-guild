/**
 * Read-only mainnet market data from Jupiter: USD prices and swap quotes.
 * Nothing here signs or builds a swap — agent wallets only sign on
 * devnet/testnet (agent.ts), and Jupiter only routes on mainnet, so a quote
 * is information for the agent to reason with, not an order.
 */
import { DevtoolsInputError, KNOWN_MINTS, parsePubkey } from "./devtools";

const JUP = process.env.JUPITER_API_URL || "https://lite-api.jup.ag";
const TIMEOUT_MS = 10_000;

/** Symbols an agent can use instead of a mint address. Mainnet mints. */
export const SYMBOL_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};

const SYMBOL_BY_MINT: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_MINTS).filter(([sym]) => sym !== "WSOL").map(([sym, mint]) => [mint, sym]),
);

/** A symbol from SYMBOL_MINTS or a base58 mint address. */
export function resolveMint(value: string, label = "mint"): string {
  const v = value.trim();
  const bySymbol = SYMBOL_MINTS[v.toUpperCase()];
  if (bySymbol) return bySymbol;
  return parsePubkey(v, label).toBase58();
}

async function jup<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${JUP}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Jupiter returned ${res.status}: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const msg = (data as { error?: string; errorCode?: string })?.error ?? text.slice(0, 160);
    // 400s are about the request (no route, bad mint) — the agent can fix those.
    if (res.status >= 400 && res.status < 500) throw new DevtoolsInputError(`Jupiter: ${msg}`);
    throw new Error(`Jupiter ${res.status}: ${msg}`);
  }
  return data as T;
}

export interface TokenPrice {
  mint: string;
  symbol: string | null;
  usdPrice: number | null;
  priceChange24hPct: number | null;
  decimals: number | null;
}

/** USD prices for up to 20 mints (or symbols). Unknown mints come back with usdPrice null. */
export async function tokenPrices(inputs: string[], fetchImpl?: typeof fetch): Promise<TokenPrice[]> {
  const mints = [...new Set(inputs.map((m) => resolveMint(m)))];
  if (mints.length === 0 || mints.length > 20) throw new DevtoolsInputError("Pass 1–20 mints");
  const data = await jup<Record<string, { usdPrice?: number; priceChange24h?: number; decimals?: number } | null>>(
    `/price/v3?ids=${mints.join(",")}`, fetchImpl);
  return mints.map((mint) => {
    const row = data[mint];
    return {
      mint,
      symbol: SYMBOL_BY_MINT[mint] ?? KNOWN_MINTS[mint] ?? null,
      usdPrice: typeof row?.usdPrice === "number" ? row.usdPrice : null,
      priceChange24hPct: typeof row?.priceChange24h === "number" ? row.priceChange24h : null,
      decimals: typeof row?.decimals === "number" ? row.decimals : null,
    };
  });
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Worst case after slippage. */
  minOutAmount: string;
  inUi: string;
  outUi: string;
  minOutUi: string;
  /** Output per one unit of input, in UI units. */
  rate: number;
  priceImpactPct: number;
  slippageBps: number;
  usdValue: number | null;
  route: string[];
}

/** Base units → decimal string without float rounding. */
export function toUi(raw: string, decimals: number): string {
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Decimal string → base units without float rounding. */
export function toRaw(ui: string | number, decimals: number, label = "amount"): bigint {
  const s = String(ui).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new DevtoolsInputError(`${label} must be a positive decimal number`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new DevtoolsInputError(`${label} has more than ${decimals} decimals`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new DevtoolsInputError(`${label} must be greater than 0`);
  return raw;
}

/**
 * Best-route quote for swapping `amount` (UI units of the input token) on
 * mainnet. Decimals come from Jupiter's price feed, so any listed token works.
 */
export async function swapQuote(
  params: { inputMint: string; outputMint: string; amount: string | number; slippageBps?: number },
  fetchImpl?: typeof fetch,
): Promise<SwapQuote> {
  const inputMint = resolveMint(params.inputMint, "inputMint");
  const outputMint = resolveMint(params.outputMint, "outputMint");
  if (inputMint === outputMint) throw new DevtoolsInputError("inputMint and outputMint are the same token");
  const slippageBps = params.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) throw new DevtoolsInputError("slippageBps must be an integer 1–1000");

  const [inInfo, outInfo] = await tokenPrices([inputMint, outputMint], fetchImpl);
  if (inInfo.decimals == null || outInfo.decimals == null) {
    throw new DevtoolsInputError(`Jupiter has no listing for ${inInfo.decimals == null ? inputMint : outputMint}`);
  }
  const raw = toRaw(params.amount, inInfo.decimals);

  const q = await jup<{
    inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct: string;
    swapUsdValue?: string; routePlan?: { swapInfo?: { label?: string } }[];
  }>(`/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&slippageBps=${slippageBps}`, fetchImpl);

  const inUi = toUi(q.inAmount, inInfo.decimals);
  const outUi = toUi(q.outAmount, outInfo.decimals);
  return {
    inputMint, outputMint,
    inAmount: q.inAmount, outAmount: q.outAmount, minOutAmount: q.otherAmountThreshold,
    inUi, outUi, minOutUi: toUi(q.otherAmountThreshold, outInfo.decimals),
    rate: Number(outUi) / Number(inUi),
    priceImpactPct: Number(q.priceImpactPct) * 100,
    slippageBps,
    usdValue: q.swapUsdValue != null ? Number(q.swapUsdValue) : null,
    route: (q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
  };
}
