"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface AuditEntry {
  id: string;
  action: string;
  performedBy: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  timestamp?: { seconds: number };
}

const TARGET_TYPE_OPTIONS = ["all", "agent", "policy", "model", "appeal", "dispute", "override"] as const;

const TARGET_TYPE_COLORS: Record<string, string> = {
  agent: "bg-cyan-500/20 text-cyan-400",
  policy: "bg-purple-500/20 text-purple-400",
  model: "bg-blue-500/20 text-blue-400",
  appeal: "bg-emerald-500/20 text-emerald-400",
  dispute: "bg-amber-500/20 text-amber-400",
  override: "bg-red-500/20 text-red-400",
};

export default function CreditOpsAuditPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>("all");

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (targetTypeFilter !== "all") params.set("targetType", targetTypeFilter);
      params.set("limit", "100");

      const res = await fetch(`/api/admin/credit-ops/audit?${params}`);
      if (res.ok) {
        const d = await res.json();
        setEntries(d.entries || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [targetTypeFilter]);

  useEffect(() => {
    if (isAdmin) fetchAudit();
  }, [isAdmin, fetchAudit]);

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
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-1">Credit operations action history</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAudit} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {TARGET_TYPE_OPTIONS.map((t) => (
          <Button
            key={t}
            variant={targetTypeFilter === t ? "default" : "ghost"}
            size="sm"
            onClick={() => setTargetTypeFilter(t)}
            className="text-xs"
          >
            {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      {/* Audit entries */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No audit entries yet</p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header */}
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="w-10">#</span>
            <span className="flex-1">Action</span>
            <span className="w-20">Type</span>
            <span className="w-32">Target</span>
            <span className="w-28">Performed By</span>
            <span className="w-36">Timestamp</span>
          </div>

          {entries.map((entry, i) => (
            <div
              key={entry.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
            >
              <span className="w-10 text-xs text-muted-foreground">{i + 1}</span>
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm">{formatAction(entry.action)}</span>
              </div>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${TARGET_TYPE_COLORS[entry.targetType] || "bg-muted"}`}>
                  {entry.targetType}
                </span>
              </span>
              <span className="w-32 text-xs font-mono text-muted-foreground truncate">
                {entry.targetId}
              </span>
              <span className="w-28 text-xs text-muted-foreground truncate">
                {entry.performedBy}
              </span>
              <span className="w-36 text-xs text-muted-foreground">
                {entry.timestamp
                  ? new Date(entry.timestamp.seconds * 1000).toLocaleString()
                  : "\u2014"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatAction(action: string): string {
  return action
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
