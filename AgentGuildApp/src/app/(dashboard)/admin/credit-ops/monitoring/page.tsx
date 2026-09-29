"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, AlertTriangle, Activity, Bell, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface MonitoringStats {
  activeAlerts: number;
  bySeverity: { info: number; warning: number; critical: number };
  recentSlashings: number;
  avgCreditScore: number;
  avgTrustScore: number;
  tierDistribution: Record<string, number>;
  totalAgentsWithScores: number;
}

interface Alert {
  id: string;
  alertType: string;
  severity: string;
  agentId?: string;
  asn?: string;
  message: string;
  acknowledged: boolean;
  createdAt?: { seconds: number };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "border-red-500/30 bg-red-500/5 text-red-400",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-400",
  info: "border-blue-500/30 bg-blue-500/5 text-blue-400",
};

const TIER_COLORS: Record<string, string> = {
  Platinum: "bg-purple-500/20 text-purple-400",
  Gold: "bg-amber-500/20 text-amber-400",
  Silver: "bg-zinc-400/20 text-zinc-300",
  Bronze: "bg-orange-500/20 text-orange-400",
};

export default function MonitoringPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<MonitoringStats | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, alertsRes] = await Promise.all([
        fetch("/api/admin/credit-ops/monitoring"),
        fetch("/api/admin/credit-ops/alerts?acknowledged=false"),
      ]);
      if (statsRes.ok) { const d = await statsRes.json(); setStats(d.stats); }
      if (alertsRes.ok) { const d = await alertsRes.json(); setAlerts(d.items || []); }
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isAdmin) fetchData(); }, [isAdmin, fetchData]);

  async function acknowledgeAlert(alertId: string) {
    setActionLoading(true);
    try {
      await fetch("/api/admin/credit-ops/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertIds: [alertId] }),
      });
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } finally { setActionLoading(false); }
  }

  async function acknowledgeAll() {
    setActionLoading(true);
    try {
      await fetch("/api/admin/credit-ops/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertIds: alerts.map((a) => a.id) }),
      });
      setAlerts([]);
    } finally { setActionLoading(false); }
  }

  if (!authenticated || !isAdmin) {
    return (<div className="flex flex-col items-center justify-center h-[60vh] gap-3"><ShieldAlert className="h-12 w-12 text-red-400" /><h2 className="text-lg font-semibold">Access Denied</h2></div>);
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-red-400" />
          <div>
            <h1 className="text-2xl font-bold">Monitoring & Alerts</h1>
            <p className="text-sm text-muted-foreground mt-1">Credit system health and anomaly detection</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Alert severity cards */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className={`rounded-xl border p-3 ${stats.bySeverity.critical > 0 ? "border-red-500/30 bg-red-500/5" : "border-border bg-card/50"}`}>
                <span className="text-xs text-muted-foreground">Critical</span>
                <p className={`text-2xl font-bold ${stats.bySeverity.critical > 0 ? "text-red-400" : ""}`}>{stats.bySeverity.critical}</p>
              </div>
              <div className={`rounded-xl border p-3 ${stats.bySeverity.warning > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
                <span className="text-xs text-muted-foreground">Warning</span>
                <p className={`text-2xl font-bold ${stats.bySeverity.warning > 0 ? "text-amber-400" : ""}`}>{stats.bySeverity.warning}</p>
              </div>
              <div className="rounded-xl border border-border bg-card/50 p-3">
                <span className="text-xs text-muted-foreground">Recent Slashings</span>
                <p className="text-2xl font-bold">{stats.recentSlashings}</p>
              </div>
              <div className="rounded-xl border border-border bg-card/50 p-3">
                <span className="text-xs text-muted-foreground">Agents w/ Scores</span>
                <p className="text-2xl font-bold">{stats.totalAgentsWithScores}</p>
              </div>
            </div>
          )}

          {/* Score averages + Tier distribution */}
          {stats && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
                <h3 className="text-sm font-medium">Average Scores</h3>
                <div className="flex gap-8">
                  <div>
                    <span className="text-xs text-muted-foreground">Credit</span>
                    <p className="text-3xl font-bold">{stats.avgCreditScore}</p>
                    <p className="text-xs text-muted-foreground">/ 900</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Trust</span>
                    <p className="text-3xl font-bold">{stats.avgTrustScore}</p>
                    <p className="text-xs text-muted-foreground">/ 100</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
                <h3 className="text-sm font-medium">Tier Distribution</h3>
                <div className="space-y-2">
                  {Object.entries(stats.tierDistribution).map(([tier, count]) => {
                    const total = stats.totalAgentsWithScores || 1;
                    const pct = Math.round((count / total) * 100);
                    return (
                      <div key={tier} className="flex items-center gap-3">
                        <span className={`text-xs px-2 py-0.5 rounded w-20 text-center ${TIER_COLORS[tier] || "bg-muted"}`}>{tier}</span>
                        <div className="flex-1 h-2 bg-muted/50 rounded-full overflow-hidden">
                          <div className="h-full bg-current rounded-full" style={{ width: `${pct}%`, color: "var(--foreground)" }} />
                        </div>
                        <span className="text-xs text-muted-foreground w-12 text-right">{count} ({pct}%)</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Active alerts */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Bell className="h-4 w-4" /> Active Alerts ({alerts.length})
              </h3>
              {alerts.length > 0 && (
                <Button variant="outline" size="sm" onClick={acknowledgeAll} disabled={actionLoading}>
                  <Check className="h-3 w-3 mr-1" /> Acknowledge All
                </Button>
              )}
            </div>

            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No active alerts</p>
            ) : (
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div key={alert.id} className={`flex items-center gap-3 p-3 rounded-lg border ${SEVERITY_COLORS[alert.severity] || "border-border"}`}>
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{alert.message}</p>
                      <span className="text-xs opacity-70">
                        {alert.alertType.replace(/_/g, " ")}
                        {alert.asn && ` \u2014 ${alert.asn}`}
                        {alert.createdAt && ` \u2014 ${new Date(alert.createdAt.seconds * 1000).toLocaleString()}`}
                      </span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => acknowledgeAlert(alert.id)} disabled={actionLoading}>
                      <Check className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
