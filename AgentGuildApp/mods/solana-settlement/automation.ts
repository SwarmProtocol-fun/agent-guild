/**
 * What the hub does for an agent while the agent isn't running: standing
 * paper orders (limit, stop, trailing stop), price and wallet watches, and
 * payment requests it checks on-chain. An agent is a process that wakes,
 * thinks and exits — it can't watch a price for a week or notice a payment
 * at 3am. The minute tick (runSolanaTick in server.ts) does that, and what
 * happened lands in the agent's alert inbox for its next wake.
 *
 * Pure functions only: validation, trigger evaluation, Solana Pay URLs.
 * Persistence is automation-store.ts.
 */
import { Keypair } from "@solana/web3.js";
import { PaperTradeError } from "./paper";

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
  | { mint: string; op: "above" | "below"; usd: number }
  | { mint: string; op: "trail"; trailPct: number; peakUsd: number | null };

export function parsePriceTrigger(input: unknown, resolveMint: (v: string) => string): PriceTrigger {
  if (!input || typeof input !== "object") throw new PaperTradeError("trigger must be { mint, op: above|below|trail, usd | trailPct }");
  const t = input as Record<string, unknown>;
  if (typeof t.mint !== "string" || !t.mint.trim()) throw new PaperTradeError("trigger.mint is required (symbol or mint address)");
  const mint = resolveMint(t.mint);
  if (t.op === "above" || t.op === "below") {
    const usd = Number(t.usd);
    if (!(Number.isFinite(usd) && usd > 0)) throw new PaperTradeError("trigger.usd must be a positive price");
    return { mint, op: t.op, usd };
  }
  if (t.op === "trail") {
    const trailPct = Number(t.trailPct);
    if (!(Number.isFinite(trailPct) && trailPct >= 0.5 && trailPct <= 50)) throw new PaperTradeError("trigger.trailPct must be between 0.5 and 50");
    return { mint, op: "trail", trailPct, peakUsd: null };
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
  const name = symbol ?? `${t.mint.slice(0, 4)}…`;
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
  inputMint: string;
  outputMint: string;
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
  if (!AMOUNT.test(s)) throw new PaperTradeError("amount must be a UI amount (\"1.5\"), \"all\" or a percentage (\"25%\")");
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

export type WatchCluster = "devnet" | "testnet" | "mainnet-beta";

export type Watch = {
  id: string;
  agentId: string;
  orgId: string;
  status: "active" | "done" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
  note: string | null;
  /** Keep firing (price: after re-arming; activity: every new tx) instead of stopping after the first alert. */
  repeat: boolean;
  fireCount: number;
  lastFiredAt?: string;
} & (
  | { kind: "price"; trigger: PriceTrigger; /** Re-arms a repeating price watch once the condition clears. */ armed: boolean }
  | { kind: "activity"; address: string; cluster: WatchCluster; /** Newest signature already reported. */ lastSignature: string | null }
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

// ── Payment requests (Solana Pay) ────────────────────────────────────────

export interface PaymentRequest {
  id: string;
  agentId: string;
  orgId: string;
  status: "pending" | "paid" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  cluster: WatchCluster;
  recipient: string;
  /** null = SOL. */
  mint: string | null;
  /** UI amount. */
  amount: string;
  /** Fresh public key the payer's wallet adds to the transfer, so the payment is findable. */
  reference: string;
  label: string | null;
  message: string | null;
  memo: string | null;
  url: string;
  paidSignature?: string;
  payer?: string | null;
  paidAt?: string;
}

/** A Solana Pay transfer-request URL (https://docs.solanapay.com/spec). */
export function solanaPayUrl(p: { recipient: string; amount: string; mint: string | null; reference: string; label?: string | null; message?: string | null; memo?: string | null }): string {
  const q = new URLSearchParams();
  q.set("amount", p.amount);
  if (p.mint) q.set("spl-token", p.mint);
  q.set("reference", p.reference);
  if (p.label) q.set("label", p.label);
  if (p.message) q.set("message", p.message);
  if (p.memo) q.set("memo", p.memo);
  return `solana:${p.recipient}?${q.toString().replace(/\+/g, "%20")}`;
}

export const newReference = () => Keypair.generate().publicKey.toBase58();

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
  signature?: string;
  explorerUrl?: string;
}
