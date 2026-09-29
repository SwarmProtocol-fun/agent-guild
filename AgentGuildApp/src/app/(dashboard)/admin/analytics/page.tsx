"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  BarChart3, Users, Clock, TrendingUp, Activity, Loader2, RefreshCw,
  ArrowRight, ShieldAlert, Eye, UserPlus, Timer, Zap,
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

interface OverviewMetrics {
  activeNow: number;
  dau: number;
  wau: number;
  mau: number;
  sessionsToday: number;
  avgSessionMs: number;
  newUsersThisWeek: number;
  totalUsers: number;
  dailySessions: { date: string; count: number }[];
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

export default function AnalyticsOverviewPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);
  const palette = useChartPalette();

  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/analytics/overview");
      if (res.ok) {
        const d = await res.json();
        setMetrics(d.overview);
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">Platform Analytics</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && !metrics ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : metrics ? (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-3">
            <StatCard
              icon={Eye}
              label="Active Now"
              value={metrics.activeNow}
              accent="green"
              pulse
            />
            <StatCard icon={Users} label="DAU (Today)" value={metrics.dau} />
            <StatCard icon={TrendingUp} label="WAU (7d)" value={metrics.wau} />
            <StatCard icon={Activity} label="MAU (30d)" value={metrics.mau} />
            <StatCard icon={Zap} label="Sessions Today" value={metrics.sessionsToday} />
            <StatCard
              icon={Timer}
              label="Avg Session"
              value={formatDuration(metrics.avgSessionMs)}
            />
            <StatCard
              icon={UserPlus}
              label="New Users (7d)"
              value={metrics.newUsersThisWeek}
              accent={metrics.newUsersThisWeek > 0 ? "green" : undefined}
            />
            <StatCard icon={Users} label="Total Users" value={metrics.totalUsers} />
          </div>

          {/* Quick Links */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <QuickLink
              href="/admin/analytics/sessions"
              icon={Clock}
              title="Sessions"
              description="Login/logout records with duration"
            />
            <QuickLink
              href="/admin/analytics/users"
              icon={Users}
              title="Users"
              description="User directory with engagement stats"
            />
            <QuickLink
              href="/admin/analytics/events"
              icon={Zap}
              title="Events"
              description="PostHog event stream & counts"
            />
            <QuickLink
              href="/admin/analytics/pages"
              icon={BarChart3}
              title="Pages"
              description="Page-level view analytics"
            />
          </div>

          {/* Sessions Chart */}
          {metrics.dailySessions.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <h3 className="text-sm font-medium mb-4">Sessions — Last 30 Days</h3>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={metrics.dailySessions}
                    margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                  >
                    <defs>
                      <linearGradient id="gradSessions" x1="0" y1="0" x2="0" y2="1">
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
                      name="Sessions"
                      stroke={palette.primary}
                      strokeWidth={2}
                      fill="url(#gradSessions)"
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
          <p>No analytics data available yet.</p>
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
  pulse,
}: {
  icon: typeof Users;
  label: string;
  value: number | string;
  accent?: "green" | "amber" | "red";
  pulse?: boolean;
}) {
  const accentStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
    green: {
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/5",
      text: "text-emerald-400",
      icon: "text-emerald-400",
    },
    amber: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/5",
      text: "text-amber-400",
      icon: "text-amber-400",
    },
    red: {
      border: "border-red-500/30",
      bg: "bg-red-500/5",
      text: "text-red-400",
      icon: "text-red-400",
    },
  };

  const s = accent ? accentStyles[accent] : null;

  return (
    <div
      className={`rounded-xl border p-3 ${
        s ? `${s.border} ${s.bg}` : "border-border bg-card/50"
      }`}
    >
      <div className="flex items-center gap-2">
        {pulse && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
        )}
        <Icon className={`h-4 w-4 ${s ? s.icon : "text-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold mt-1 ${s ? s.text : ""}`}>{value}</p>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof Users;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between p-4 rounded-xl border border-border bg-card/50 hover:bg-card/80 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-5 w-5 text-cyan-400 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-sm">{title}</p>
          <p className="text-xs text-muted-foreground truncate">{description}</p>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </Link>
  );
}
