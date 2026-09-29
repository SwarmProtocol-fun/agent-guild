"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, AlertTriangle, Eye, Search, Loader2, RefreshCw,
  ArrowRight, Activity, Ban, CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface OverviewStats {
  pendingReviews: number;
  activeSignals: number;
  tierDistribution: Record<string, number>;
  signalBreakdown: Record<string, number>;
}

interface ScanRun {
  id: string;
  status: string;
  durationMs: number;
  agentsScanned: number;
  signalsGenerated: number;
  autoPenaltiesApplied: number;
  casesEscalated: number;
  startedAt?: { seconds: number };
}

export default function RiskOverviewPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recentScans, setRecentScans] = useState<ScanRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/risk/overview");
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setRecentScans(d.recentScans || []);
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

  const triggerScan = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/admin/risk/scan", { method: "POST" });
      if (res.ok) {
        await fetchData();
      }
    } catch {
      // silent
    } finally {
      setScanning(false);
    }
  };

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
        <div>
          <h1 className="text-2xl font-bold">Risk & Fraud Detection</h1>
          <p className="text-sm text-muted-foreground">Monitor and manage platform fraud signals</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={triggerScan} disabled={scanning}>
            {scanning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
            Run Scan
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : stats ? (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Pending Reviews"
              value={stats.pendingReviews}
              icon={<AlertTriangle className="h-5 w-5 text-amber-400" />}
              href="/admin/risk/queue"
            />
            <StatCard
              label="Active Signals"
              value={stats.activeSignals}
              icon={<Activity className="h-5 w-5 text-red-400" />}
              href="/admin/risk/signals"
            />
            <StatCard
              label="Flagged Agents"
              value={(stats.tierDistribution.flagged || 0) + (stats.tierDistribution.banned || 0)}
              icon={<Ban className="h-5 w-5 text-red-400" />}
            />
            <StatCard
              label="Clean Agents"
              value={stats.tierDistribution.clean || 0}
              icon={<CheckCircle className="h-5 w-5 text-emerald-400" />}
            />
          </div>

          {/* Risk Tier Distribution */}
          <div className="border border-border rounded-lg p-4">
            <h3 className="font-semibold mb-3">Risk Tier Distribution</h3>
            <div className="grid grid-cols-5 gap-3">
              {(["clean", "watch", "suspicious", "flagged", "banned"] as const).map((tier) => (
                <div key={tier} className="text-center">
                  <div className={`text-2xl font-bold ${
                    tier === "clean" ? "text-emerald-400" :
                    tier === "watch" ? "text-blue-400" :
                    tier === "suspicious" ? "text-amber-400" :
                    tier === "flagged" ? "text-orange-400" :
                    "text-red-400"
                  }`}>
                    {stats.tierDistribution[tier] || 0}
                  </div>
                  <div className="text-xs text-muted-foreground capitalize">{tier}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Signal Breakdown */}
          {Object.keys(stats.signalBreakdown).length > 0 && (
            <div className="border border-border rounded-lg p-4">
              <h3 className="font-semibold mb-3">Signal Breakdown (Latest Scan)</h3>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(stats.signalBreakdown).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between p-2 bg-muted/30 rounded">
                    <span className="text-xs font-mono">{type.replace(/_/g, " ")}</span>
                    <span className="text-sm font-semibold">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Scans */}
          <div className="border border-border rounded-lg p-4">
            <h3 className="font-semibold mb-3">Recent Scan Runs</h3>
            {recentScans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scans yet. Click &quot;Run Scan&quot; to start.</p>
            ) : (
              <div className="space-y-2">
                {recentScans.map((scan) => (
                  <div key={scan.id} className="flex items-center justify-between p-2 bg-muted/30 rounded text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${
                        scan.status === "completed" ? "bg-emerald-400" :
                        scan.status === "running" ? "bg-amber-400 animate-pulse" :
                        "bg-red-400"
                      }`} />
                      <span>{scan.status}</span>
                    </div>
                    <span className="text-muted-foreground">
                      {scan.agentsScanned} agents, {scan.signalsGenerated} signals, {scan.autoPenaltiesApplied} penalties
                    </span>
                    <span className="text-muted-foreground">{scan.durationMs}ms</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Links */}
          <div className="grid grid-cols-3 gap-4">
            <Link href="/admin/risk/queue" className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/30 transition">
              <div>
                <div className="font-semibold">Review Queue</div>
                <div className="text-xs text-muted-foreground">Cases pending review</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/admin/risk/signals" className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/30 transition">
              <div>
                <div className="font-semibold">Signal Explorer</div>
                <div className="text-xs text-muted-foreground">All raw signals</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link href="/admin/marketplace" className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/30 transition">
              <div>
                <div className="font-semibold">Marketplace Admin</div>
                <div className="text-xs text-muted-foreground">Back to marketplace</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">Failed to load data.</p>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, href }: {
  label: string;
  value: number;
  icon: React.ReactNode;
  href?: string;
}) {
  const content = (
    <div className="border border-border rounded-lg p-4 flex items-center justify-between hover:bg-muted/30 transition">
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      {icon}
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
