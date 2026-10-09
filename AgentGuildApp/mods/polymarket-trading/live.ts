/**
 * Live trading on Polymarket's international CLOB (V2), signed in-process by
 * the agent's own platform-held EVM wallet acting as a plain EOA
 * (signature type 0). Collateral is pUSD on Polygon; the wallet also needs a
 * little POL for the one-time approval transactions.
 *
 * Polymarket geoblocks order placement in some regions (the US among them).
 * Every live order first asks Polymarket's own geoblock endpoint and refuses
 * if this server is blocked; there is deliberately no way around that here.
 */

import { ClobClient, Chain, OrderType, Side, type OrderResponse, type TickSize } from "@polymarket/clob-client-v2";
import { createPublicClient, createWalletClient, http, parseAbi, maxUint256, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { CLOB_URL } from "./markets";

// Polygon mainnet, from docs.polymarket.com/resources/contracts (CLOB V2).
export const CONTRACTS = {
  pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  positionManager: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  exchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
  exchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
} as const satisfies Record<string, Address>;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ERC1155 = parseAbi([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

/** What an EOA must approve once before the exchanges can settle its trades. */
export const APPROVALS: { label: string; kind: "erc20" | "erc1155"; token: Address; spender: Address }[] = [
  { label: "pUSD → CTF Exchange", kind: "erc20", token: CONTRACTS.pUSD, spender: CONTRACTS.exchange },
  { label: "pUSD → Neg Risk Exchange", kind: "erc20", token: CONTRACTS.pUSD, spender: CONTRACTS.negRiskExchange },
  { label: "pUSD → Exchange V3", kind: "erc20", token: CONTRACTS.pUSD, spender: CONTRACTS.exchangeV3 },
  { label: "Outcome tokens → CTF Exchange", kind: "erc1155", token: CONTRACTS.ctf, spender: CONTRACTS.exchange },
  { label: "Outcome tokens → Neg Risk Exchange", kind: "erc1155", token: CONTRACTS.ctf, spender: CONTRACTS.negRiskExchange },
  { label: "V2 positions → Exchange V3", kind: "erc1155", token: CONTRACTS.positionManager, spender: CONTRACTS.exchangeV3 },
];

function rpcUrl(): string {
  return process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
}

function publicClient() {
  return createPublicClient({ chain: polygon, transport: http(rpcUrl()) });
}

// ── Geoblock ────────────────────────────────────────────────────────────────

export interface GeoStatus {
  blocked: boolean;
  country: string | null;
  region: string | null;
}

const GEO_TTL_MS = 10 * 60_000;
let geoCache: { at: number; status: GeoStatus } | null = null;

/** Whether Polymarket blocks order placement from this server's IP. Fails closed. */
export async function checkGeoblock(fetchImpl: typeof fetch = fetch): Promise<GeoStatus> {
  if (geoCache && Date.now() - geoCache.at < GEO_TTL_MS) return geoCache.status;
  let status: GeoStatus;
  try {
    const resp = await fetchImpl("https://polymarket.com/api/geoblock", { cache: "no-store" });
    const data = (await resp.json()) as { blocked?: boolean; country?: string; region?: string };
    status = { blocked: data.blocked !== false, country: data.country ?? null, region: data.region ?? null };
  } catch {
    // Can't tell, so don't trade.
    status = { blocked: true, country: null, region: null };
  }
  geoCache = { at: Date.now(), status };
  return status;
}

export function resetGeoCache(): void {
  geoCache = null;
}

// ── Wallet state ────────────────────────────────────────────────────────────

export interface LiveWalletState {
  address: string;
  pusd: number;
  pol: number;
  approvals: { label: string; ok: boolean }[];
  ready: boolean;
}

async function approvalOk(client: ReturnType<typeof publicClient>, owner: Address, a: (typeof APPROVALS)[number]): Promise<boolean> {
  if (a.kind === "erc20") {
    const allowance = await client.readContract({ address: a.token, abi: ERC20, functionName: "allowance", args: [owner, a.spender] });
    return allowance > BigInt(10) ** BigInt(30);
  }
  return client.readContract({ address: a.token, abi: ERC1155, functionName: "isApprovedForAll", args: [owner, a.spender] });
}

export async function getLiveWalletState(address: string): Promise<LiveWalletState> {
  const client = publicClient();
  const owner = address as Address;
  const [pusd, pol, approvals] = await Promise.all([
    client.readContract({ address: CONTRACTS.pUSD, abi: ERC20, functionName: "balanceOf", args: [owner] }),
    client.getBalance({ address: owner }),
    Promise.all(APPROVALS.map(async (a) => ({ label: a.label, ok: await approvalOk(client, owner, a).catch(() => false) }))),
  ]);
  return {
    address,
    pusd: Number(formatUnits(pusd, 6)),
    pol: Number(formatUnits(pol, 18)),
    approvals,
    ready: approvals.every((a) => a.ok),
  };
}

/** Sends whichever approvals are missing, one transaction each, and waits for them. Needs POL for gas. */
export async function ensureApprovals(privateKey: `0x${string}`): Promise<{ sent: { label: string; hash: string }[] }> {
  const account = privateKeyToAccount(privateKey);
  const reader = publicClient();
  const writer = createWalletClient({ account, chain: polygon, transport: http(rpcUrl()) });
  const sent: { label: string; hash: string }[] = [];
  for (const a of APPROVALS) {
    if (await approvalOk(reader, account.address, a).catch(() => false)) continue;
    const hash = a.kind === "erc20"
      ? await writer.writeContract({ address: a.token, abi: ERC20, functionName: "approve", args: [a.spender, maxUint256] })
      : await writer.writeContract({ address: a.token, abi: ERC1155, functionName: "setApprovalForAll", args: [a.spender, true] });
    await reader.waitForTransactionReceipt({ hash });
    sent.push({ label: a.label, hash });
  }
  return { sent };
}

// ── Orders ──────────────────────────────────────────────────────────────────

const clients = new Map<string, Promise<ClobClient>>();

/** An L2-authenticated CLOB client for this key. API creds are derived (deterministic) once per process. */
function clobClient(privateKey: `0x${string}`): Promise<ClobClient> {
  const account = privateKeyToAccount(privateKey);
  const hit = clients.get(account.address);
  if (hit) return hit;
  const created = (async () => {
    const signer = createWalletClient({ account, chain: polygon, transport: http(rpcUrl()) });
    const l1 = new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, throwOnError: true });
    const creds = await l1.createOrDeriveApiKey();
    return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, creds, throwOnError: true });
  })();
  clients.set(account.address, created);
  created.catch(() => clients.delete(account.address));
  return created;
}

export interface LiveOrderInput {
  tokenId: string;
  side: "buy" | "sell";
  /** BUY: USD to spend. SELL: ignored (use shares). */
  usd?: number;
  /** SELL: shares to sell. Limit BUY may give shares instead of usd. */
  shares?: number;
  /** Market orders: worst acceptable price. Limit orders: the resting price. */
  limitPrice?: number;
  kind: "market" | "limit";
  tickSize: number;
  negRisk: boolean;
}

export interface LiveOrderResult {
  orderId: string;
  status: string;
  /** Matched immediately (0 for a resting limit order). */
  shares: number;
  notional: number;
  avgPrice: number;
}

function tickSizeOf(n: number): TickSize {
  const known: TickSize[] = ["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"];
  return known.find((t) => Math.abs(Number(t) - n) < 1e-9) ?? "0.01";
}

/** Shares/USD actually matched, from the exchange's making/taking amounts. */
export function matchedAmounts(side: "buy" | "sell", resp: Pick<OrderResponse, "makingAmount" | "takingAmount">): { shares: number; notional: number } {
  const making = Number(resp.makingAmount) || 0;
  const taking = Number(resp.takingAmount) || 0;
  return side === "buy" ? { shares: taking, notional: making } : { shares: making, notional: taking };
}

export async function placeLiveOrder(privateKey: `0x${string}`, input: LiveOrderInput): Promise<LiveOrderResult> {
  const geo = await checkGeoblock();
  if (geo.blocked) {
    throw new Error(`Polymarket blocks order placement from this server's location (${[geo.region, geo.country].filter(Boolean).join(", ") || "unknown"}). Live trading is unavailable here; paper trading still works.`);
  }
  const client = await clobClient(privateKey);
  const options = { tickSize: tickSizeOf(input.tickSize), negRisk: input.negRisk };
  const side = input.side === "buy" ? Side.BUY : Side.SELL;

  let resp: OrderResponse;
  if (input.kind === "market") {
    const amount = input.side === "buy" ? input.usd : input.shares;
    if (!amount || amount <= 0) throw new Error(input.side === "buy" ? "usd is required" : "shares is required");
    resp = await client.createAndPostMarketOrder(
      { tokenID: input.tokenId, amount, side, orderType: OrderType.FAK, ...(input.limitPrice ? { price: input.limitPrice } : {}) },
      options,
      OrderType.FAK,
    );
  } else {
    if (!input.limitPrice) throw new Error("limitPrice is required for a limit order");
    const size = input.shares ?? (input.usd ? Math.floor((input.usd / input.limitPrice) * 100) / 100 : 0);
    if (!(size > 0)) throw new Error("shares or usd is required");
    resp = await client.createAndPostOrder({ tokenID: input.tokenId, price: input.limitPrice, side, size }, options, OrderType.GTC);
  }
  if (!resp.success) throw new Error(resp.errorMsg || "Order rejected");
  const { shares, notional } = matchedAmounts(input.side, resp);
  return { orderId: resp.orderID, status: resp.status, shares, notional, avgPrice: shares > 0 ? notional / shares : 0 };
}

export interface LiveOpenOrder {
  id: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  filled: number;
  createdAt: number | null;
}

export async function getLiveOpenOrders(privateKey: `0x${string}`): Promise<LiveOpenOrder[]> {
  const client = await clobClient(privateKey);
  const resp = await client.getOpenOrders();
  const orders = Array.isArray(resp) ? resp : ((resp as { data?: unknown[] }).data ?? []);
  return (orders as Record<string, unknown>[]).map((o) => ({
    id: String(o.id),
    tokenId: String(o.asset_id ?? ""),
    side: String(o.side ?? ""),
    price: Number(o.price) || 0,
    size: Number(o.original_size) || 0,
    filled: Number(o.size_matched) || 0,
    createdAt: o.created_at ? Number(o.created_at) * 1000 : null,
  }));
}

export async function cancelLiveOrder(privateKey: `0x${string}`, orderId: string): Promise<void> {
  const client = await clobClient(privateKey);
  await client.cancelOrder({ orderID: orderId });
}
