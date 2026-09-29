/**
 * Revenue / Financial Analytics — consolidates the platform's separate
 * money ledgers into one read model:
 *
 *  - marketplaceTransactions — real-money marketplace sales (multi-currency:
 *    HBAR, native EVM tokens, USDC-on-chain — NOT normalized to one unit)
 *  - computeBillingLedger — Swarm Compute provider cost vs customer price,
 *    already tracked in USD cents via getProfitabilitySummary()
 *  - marketSubscriptions — active subscription counts
 *
 * Deliberately excludes "credit"/trust scores (src/lib/credit-*): those are
 * a unitless reputation metric, not currency, and summing them with real
 * revenue would misrepresent both.
 *
 * Marketplace amounts are bucketed by currency rather than summed together —
 * a raw sum across HBAR/ETH/USDC would be meaningless. See the known
 * currency-blindness bug in /api/admin/marketplace/revenue for contrast.
 *
 * Server-only (Firebase Admin SDK) — never import into client code.
 */

import { adminDb } from "./firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { CHAIN_CONFIGS } from "./chains";
import { getProfitabilitySummary } from "./compute/billing";

// ── Types ──

export interface CurrencyBucket {
  currency: string;
  amount: number;
  platformFee: number;
  count: number;
}

export interface DailyTxPoint {
  date: string; // MM-DD
  count: number;
}

export interface ComputeProfitability {
  totalProviderCostCents: number;
  totalCustomerRevenueCents: number;
  totalPlatformProfitCents: number;
  marginPercent: number;
  totalEntries: number;
}

export interface RevenueOverview {
  periodDays: number;
  marketplace: {
    byCurrency: CurrencyBucket[];
    byType: Record<string, number>; // transaction counts, currency-agnostic
    transactionCount: number;
    dailyTransactions: DailyTxPoint[];
  };
  compute: ComputeProfitability;
  subscriptions: {
    total: number;
    active: number;
  };
}

// ── Helpers ──

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  if (typeof val === "object" && val !== null && "seconds" in val) {
    return new Date((val as { seconds: number }).seconds * 1000);
  }
  return null;
}

function dateKey(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Best-effort currency label for a marketplace transaction doc. */
function inferCurrency(data: Record<string, unknown>): string {
  if (data.paymentToken) return data.paymentToken as string;
  const chain = data.chain as string | undefined;
  if (chain && CHAIN_CONFIGS[chain]) return CHAIN_CONFIGS[chain].nativeCurrency.symbol;
  return "USD";
}

// ── Main aggregation ──

export async function getRevenueOverview(periodDays = 30): Promise<RevenueOverview> {
  const db = adminDb();
  const now = new Date();
  const cutoff = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const cutoffTs = Timestamp.fromDate(cutoff);

  // ── Marketplace transactions (windowed, with fallback like the revenue route) ──
  const txRef = db.collection("marketplaceTransactions");
  let txDocs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await txRef.where("createdAt", ">=", cutoffTs).get();
    txDocs = snap.docs;
  } catch {
    const snap = await txRef.get();
    txDocs = snap.docs.filter((d) => {
      const ts = toDate(d.data().createdAt);
      return ts !== null && ts >= cutoff;
    });
  }

  const currencyMap = new Map<string, CurrencyBucket>();
  const byType: Record<string, number> = { subscription: 0, purchase: 0, rental: 0, hire: 0 };
  const dailyMap = new Map<string, DailyTxPoint>();
  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap.set(dateKey(d), { date: dateKey(d).slice(5), count: 0 });
  }

  for (const doc of txDocs) {
    const data = doc.data();
    const amount = (data.amount as number) || 0;
    const fee = (data.platformFee as number) || 0;
    const type = (data.type as string) || "purchase";
    const currency = inferCurrency(data);

    if (!currencyMap.has(currency)) {
      currencyMap.set(currency, { currency, amount: 0, platformFee: 0, count: 0 });
    }
    const bucket = currencyMap.get(currency)!;
    bucket.amount += amount;
    bucket.platformFee += fee;
    bucket.count++;

    byType[type] = (byType[type] || 0) + 1;

    const createdAt = toDate(data.createdAt);
    if (createdAt) {
      const point = dailyMap.get(dateKey(createdAt));
      if (point) point.count++;
    }
  }

  // ── Compute billing (already USD-cent denominated) ──
  const profitability = await getProfitabilitySummary();
  const compute: ComputeProfitability = {
    totalProviderCostCents: profitability.totalProviderCostCents,
    totalCustomerRevenueCents: profitability.totalCustomerRevenueCents,
    totalPlatformProfitCents: profitability.totalPlatformProfitCents,
    marginPercent: profitability.marginPercent,
    totalEntries: profitability.totalEntries,
  };

  // ── Subscriptions ──
  const [totalSubsAgg, activeSubsAgg] = await Promise.all([
    db.collection("marketSubscriptions").count().get(),
    db.collection("marketSubscriptions").where("status", "==", "active").count().get(),
  ]);

  return {
    periodDays,
    marketplace: {
      byCurrency: Array.from(currencyMap.values()).sort((a, b) => b.count - a.count),
      byType,
      transactionCount: txDocs.length,
      dailyTransactions: Array.from(dailyMap.values()),
    },
    compute,
    subscriptions: {
      total: totalSubsAgg.data().count,
      active: activeSubsAgg.data().count,
    },
  };
}
