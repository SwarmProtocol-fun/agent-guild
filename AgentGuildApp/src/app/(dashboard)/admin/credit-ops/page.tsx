"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, AlertTriangle, Clock, Loader2, RefreshCw,
  ArrowRight, FileText, Scale, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface OverviewStats {
  queueDepth: number;
  pending: number;
  inReview: number;
  resolved: number;
  activeAlerts: number;
  openAppeals: number;
  openDisputes: number;
  byPriority: Record<string, number>;
  byFlagType: Record<string, number>;
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

export default function CreditOpsOverviewPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recentAudit, setRecentAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/credit-ops/overview");
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
          <Scale className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">Credit Operations</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={Clock}
            label="Review Queue"
            value={stats.queueDepth}
            alert={stats.queueDepth > 0}
          />
          <StatCard
            icon={AlertTriangle}
            label="Active Alerts"
            value={stats.activeAlerts}
            alert={stats.activeAlerts > 0}
          />
          <StatCard
            icon={Scale}
            label="Open Appeals"
            value={stats.openAppeals}
          />
          <StatCard
            icon={Activity}
            label="Open Disputes"
            value={stats.openDisputes}
          />
        </div>
      )}

      {/* Priority Breakdown */}
      {stats && stats.queueDepth > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Queue by Priority</h3>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(stats.byPriority)
              .filter(([, count]) => count > 0)
              .map(([priority, count]) => (
                <div key={priority} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
                  priority === "critical" ? "bg-red-500/10" :
                  priority === "high" ? "bg-amber-500/10" :
                  "bg-muted/50"
                }`}>
                  <span className="text-xs text-muted-foreground">{priority}</span>
                  <span className={`text-sm font-bold ${
                    priority === "critical" ? "text-red-400" :
                    priority === "high" ? "text-amber-400" : ""
                  }`}>{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <QuickLink
          href="/admin/credit-ops/queue"
          icon={AlertTriangle}
          iconColor="text-amber-400"
          title="Review Queue"
          description={`${stats?.queueDepth || 0} agents pending review`}
        />
        <QuickLink
          href="/admin/credit-ops/overrides"
          icon={ShieldAlert}
          iconColor="text-cyan-400"
          title="Overrides"
          description="Score overrides & rollbacks"
        />
        <QuickLink
          href="/admin/credit-ops/policies"
          icon={FileText}
          iconColor="text-purple-400"
          title="Policies"
          description="Scoring rules & configuration"
        />
        <QuickLink
          href="/admin/credit-ops/models"
          icon={Activity}
          iconColor="text-blue-400"
          title="Models"
          description="Score model rollout controls"
        />
        <QuickLink
          href="/admin/credit-ops/appeals"
          icon={Scale}
          iconColor="text-emerald-400"
          title="Appeals"
          description={`${stats?.openAppeals || 0} open appeals`}
        />
        <QuickLink
          href="/admin/credit-ops/monitoring"
          icon={Activity}
          iconColor="text-red-400"
          title="Monitoring"
          description="Alerts & system health"
        />
      </div>

      {/* Recent Audit Log */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Recent Activity</h3>
          <Link href="/admin/credit-ops/audit" className="text-xs text-muted-foreground hover:text-foreground">
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
  icon: typeof Clock;
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

function QuickLink({
  href,
  icon: Icon,
  iconColor,
  title,
  description,
}: {
  href: string;
  icon: typeof Clock;
  iconColor: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between p-4 rounded-xl border border-border bg-card/50 hover:bg-card/80 transition-colors"
    >
      <div className="flex items-center gap-3">
        <Icon className={`h-5 w-5 ${iconColor}`} />
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function formatAction(action: string): string {
  return action
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
