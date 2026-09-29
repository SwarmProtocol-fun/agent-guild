"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Package, Users, Flag, Clock, Loader2, RefreshCw,
  AlertTriangle, ArrowRight, FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface OverviewStats {
  queueDepth: number;
  activeListings: number;
  activePublishers: number;
  openReports: number;
  stageBreakdown: Record<string, number>;
}

interface AuditEntry {
  id: string;
  action: string;
  performedBy: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  timestamp?: { seconds: number };
}

export default function MarketplaceOverviewPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recentAudit, setRecentAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/marketplace/overview");
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setRecentAudit(d.recentAudit || []);
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
          <Package className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Marketplace Admin</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Clock} label="Queue Depth" value={stats.queueDepth} alert={stats.queueDepth > 0} />
          <StatCard icon={Package} label="Active Listings" value={stats.activeListings} />
          <StatCard icon={Users} label="Publishers" value={stats.activePublishers} />
          <StatCard icon={Flag} label="Open Reports" value={stats.openReports} alert={stats.openReports > 0} />
        </div>
      )}

      {/* Stage Breakdown */}
      {stats?.stageBreakdown && stats.queueDepth > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Pipeline Stage Breakdown</h3>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(stats.stageBreakdown)
              .filter(([, count]) => count > 0)
              .map(([stage, count]) => (
                <div key={stage} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50">
                  <span className="text-xs text-muted-foreground">{stage.replace(/_/g, " ")}</span>
                  <span className="text-sm font-bold">{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Link
          href="/admin/marketplace/queue"
          className="flex items-center justify-between p-4 rounded-xl border border-border bg-card/50 hover:bg-card/80 transition-colors"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            <div>
              <p className="font-medium">Review Queue</p>
              <p className="text-xs text-muted-foreground">
                {stats?.queueDepth || 0} items pending review
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        <Link
          href="/admin/marketplace/reports"
          className="flex items-center justify-between p-4 rounded-xl border border-border bg-card/50 hover:bg-card/80 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Flag className="h-5 w-5 text-red-400" />
            <div>
              <p className="font-medium">Reports</p>
              <p className="text-xs text-muted-foreground">
                {stats?.openReports || 0} open reports
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </div>

      {/* Recent Audit Log */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Recent Activity</h3>
          <Link href="/admin/marketplace/audit" className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </Link>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : recentAudit.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No audit entries yet</p>
        ) : (
          <div className="space-y-2">
            {recentAudit.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{formatAction(entry.action)}</span>
                  <span className="text-xs text-muted-foreground ml-2 font-mono">
                    {entry.targetId?.slice(0, 12)}...
                  </span>
                </div>
                {entry.timestamp && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(entry.timestamp.seconds * 1000).toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  alert,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  alert?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${alert ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card/50"}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${alert ? "text-amber-400" : "text-muted-foreground"}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-2xl font-bold mt-1 ${alert ? "text-amber-400" : ""}`}>{value}</p>
    </div>
  );
}

function formatAction(action: string): string {
  return action
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
