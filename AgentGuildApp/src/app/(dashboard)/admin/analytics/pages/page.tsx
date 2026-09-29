"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  BarChart3, Loader2, RefreshCw, ShieldAlert, ArrowLeft, AlertCircle, Eye,
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

interface PageStat {
  path: string;
  views: number;
}

interface DailyPageviews {
  date: string;
  views: number;
}

interface PageAnalytics {
  topPages: PageStat[];
  dailyPageviews: DailyPageviews[];
  totalPageviews: number;
  configured: boolean;
  error?: string;
}

export default function PageAnalyticsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);
  const palette = useChartPalette();

  const [analytics, setAnalytics] = useState<PageAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics/pages?days=${days}`);
      if (res.ok) {
        const d = await res.json();
        setAnalytics(d.analytics);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [days]);

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/analytics" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <BarChart3 className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">Page Analytics</h1>
          {analytics && (
            <span className="text-sm text-muted-foreground">
              ({analytics.totalPageviews.toLocaleString()} views, {days}d)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                variant={days === d ? "default" : "outline"}
                size="sm"
                onClick={() => setDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {!analytics?.configured && !loading && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          PostHog not configured. Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID env vars.
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : analytics?.configured ? (
        <>
          {/* Daily Pageviews Chart */}
          {analytics.dailyPageviews.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-4">Daily Pageviews</h3>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={analytics.dailyPageviews}
                    margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                  >
                    <defs>
                      <linearGradient id="gradPageviews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={palette.success} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={palette.success} stopOpacity={0} />
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
                      dataKey="views"
                      name="Pageviews"
                      stroke={palette.success}
                      strokeWidth={2}
                      fill="url(#gradPageviews)"
                      dot={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Pages Table */}
          <div className="rounded-xl border border-border bg-card/50">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-medium">Top Pages</h3>
            </div>
            <div className="divide-y divide-border">
              {analytics.topPages.map((p, i) => {
                const maxViews = analytics.topPages[0]?.views || 1;
                const barWidth = (p.views / maxViews) * 100;
                return (
                  <div key={p.path} className="relative px-4 py-3">
                    {/* Background bar */}
                    <div
                      className="absolute inset-y-0 left-0 bg-cyan-500/5"
                      style={{ width: `${barWidth}%` }}
                    />
                    <div className="relative flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs text-muted-foreground w-6 text-right">
                          {i + 1}.
                        </span>
                        <span className="text-sm font-mono truncate">{p.path}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-4">
                        <Eye className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm font-medium">{p.views.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {analytics.topPages.length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No pageview data in this period
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
