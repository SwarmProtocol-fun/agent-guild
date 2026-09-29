"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DollarSign, Store, HardDrive, Repeat, Loader2, RefreshCw, ShieldAlert,
  TrendingUp, Coins,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import { useChartPalette } from "@/components/charts/chart-theme";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import type { RevenueOverview } from "@/lib/revenue-analytics";

function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export default function RevenueAnalyticsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);
  const palette = useChartPalette();

  const [overview, setOverview] = useState<RevenueOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/analytics/revenue");
      if (res.ok) {
        const d = await res.json();
        setOverview(d.overview);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="h-6 w-6 text-emerald-400" />
          <h1 className="text-2xl font-bold">Revenue & Financials</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && !overview ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : overview ? (
        <>
          <p className="text-xs text-muted-foreground -mt-2">
            Last {overview.periodDays} days. Marketplace figures are shown per-currency —
            revenue arrives in HBAR, native chain tokens, and stablecoins, so raw totals are
            never summed across currencies.
          </p>

          {/* Compute profitability — single-currency, USD cents */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
              <HardDrive className="h-4 w-4" /> Swarm Compute — This Month
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                icon={TrendingUp}
                label="Customer Revenue"
                value={formatUsdCents(overview.compute.totalCustomerRevenueCents)}
              />
              <StatCard
                icon={DollarSign}
                label="Provider Cost"
                value={formatUsdCents(overview.compute.totalProviderCostCents)}
              />
              <StatCard
                icon={Coins}
                label="Platform Profit"
                value={formatUsdCents(overview.compute.totalPlatformProfitCents)}
                accent={overview.compute.totalPlatformProfitCents > 0 ? "green" : "red"}
              />
              <StatCard
                icon={TrendingUp}
                label="Margin"
                value={`${overview.compute.marginPercent}%`}
              />
            </div>
          </div>

          {/* Marketplace revenue by currency */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
              <Store className="h-4 w-4" /> Marketplace Revenue by Currency
            </h3>
            {overview.marketplace.byCurrency.length === 0 ? (
              <div className="rounded-xl border border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
                No marketplace transactions in this period.
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {overview.marketplace.byCurrency.map((bucket) => (
                  <div key={bucket.currency} className="rounded-xl border border-border bg-card/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{bucket.currency}</span>
                      <span className="text-xs text-muted-foreground">{bucket.count} tx</span>
                    </div>
                    <p className="text-xl font-bold mt-1">
                      {bucket.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {bucket.platformFee.toLocaleString(undefined, { maximumFractionDigits: 4 })} fees
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Transaction type breakdown + subscriptions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3">Transactions by Type</h3>
              <div className="space-y-1.5">
                {Object.entries(overview.marketplace.byType).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="capitalize text-muted-foreground">{type}</span>
                    <span className="font-medium">{count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                <Repeat className="h-4 w-4" /> Subscriptions
              </h3>
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-2xl font-bold text-emerald-400">{overview.subscriptions.active}</p>
                  <p className="text-xs text-muted-foreground">Active</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{overview.subscriptions.total}</p>
                  <p className="text-xs text-muted-foreground">All-time</p>
                </div>
              </div>
            </div>
          </div>

          {/* Daily transaction volume */}
          {overview.marketplace.dailyTransactions.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-4">Marketplace Transactions per Day</h3>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={overview.marketplace.dailyTransactions}
                    margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                  >
                    <defs>
                      <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={palette.primary} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={palette.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: palette.muted }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: palette.muted }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="count"
                      name="Transactions"
                      stroke={palette.primary}
                      strokeWidth={2}
                      fill="url(#gradRevenue)"
                      dot={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-24 text-muted-foreground">
          <p>No revenue data available yet.</p>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof DollarSign;
  label: string;
  value: number | string;
  accent?: "green" | "red";
}) {
  const accentStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
    green: { border: "border-emerald-500/30", bg: "bg-emerald-500/5", text: "text-emerald-400", icon: "text-emerald-400" },
    red: { border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-400", icon: "text-red-400" },
  };
  const s = accent ? accentStyles[accent] : null;

  return (
    <div className={`rounded-xl border p-3 ${s ? `${s.border} ${s.bg}` : "border-border bg-card/50"}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${s ? s.icon : "text-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold mt-1 ${s ? s.text : ""}`}>{value}</p>
    </div>
  );
}
