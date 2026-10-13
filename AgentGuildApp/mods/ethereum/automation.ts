/**
 * What the hub does for an Ethereum agent while the agent isn't running:
 * standing paper orders (limit, stop, trailing stop), price / address /
 * contract-event watches, and payment requests it confirms on-chain. An
 * agent wakes, thinks and exits — it can't watch a price for a week or
 * notice a USDC transfer at 3am. The minute tick (runEthTick in server.ts)
 * does, and what happened lands in the agent's alert inbox.
 *
 * Pure functions only: validation, trigger evaluation, payment amounts and
 * EIP-681 links. Persistence is automation-store.ts.
 */
import { formatUnits, getAddress, isAddress } from "viem";
import { PaperTradeError } from "./paper";
import type { EthNetwork } from "./networks";

/** Per agent, so one runaway loop can't fill the tick. */
export const MAX_OPEN_ORDERS = 20;
export const MAX_ACTIVE_WATCHES = 20;
export const MAX_OPEN_PAYMENT_REQUESTS = 20;
export const DEFAULT_TTL_DAYS = 7;
export const MAX_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

// ── Price triggers ───────────────────────────────────────────────────────

/**
 * above/below fire when the price crosses a level. trail fires when the
 * price falls trailPct below the highest price seen since the trigger was
 * set (a trailing stop) — `peakUsd` is kept by the tick.
 */
export type PriceTrigger =
  | { token: string; op: "above" | "below"; usd: number }
  | { token: string; op: "trail"; trailPct: number; peakUsd: number | null };

export function parsePriceTrigger(input: unknown, resolve: (v: string) => string): PriceTrigger {
  if (!input || typeof input !== "object") throw new PaperTradeError("trigger must be { token, op: above|below|trail, usd | trailPct }");
  const t = input as Record<string, unknown>;
  const raw = typeof t.token === "string" ? t.token : typeof t.mint === "string" ? t.mint : "";
  if (!raw.trim()) throw new PaperTradeError("trigger.token is required (symbol or token address)");
  const token = resolve(raw);
  if (t.op === "above" || t.op === "below") {
    const usd = Number(t.usd);
    if (!(Number.isFinite(usd) && usd > 0)) throw new PaperTradeError("trigger.usd must be a positive price");
    return { token, op: t.op, usd };
  }
  if (t.op === "trail") {
    const trailPct = Number(t.trailPct);
    if (!(Number.isFinite(trailPct) && trailPct >= 0.5 && trailPct <= 50)) throw new PaperTradeError("trigger.trailPct must be between 0.5 and 50");
    return { token, op: "trail", trailPct, peakUsd: null };
  }
  throw new PaperTradeError("trigger.op must be above, below or trail");
}

export interface TriggerCheck {
  hit: boolean;
  /** The trigger with its peak advanced (trail only); persist it when it changed. */
  next: PriceTrigger;
  changed: boolean;
}

/** Evaluates a trigger against the current price. A missing price never fires. */
export function checkTrigger(trigger: PriceTrigger, price: number | null): TriggerCheck {
  if (price == null || !(price > 0)) return { hit: false, next: trigger, changed: false };
  if (trigger.op !== "trail") return { hit: trigger.op === "above" ? price >= trigger.usd : price <= trigger.usd, next: trigger, changed: false };
  const peak = Math.max(trigger.peakUsd ?? price, price);
  const next = { ...trigger, peakUsd: peak };
  return { hit: price <= peak * (1 - trigger.trailPct / 100), next, changed: peak !== trigger.peakUsd };
}

export function describeTrigger(t: PriceTrigger, symbol?: string | null): string {
  const name = symbol ?? `${t.token.slice(0, 8)}…`;
  if (t.op === "trail") return `${name} falls ${t.trailPct}% from its high${t.peakUsd ? ` (high $${fmtUsd(t.peakUsd)})` : ""}`;
  return `${name} ${t.op === "above" ? "≥" : "≤"} $${fmtUsd(t.usd)}`;
}

export function fmtUsd(n: number): string {
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toPrecision(4);
}

// ── Expiry ───────────────────────────────────────────────────────────────

export function expiryFrom(ttlDays: unknown, now = Date.now()): string {
  const days = ttlDays == null || ttlDays === "" ? DEFAULT_TTL_DAYS : Number(ttlDays);
  if (!(Number.isFinite(days) && days > 0 && days <= MAX_TTL_DAYS)) throw new PaperTradeError(`ttlDays must be between 0 and ${MAX_TTL_DAYS}`);
  return new Date(now + days * DAY_MS).toISOString();
}

export const isExpired = (expiresAt: string, now = Date.now()) => Date.parse(expiresAt) <= now;

// ── Standing orders ──────────────────────────────────────────────────────

export type OrderStatus = "open" | "filling" | "filled" | "cancelled" | "expired" | "failed";

export interface StandingOrder {
  id: string;
  agentId: string;
  orgId: string;
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  /** Paper swap to make when the trigger fires. */
  inputToken: string;
  outputToken: string;
  /** "1.5", "all" or "25%" of the input holding at fill time. */
  amount: string;
  slippageBps: number | null;
  trigger: PriceTrigger;
  note: string | null;
  /** Set when it leaves "open". */
  closedAt?: string;
  firedPriceUsd?: number;
  tradeId?: string;
  result?: string;
}

const AMOUNT = /^(\d+(\.\d+)?|all|max|\d+(\.\d+)?%)$/i;

export function parseOrderAmount(value: unknown): string {
  const s = String(value ?? "").trim().toLowerCase();
  if (!AMOUNT.test(s)) throw new PaperTradeError("amount must be a token amount (\"1.5\"), \"all\" or a percentage (\"25%\")");
  if (s.endsWith("%")) {
    const pct = Number(s.slice(0, -1));
    if (!(pct > 0 && pct <= 100)) throw new PaperTradeError("A percentage amount must be between 0 and 100%");
  } else if (s !== "all" && s !== "max" && !(Number(s) > 0)) {
    throw new PaperTradeError("amount must be greater than 0");
  }
  return s;
}

export function parseSlippage(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new PaperTradeError("slippageBps must be an integer 1–1000");
  return n;
}

export function cleanNote(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 280) : null;
}

// ── Watches ──────────────────────────────────────────────────────────────

export type Watch = {
  id: string;
  agentId: string;
  orgId: string;
  status: "active" | "done" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  note: string | null;
  /** Keep firing (price: after re-arming; activity/event: on every new match) instead of stopping after the first alert. */
  repeat: boolean;
  fireCount: number;
  lastFiredAt?: string;
} & (
  | { kind: "price"; trigger: PriceTrigger; /** Re-arms a repeating price watch once the condition clears. */ armed: boolean }
  | {
    kind: "activity"; network: EthNetwork; address: string;
    /** Last block checked, and the account's nonce and ETH balance at that block. */
    lastBlock: string; lastNonce: number; lastBalanceWei: string;
  }
  | {
    kind: "event"; network: EthNetwork; address: string | null; event: string;
    /** Indexed-arg filters by name, e.g. { to: "0x…" }. */
    args: Record<string, unknown> | null;
    lastBlock: string;
  }
);

/** A repeating price watch fires once per crossing: it re-arms only after the condition stops holding. */
export function stepPriceWatch(watch: Extract<Watch, { kind: "price" }>, price: number | null): { fire: boolean; next: Extract<Watch, { kind: "price" }>; changed: boolean } {
  const check = checkTrigger(watch.trigger, price);
  let next = { ...watch, trigger: check.next };
  let changed = check.changed;
  if (check.hit && watch.armed) {
    next = { ...next, armed: false };
    // A trailing watch restarts from the current price after it fires.
    if (next.trigger.op === "trail") next = { ...next, trigger: { ...next.trigger, peakUsd: price } };
    return { fire: true, next, changed: true };
  }
  if (!check.hit && !watch.armed && price != null) {
    next = { ...next, armed: true };
    changed = true;
  }
  return { fire: false, next, changed };
}

/** Most blocks one watch scans per tick; a watch further behind catches up over several ticks. */
export const MAX_SCAN_BLOCKS = 2_000n;

/** The next block range a watch should scan, or null when it's caught up. */
export function scanRange(lastBlock: bigint, latest: bigint, max = MAX_SCAN_BLOCKS): { from: bigint; to: bigint } | null {
  if (latest <= lastBlock) return null;
  const from = lastBlock + 1n;
  return { from, to: latest - from + 1n > max ? from + max - 1n : latest };
}

export interface TokenMove { symbol: string; token: string; direction: "in" | "out"; raw: string; decimals: number }

/** One line about what happened to an address between two checks. */
export function summarizeActivity(input: { address: string; sentTxs: number; balanceDeltaWei: bigint; moves: TokenMove[] }): string | null {
  const parts: string[] = [];
  if (input.sentTxs > 0) parts.push(`sent ${input.sentTxs} transaction${input.sentTxs === 1 ? "" : "s"}`);
  if (input.balanceDeltaWei !== 0n) parts.push(`ETH ${input.balanceDeltaWei > 0n ? "+" : "−"}${formatUnits(input.balanceDeltaWei < 0n ? -input.balanceDeltaWei : input.balanceDeltaWei, 18)}`);
  const byToken = new Map<string, { symbol: string; decimals: number; net: bigint; count: number }>();
  for (const m of input.moves) {
    const row = byToken.get(m.token) ?? { symbol: m.symbol, decimals: m.decimals, net: 0n, count: 0 };
    row.net += m.direction === "in" ? BigInt(m.raw) : -BigInt(m.raw);
    row.count++;
    byToken.set(m.token, row);
  }
  for (const t of byToken.values()) {
    const sign = t.net > 0n ? "+" : t.net < 0n ? "−" : "±";
    parts.push(`${t.symbol} ${sign}${formatUnits(t.net < 0n ? -t.net : t.net, t.decimals)} (${t.count} transfer${t.count === 1 ? "" : "s"})`);
  }
  return parts.length ? parts.join(", ") : null;
}

// ── Payment requests (EIP-681) ───────────────────────────────────────────

export interface PaymentRequest {
  id: string;
  agentId: string;
  orgId: string;
  status: "pending" | "paid" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  network: EthNetwork;
  recipient: string;
  /** null = native ETH. */
  token: string | null;
  symbol: string;
  decimals: number;
  /** What was asked for, before the tag. */
  requestedUi: string;
  /** The exact amount the payer must send: requested + a few base units that tag this request. */
  amountUi: string;
  amountRaw: string;
  /** Block the request was made at; payments before it don't count. */
  startBlock: string;
  /** Native ETH only: highest block already scanned for the transfer. */
  scannedThrough: string;
  label: string | null;
  url: string;
  paidTx?: string;
  payer?: string | null;
  paidAt?: string;
}

/**
 * EVM transfers carry no reference field, so each request asks for a
 * unique amount: the requested amount plus a tag of 1–9,999 base units
 * (under a cent of USDC, a few nanoETH of ETH). A transfer of exactly that
 * amount to the recipient after startBlock is this request's payment.
 */
export function taggedAmount(requestedRaw: bigint, decimals: number, rand: () => number = Math.random): bigint {
  if (requestedRaw <= 0n) throw new PaperTradeError("amount must be greater than 0");
  // For tokens with few decimals a tag would be a visible amount; those get no tag and match on amount alone.
  if (decimals < 6) return requestedRaw;
  const tag = BigInt(1 + Math.floor(rand() * 9_999));
  return requestedRaw + tag;
}

/** An EIP-681 payment link wallets open as a pre-filled send. */
export function eip681Url(p: { chainId: number; recipient: string; token: string | null; amountRaw: string }): string {
  return p.token
    ? `ethereum:${p.token}@${p.chainId}/transfer?address=${p.recipient}&uint256=${p.amountRaw}`
    : `ethereum:${p.recipient}@${p.chainId}?value=${p.amountRaw}`;
}

export function parseRecipient(value: unknown): string {
  const v = String(value ?? "").trim();
  if (!isAddress(v, { strict: false })) throw new PaperTradeError("recipient must be a 0x address");
  return getAddress(v);
}

// ── Alerts ───────────────────────────────────────────────────────────────

/** Omit that keeps a union a union. */
export type NewRow<T> = T extends unknown ? Omit<T, "id"> : never;

export interface Alert {
  id: string;
  agentId: string;
  orgId: string;
  at: string;
  source: "order" | "watch" | "payment";
  refId: string;
  title: string;
  detail: string;
  read: boolean;
  hash?: string;
  explorerUrl?: string;
}
