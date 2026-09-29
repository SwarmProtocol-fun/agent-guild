"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, AlertTriangle, ChevronDown, Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface SecurityStats {
  totalScansRun: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  suspendedForSecurity: number;
}

interface FlaggedItem {
  id: string;
  source: string;
  name: string;
  status: string;
  scanSeverity: string;
  findingsCount: number;
  findings: string[];
  permissionsRequired?: string[];
  submittedBy: string;
  lastScannedAt?: string;
}

interface HighRiskItem {
  id: string;
  source: string;
  name: string;
  permissions: string[];
  riskReason: string;
}

const SEVERITY_TABS = ["all", "critical", "high", "medium", "low"] as const;
const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  high: "bg-orange-500/20 text-orange-400",
  medium: "bg-amber-500/20 text-amber-400",
  low: "bg-blue-500/20 text-blue-400",
  none: "bg-green-500/20 text-green-400",
};

const PERMISSION_COLORS: Record<string, string> = {
  wallet_access: "bg-red-500/20 text-red-400",
  sensitive_data_access: "bg-red-500/20 text-red-400",
  external_api: "bg-orange-500/20 text-orange-400",
  cross_chain_message: "bg-orange-500/20 text-orange-400",
  webhook_access: "bg-amber-500/20 text-amber-400",
  execute: "bg-blue-500/20 text-blue-400",
  write: "bg-blue-500/20 text-blue-400",
  read: "bg-green-500/20 text-green-400",
};

export default function SecurityPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [flaggedItems, setFlaggedItems] = useState<FlaggedItem[]>([]);
  const [highRiskItems, setHighRiskItems] = useState<HighRiskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (severityFilter !== "all") params.set("severity", severityFilter);

      const res = await fetch(`/api/admin/marketplace/security?${params}`);
      if (res.ok) {
        const d = await res.json();
        setStats(d.stats);
        setFlaggedItems(d.flaggedItems || []);
        setHighRiskItems(d.highRiskPermissions || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [severityFilter]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  async function rescan(itemId: string, collection: string) {
    setActionLoading(`rescan-${itemId}`);
    try {
      await fetch("/api/admin/marketplace/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rescan", itemId, collection }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          <Shield className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Security Dashboard</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total Scans" value={stats.totalScansRun} />
          <StatCard label="Critical" value={stats.criticalFindings} alert={stats.criticalFindings > 0} color="red" />
          <StatCard label="High" value={stats.highFindings} alert={stats.highFindings > 0} color="orange" />
          <StatCard label="Medium" value={stats.mediumFindings} color="amber" />
          <StatCard label="Suspended" value={stats.suspendedForSecurity} alert={stats.suspendedForSecurity > 0} color="red" />
        </div>
      )}

      {/* Severity Filters */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {SEVERITY_TABS.map((s) => (
          <Button
            key={s}
            variant={severityFilter === s ? "default" : "ghost"}
            size="sm"
            onClick={() => setSeverityFilter(s)}
            className="text-xs"
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {/* Flagged Items */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Flagged Items ({flaggedItems.length})</h3>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : flaggedItems.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No flagged items</p>
        ) : (
          <div className="space-y-1">
            {flaggedItems.map((item) => (
              <div key={`${item.source}-${item.id}`} className="rounded-lg border border-border bg-card/30">
                <button
                  onClick={() => toggleExpand(item.id)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors text-left"
                >
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${
                      expanded.has(item.id) ? "rotate-0" : "-rotate-90"
                    }`}
                  />
                  <span className="font-medium flex-1 truncate">{item.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">{item.source}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    item.status === "approved" ? "bg-green-500/20 text-green-400" :
                    item.status === "suspended" ? "bg-red-500/20 text-red-400" :
                    "bg-amber-500/20 text-amber-400"
                  }`}>
                    {item.status}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${SEVERITY_COLORS[item.scanSeverity] || SEVERITY_COLORS.none}`}>
                    {item.scanSeverity}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.findingsCount} findings</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); rescan(item.id, item.source); }}
                    disabled={actionLoading === `rescan-${item.id}`}
                  >
                    {actionLoading === `rescan-${item.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </Button>
                </button>

                {expanded.has(item.id) && (
                  <div className="px-10 pb-3 space-y-1">
                    {item.findings.map((f, fi) => (
                      <div key={fi} className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </div>
                    ))}
                    <div className="text-xs text-muted-foreground mt-2">
                      Submitter: {item.submittedBy?.slice(0, 12)}...
                      {item.lastScannedAt && (
                        <span className="ml-3">Last scanned: {new Date(item.lastScannedAt).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Permission Risk Overview */}
      {highRiskItems.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">High-Risk Permission Combinations ({highRiskItems.length})</h3>
          <div className="space-y-2">
            {highRiskItems.map((item) => (
              <div key={`${item.source}-${item.id}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/30">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                <span className="font-medium text-sm flex-1 truncate">{item.name}</span>
                <div className="flex gap-1 flex-wrap">
                  {item.permissions.map((p) => (
                    <span
                      key={p}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${PERMISSION_COLORS[p] || "bg-muted"}`}
                    >
                      {p.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
                <span className="text-xs text-red-400 shrink-0 max-w-[200px] truncate">{item.riskReason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  alert,
  color,
}: {
  label: string;
  value: number;
  alert?: boolean;
  color?: string;
}) {
  const borderColor = alert
    ? color === "red" ? "border-red-500/30 bg-red-500/5" :
      color === "orange" ? "border-orange-500/30 bg-orange-500/5" :
      "border-amber-500/30 bg-amber-500/5"
    : "border-border bg-card/50";

  const textColor = alert
    ? color === "red" ? "text-red-400" :
      color === "orange" ? "text-orange-400" :
      "text-amber-400"
    : "";

  return (
    <div className={`rounded-xl border p-3 ${borderColor}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className={`text-2xl font-bold mt-1 ${textColor}`}>{value}</p>
    </div>
  );
}
