/**
 * GET /api/admin/marketplace/revenue
 * POST /api/admin/marketplace/revenue
 *
 * Revenue dashboard: aggregated transaction stats, top earners,
 * top publishers, and recent transactions from the
 * `marketplaceTransactions` collection.
 *
 * Handles empty collection gracefully (zeroes everywhere).
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

const PERIOD_DAYS: Record<string, number> = {
  "7d": 7, "30d": 30, "90d": 90, "all": 99999,
};

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const period = req.nextUrl.searchParams.get("period") || "30d";

  try {
    const days = PERIOD_DAYS[period] || 30;
    const cutoff = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);

    // Query transactions — if period is "all", no date filter
    const txRef = adminDb().collection("marketplaceTransactions");

    let txSnap;
    try {
      txSnap = await (period === "all" ? txRef : txRef.where("createdAt", ">=", cutoff)).get();
    } catch {
      // If composite index missing, fall back to full scan + in-memory filter
      txSnap = await txRef.get();
    }

    let totalRevenue = 0;
    let platformFees = 0;
    let pendingPayouts = 0;
    const byType: Record<string, number> = { subscription: 0, purchase: 0, rental: 0, hire: 0 };
    const itemRevMap: Record<string, { name: string; type: string; revenue: number; txCount: number; publisher: string }> = {};
    const pubRevMap: Record<string, { total: number; pending: number; items: Set<string> }> = {};
    const recentTx: Record<string, unknown>[] = [];

    for (const d of txSnap.docs) {
      const data = d.data();

      // In-memory date filter if we fell back to full scan
      if (period !== "all" && data.createdAt) {
        const ts = data.createdAt as Timestamp;
        if (ts.toMillis() < cutoff.toMillis()) continue;
      }

      const amount = (data.amount as number) || 0;
      const fee = (data.platformFee as number) || 0;
      const txType = (data.type as string) || "purchase";
      const status = (data.status as string) || "completed";

      totalRevenue += amount;
      platformFees += fee;
      if (status === "pending_payout" || status === "completed") {
        pendingPayouts += (amount - fee);
      }
      if (status === "paid_out") {
        // Already paid — don't count as pending
      }

      byType[txType] = (byType[txType] || 0) + amount;

      // Item aggregation
      const itemId = (data.itemId as string) || "unknown";
      if (!itemRevMap[itemId]) {
        itemRevMap[itemId] = {
          name: (data.itemName as string) || itemId,
          type: txType,
          revenue: 0,
          txCount: 0,
          publisher: (data.publisherWallet as string) || "",
        };
      }
      itemRevMap[itemId].revenue += amount;
      itemRevMap[itemId].txCount++;

      // Publisher aggregation
      const pubWallet = (data.publisherWallet as string) || "";
      if (pubWallet) {
        if (!pubRevMap[pubWallet]) pubRevMap[pubWallet] = { total: 0, pending: 0, items: new Set() };
        pubRevMap[pubWallet].total += amount;
        pubRevMap[pubWallet].items.add(itemId);
        if (status === "pending_payout" || status === "completed") {
          pubRevMap[pubWallet].pending += (amount - fee);
        }
      }

      recentTx.push({
        id: d.id,
        itemId,
        itemName: data.itemName || itemId,
        buyerWallet: data.buyerWallet || "",
        amount,
        type: txType,
        status,
        createdAt: data.createdAt,
      });
    }

    // Sort recent by createdAt desc
    recentTx.sort((a, b) => {
      const aT = (a.createdAt as { seconds: number })?.seconds || 0;
      const bT = (b.createdAt as { seconds: number })?.seconds || 0;
      return bT - aT;
    });

    // Top earners
    const topEarners = Object.entries(itemRevMap)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Top publishers with tier enrichment
    const topPublishers = Object.entries(pubRevMap)
      .map(([wallet, data]) => ({
        wallet,
        tier: 0,
        items: data.items.size,
        total: data.total,
        pending: data.pending,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Enrich publisher tiers
    await Promise.all(
      topPublishers.map(async (pub) => {
        try {
          const snap = await adminDb().collection("publisherProfiles").doc(pub.wallet).get();
          if (snap.exists) pub.tier = (snap.data()!.tier as number) ?? 0;
        } catch {
          // skip
        }
      }),
    );

    return Response.json({
      ok: true,
      stats: {
        totalRevenue,
        platformFees,
        pendingPayouts,
        transactionCount: recentTx.length,
      },
      byType,
      topEarners,
      topPublishers,
      recentTransactions: recentTx.slice(0, 50),
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch revenue",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, publisherWallet, transactionId, reason } = body as {
    action: "record_payout" | "flag_transaction";
    publisherWallet?: string;
    transactionId?: string;
    reason?: string;
  };

  if (!action) {
    return Response.json({ error: "action required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "record_payout": {
        if (!publisherWallet) {
          return Response.json({ error: "publisherWallet required" }, { status: 400 });
        }

        // Find pending transactions for this publisher
        const txSnap = await adminDb().collection("marketplaceTransactions")
          .where("publisherWallet", "==", publisherWallet)
          .where("status", "in", ["completed", "pending_payout"])
          .get();

        let updated = 0;
        for (const d of txSnap.docs) {
          await adminDb().collection("marketplaceTransactions").doc(d.id).update({
            status: "paid_out",
            paidOutAt: FieldValue.serverTimestamp(),
          });
          updated++;
        }

        await recordAuditEntry({
          action: "transaction.record_payout",
          performedBy: "platform-admin",
          targetType: "transaction",
          targetId: publisherWallet,
          metadata: { transactionsUpdated: updated },
        });

        return Response.json({ ok: true, updated });
      }

      case "flag_transaction": {
        if (!transactionId) {
          return Response.json({ error: "transactionId required" }, { status: 400 });
        }

        await adminDb().collection("marketplaceTransactions").doc(transactionId).update({
          status: "disputed",
          disputeReason: reason || "Flagged by admin",
          disputedAt: FieldValue.serverTimestamp(),
        });

        await recordAuditEntry({
          action: "transaction.flag",
          performedBy: "platform-admin",
          targetType: "transaction",
          targetId: transactionId,
          metadata: { reason },
        });

        return Response.json({ ok: true });
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
