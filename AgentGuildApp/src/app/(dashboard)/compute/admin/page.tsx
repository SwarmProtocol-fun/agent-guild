"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ChevronLeft, DollarSign, TrendingUp, Server, Users, BarChart3, MousePointer, Eye, ShieldAlert } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import type { PricingSettings, ProfitabilitySummary } from "@/lib/compute/types";

interface AnalyticsData {
  computeEvents: { event: string; count: number }[];
  totalPageviews: number;
  totalUniqueUsers: number;
  wizardFunnel: Record<string, number>;
  configured: boolean;
  error?: string;
}

export default function ComputeAdminPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [pricing, setPricing] = useState<PricingSettings | null>(null);
  const [profit, setProfit] = useState<ProfitabilitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);

  // Pricing form state
  const [defaultMarkup, setDefaultMarkup] = useState(30);
  const [smallMarkup, setSmallMarkup] = useState("");
  const [mediumMarkup, setMediumMarkup] = useState("");
  const [largeMarkup, setLargeMarkup] = useState("");
  const [xlMarkup, setXlMarkup] = useState("");
  const [minFloor, setMinFloor] = useState(1);

  const fetchData = async () => {
    setError("");
    try {
      const [pRes, profRes, analyticsRes] = await Promise.all([
        fetch("/api/compute/admin/pricing"),
        fetch("/api/compute/admin/profitability"),
        fetch("/api/compute/admin/analytics"),
      ]);

      if (pRes.status === 403) {
        setError("Access denied — admin wallet required");
        setLoading(false);
        return;
      }

      const pData = await pRes.json();
      const profData = await profRes.json();

      if (pData.ok) {
        setPricing(pData.settings);
        setDefaultMarkup(pData.settings.defaultMarkupPercent);
        setSmallMarkup(pData.settings.sizeOverrides?.small?.toString() ?? "");
        setMediumMarkup(pData.settings.sizeOverrides?.medium?.toString() ?? "");
        setLargeMarkup(pData.settings.sizeOverrides?.large?.toString() ?? "");
        setXlMarkup(pData.settings.sizeOverrides?.xl?.toString() ?? "");
        setMinFloor(pData.settings.minimumPriceFloorCents);
      }
      if (profData.ok) setProfit(profData.summary);
      const analyticsData = await analyticsRes.json().catch(() => ({ ok: false }));
      if (analyticsData.ok) setAnalytics(analyticsData.analytics);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (isAdmin) fetchData();
    else setLoading(false);
  }, [isAdmin]);

  const handleSave = async () => {
    setSaving(true);
    const sizeOverrides: Record<string, number> = {};
    if (smallMarkup) sizeOverrides.small = Number(smallMarkup);
    if (mediumMarkup) sizeOverrides.medium = Number(mediumMarkup);
    if (largeMarkup) sizeOverrides.large = Number(largeMarkup);
    if (xlMarkup) sizeOverrides.xl = Number(xlMarkup);

    await fetch("/api/compute/admin/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultMarkupPercent: defaultMarkup,
        sizeOverrides,
        minimumPriceFloorCents: minFloor,
      }),
    });
    await fetchData();
    setSaving(false);
  };

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  if (!authenticated || !isAdmin) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 p-6">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-bold">Access Denied</h1>
        <p className="text-sm text-muted-foreground">
          This page is restricted to platform administrators.
        </p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <Link href="/compute" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
          <ChevronLeft className="h-3 w-3" /> Compute
        </Link>
        <h1 className="text-2xl font-bold">Compute Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">Platform pricing, profitability, and analytics</p>
      </div>

      <Tabs defaultValue="profitability">
        <TabsList>
          <TabsTrigger value="profitability">Profitability</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="profitability" className="space-y-6">
      {/* Profitability Cards */}
      {profit && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Server className="h-4 w-4" />
              <span className="text-xs">Provider Cost</span>
            </div>
            <p className="mt-2 text-2xl font-bold">{fmt(profit.totalProviderCostCents)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <DollarSign className="h-4 w-4" />
              <span className="text-xs">Revenue</span>
            </div>
            <p className="mt-2 text-2xl font-bold">{fmt(profit.totalCustomerRevenueCents)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
              <span className="text-xs">Profit</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-emerald-400">{fmt(profit.totalPlatformProfitCents)}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Users className="h-4 w-4" />
              <span className="text-xs">Margin</span>
            </div>
            <p className="mt-2 text-2xl font-bold">{profit.marginPercent}%</p>
          </div>
        </div>
      )}

      {/* By Provider */}
      {profit && Object.keys(profit.entriesByProvider).length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-3">By Provider</h3>
          <div className="divide-y divide-border">
            {Object.entries(profit.entriesByProvider).map(([provider, data]) => (
              <div key={provider} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium capitalize">{provider}</span>
                <div className="flex gap-6 text-xs">
                  <span className="text-muted-foreground">Cost: {fmt(data.cost)}</span>
                  <span className="text-muted-foreground">Revenue: {fmt(data.revenue)}</span>
                  <span className="text-emerald-400">Profit: {fmt(data.profit)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By Size */}
      {profit && Object.keys(profit.entriesBySize).length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-3">By Size</h3>
          <div className="divide-y divide-border">
            {Object.entries(profit.entriesBySize).map(([size, data]) => (
              <div key={size} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium capitalize">{size}</span>
                <div className="flex gap-6 text-xs">
                  <span className="text-muted-foreground">Cost: {fmt(data.cost)}</span>
                  <span className="text-muted-foreground">Revenue: {fmt(data.revenue)}</span>
                  <span className="text-emerald-400">Profit: {fmt(data.profit)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No data state */}
      {profit && profit.totalEntries === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No billing ledger entries yet this month.</p>
          <p className="text-xs text-muted-foreground mt-1">Entries are recorded when computers are started with a real provider.</p>
        </div>
      )}
        </TabsContent>

        <TabsContent value="pricing" className="space-y-6">
      {/* Pricing Settings */}
      <div className="rounded-lg border border-border p-6 max-w-lg space-y-4">
        <h3 className="text-lg font-semibold">Pricing Settings</h3>

        <div>
          <label className="text-sm font-medium mb-1 block">Default Markup (%)</label>
          <input
            type="number"
            value={defaultMarkup}
            onChange={(e) => setDefaultMarkup(Number(e.target.value))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Small Override (%)</label>
            <input
              type="number"
              value={smallMarkup}
              onChange={(e) => setSmallMarkup(e.target.value)}
              placeholder="Default"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Medium Override (%)</label>
            <input
              type="number"
              value={mediumMarkup}
              onChange={(e) => setMediumMarkup(e.target.value)}
              placeholder="Default"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Large Override (%)</label>
            <input
              type="number"
              value={largeMarkup}
              onChange={(e) => setLargeMarkup(e.target.value)}
              placeholder="Default"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">XL Override (%)</label>
            <input
              type="number"
              value={xlMarkup}
              onChange={(e) => setXlMarkup(e.target.value)}
              placeholder="Default"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Minimum Price Floor (cents)</label>
          <input
            type="number"
            value={minFloor}
            onChange={(e) => setMinFloor(Number(e.target.value))}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Pricing Settings"}
        </button>
      </div>

        </TabsContent>

        <TabsContent value="analytics" className="space-y-6">
      {/* Product Analytics */}
      {analytics && !analytics.configured && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">PostHog not configured.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID env vars to enable analytics.
          </p>
        </div>
      )}

      {analytics && analytics.configured && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Eye className="h-4 w-4" />
                <span className="text-xs">Compute Pageviews (30d)</span>
              </div>
              <p className="mt-2 text-2xl font-bold">{analytics.totalPageviews.toLocaleString()}</p>
            </div>
            {analytics.computeEvents.map((ev) => (
              <div key={ev.event} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MousePointer className="h-4 w-4" />
                  <span className="text-xs">{ev.event.replace("compute.", "")}</span>
                </div>
                <p className="mt-2 text-2xl font-bold">{ev.count}</p>
              </div>
            ))}
          </div>

          {/* Wizard Funnel */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Create Computer Wizard Funnel
            </h3>
            <div className="space-y-2">
              {Object.entries(analytics.wizardFunnel).map(([step, count]) => {
                const maxCount = Math.max(...Object.values(analytics.wizardFunnel), 1);
                const pct = (count / maxCount) * 100;
                return (
                  <div key={step} className="flex items-center gap-3">
                    <span className="w-24 text-xs text-muted-foreground capitalize">{step}</span>
                    <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 text-xs font-medium text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {analytics.error && (
            <p className="text-xs text-amber-400">{analytics.error}</p>
          )}
        </>
      )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
