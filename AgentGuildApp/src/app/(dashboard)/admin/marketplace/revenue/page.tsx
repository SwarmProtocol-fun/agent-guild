"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, DollarSign, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface RevenueStats {
  totalRevenue: number;
  platformFees: number;
  pendingPayouts: number;
  transactionCount: number;
}

interface TopEarner {
  id: string;
  name: string;
  type: string;
  revenue: number;
  txCount: number;
  publisher: string;
}

interface TopPublisher {
  wallet: string;
  tier: number;
  items: number;
  total: number;
  pending: number;
}

interface Transaction {
  id: string;
  itemId: string;
  itemName: string;
  buyerWallet: string;
  amount: number;
  type: string;
  status: string;
  createdAt?: { seconds: number };
}

const PERIOD_TABS = ["7d", "30d", "90d", "all"] as const;

const TIER_LABELS: Record<number, string> = { 0: "New", 1: "Approved", 2: "Trusted", 3: "Strategic" };
const TIER_COLORS: Record<number, string> = {
  0: "bg-zinc-500/20 text-zinc-400",
  1: "bg-blue-500/20 text-blue-400",
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-purple-500/20 text-purple-400",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-500/20 text-green-400",
  pending_payout: "bg-amber-500/20 text-amber-400",
  paid_out: "bg-blue-500/20 text-blue-400",
  disputed: "bg-red-500/20 text-red-400",
  refunded: "bg-red-500/20 text-red-400",
};

function formatCurrency(n: number): string {
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RevenuePage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<RevenueStats | null>(null);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [topEarners, setTopEarners] = useState<TopEarner[]>([]);
  const [topPublishers, setTopPublishers] = useState<TopPublisher[]>([]);
  const [recentTx, setRecentTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>("30d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/marketplace/revenue?period=${period}`);
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setByType(d.byType || {});
        setTopEarners(d.topEarners || []);
        setTopPublishers(d.topPublishers || []);
        setRecentTx(d.recentTransactions || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  async function revenueAction(action: string, target: string) {
    setActionLoading(`${action}-${target}`);
    try {
      await fetch("/api/admin/marketplace/revenue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "record_payout" ? { publisherWallet: target } : { transactionId: target }),
        }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Revenue</h1>
        </div>
        <div className="flex gap-2 items-center">
          <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
            {PERIOD_TABS.map((p) => (
              <Button
                key={p}
                variant={period === p ? "default" : "ghost"}
                size="sm"
                onClick={() => setPeriod(p)}
                className="text-xs"
              >
                {p}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : stats && stats.transactionCount === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <DollarSign className="h-12 w-12 opacity-30" />
          <p className="text-sm">No marketplace transactions recorded yet.</p>
          <p className="text-xs">Transaction data will appear here once purchases begin.</p>
        </div>
      ) : (
        <>
          {/* Stat Cards */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl border border-border bg-card/50 p-3">
                <span className="text-xs text-muted-foreground">Total Revenue</span>
                <p className="text-2xl font-bold mt-1">{formatCurrency(stats.totalRevenue)}</p>
              </div>
              <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-3">
                <span className="text-xs text-muted-foreground">Platform Fees</span>
                <p className="text-2xl font-bold mt-1 text-green-400">{formatCurrency(stats.platformFees)}</p>
              </div>
              <div className={`rounded-xl border p-3 ${stats.pendingPayouts > 1000 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
                <span className="text-xs text-muted-foreground">Pending Payouts</span>
                <p className={`text-2xl font-bold mt-1 ${stats.pendingPayouts > 1000 ? "text-amber-400" : ""}`}>
                  {formatCurrency(stats.pendingPayouts)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card/50 p-3">
                <span className="text-xs text-muted-foreground">Transactions</span>
                <p className="text-2xl font-bold mt-1">{stats.transactionCount}</p>
              </div>
            </div>
          )}

          {/* Revenue by Type */}
          {Object.values(byType).some((v) => v > 0) && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3">Revenue by Type</h3>
              <div className="space-y-2">
                {["subscription", "purchase", "rental", "hire"].map((type) => {
                  const amount = byType[type] || 0;
                  const total = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
                  const pct = (amount / total) * 100;
                  return (
                    <div key={type} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-24 capitalize">{type}</span>
                      <div className="flex-1 h-5 bg-muted/30 rounded overflow-hidden">
                        <div
                          className="h-full bg-amber-500/60 rounded transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono w-24 text-right">{formatCurrency(amount)}</span>
                      <span className="text-xs text-muted-foreground w-12 text-right">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Top Earners */}
          {topEarners.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3">Top Earners</h3>
              <div className="space-y-1">
                <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
                  <span className="flex-1">Item</span>
                  <span className="w-20">Type</span>
                  <span className="w-24 text-right">Revenue</span>
                  <span className="w-12 text-right">Txns</span>
                  <span className="w-28">Publisher</span>
                </div>
                {topEarners.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/30">
                    <span className="flex-1 font-medium truncate text-sm">{item.name}</span>
                    <span className="w-20">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted capitalize">{item.type}</span>
                    </span>
                    <span className="w-24 text-right text-sm font-mono">{formatCurrency(item.revenue)}</span>
                    <span className="w-12 text-right text-sm">{item.txCount}</span>
                    <span className="w-28 text-xs text-muted-foreground font-mono truncate">
                      {item.publisher?.slice(0, 12)}...
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Publishers */}
          {topPublishers.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3">Top Publishers</h3>
              <div className="space-y-1">
                <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
                  <span className="flex-1">Publisher</span>
                  <span className="w-20">Tier</span>
                  <span className="w-12 text-right">Items</span>
                  <span className="w-24 text-right">Total</span>
                  <span className="w-24 text-right">Pending</span>
                  <span className="w-24">Actions</span>
                </div>
                {topPublishers.map((pub) => (
                  <div key={pub.wallet} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/30">
                    <span className="flex-1 text-xs font-mono truncate">{pub.wallet}</span>
                    <span className="w-20">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[pub.tier] || TIER_COLORS[0]}`}>
                        T{pub.tier} {TIER_LABELS[pub.tier]}
                      </span>
                    </span>
                    <span className="w-12 text-right text-sm">{pub.items}</span>
                    <span className="w-24 text-right text-sm font-mono">{formatCurrency(pub.total)}</span>
                    <span className="w-24 text-right text-sm font-mono">
                      {pub.pending > 0 ? (
                        <span className="text-amber-400">{formatCurrency(pub.pending)}</span>
                      ) : (
                        formatCurrency(0)
                      )}
                    </span>
                    <span className="w-24">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => revenueAction("record_payout", pub.wallet)}
                        disabled={pub.pending === 0 || !!actionLoading}
                      >
                        {actionLoading === `record_payout-${pub.wallet}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Mark Paid"
                        )}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Transactions */}
          {recentTx.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3">Recent Transactions</h3>
              <div className="space-y-1">
                {recentTx.slice(0, 20).map((tx) => (
                  <div key={tx.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/30 text-sm">
                    <span className="text-xs text-muted-foreground w-20">
                      {tx.createdAt
                        ? new Date(tx.createdAt.seconds * 1000).toLocaleDateString()
                        : "---"}
                    </span>
                    <span className="flex-1 truncate">{tx.itemName}</span>
                    <span className="text-xs text-muted-foreground font-mono w-24 truncate">
                      {tx.buyerWallet?.slice(0, 10)}...
                    </span>
                    <span className="font-mono w-20 text-right">{formatCurrency(tx.amount)}</span>
                    <span className="w-20">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted capitalize">{tx.type}</span>
                    </span>
                    <span className="w-24">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[tx.status] || "bg-muted text-muted-foreground"}`}>
                        {tx.status.replace(/_/g, " ")}
                      </span>
                    </span>
                    {tx.status !== "disputed" && tx.status !== "refunded" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revenueAction("flag_transaction", tx.id)}
                        disabled={!!actionLoading}
                        title="Flag as suspicious"
                      >
                        {actionLoading === `flag_transaction-${tx.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <AlertTriangle className="h-3 w-3 text-muted-foreground" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
