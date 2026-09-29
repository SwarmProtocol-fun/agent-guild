"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, FileText, ChevronDown, Search,
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

const ACTION_TYPES = [
  "",
  "submission.advance",
  "submission.approve",
  "submission.reject",
  "submission.request_changes",
  "listing.suspend",
  "listing.unsuspend",
  "listing.feature",
  "listing.unfeature",
  "listing.recalculate_rank",
  "listing.suspended",
  "publisher.ban",
  "publisher.unban",
  "publisher.set-tier",
  "publisher.recalculate",
  "report.dismiss",
  "report.resolve",
  "report.suspend_item",
] as const;

const TARGET_COLORS: Record<string, string> = {
  submission: "bg-blue-500/20 text-blue-400",
  listing: "bg-green-500/20 text-green-400",
  publisher: "bg-amber-500/20 text-amber-400",
  report: "bg-red-500/20 text-red-400",
  mod_service: "bg-purple-500/20 text-purple-400",
};

export default function AuditLogPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("");
  const [targetIdSearch, setTargetIdSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (actionFilter) params.set("action", actionFilter);
      if (targetIdSearch) params.set("targetId", targetIdSearch);
      params.set("limit", String(limit));

      const res = await fetch(`/api/admin/marketplace/audit?${params}`);
      if (res.ok) {
        const d = await res.json();
        setEntries(d.entries || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [actionFilter, targetIdSearch, limit]);

  useEffect(() => {
    if (isAdmin) fetchAudit();
  }, [isAdmin, fetchAudit]);

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
          <FileText className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <span className="text-sm text-muted-foreground">({entries.length} entries)</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAudit} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Action type filter */}
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">All actions</option>
          {ACTION_TYPES.filter(Boolean).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        {/* Target ID search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by target ID..."
            value={targetIdSearch}
            onChange={(e) => setTargetIdSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchAudit()}
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-sm"
          />
        </div>
      </div>

      {/* Audit entries */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No audit entries found</p>
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-border bg-card/50">
              <button
                onClick={() => toggleExpand(entry.id)}
                className="w-full flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors text-left"
              >
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${
                    expanded.has(entry.id) ? "rotate-0" : "-rotate-90"
                  }`}
                />
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium flex-1">{formatAction(entry.action)}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${TARGET_COLORS[entry.targetType] || "bg-muted"}`}>
                  {entry.targetType}
                </span>
                <span className="text-xs text-muted-foreground font-mono">
                  {entry.targetId?.slice(0, 12)}...
                </span>
                {entry.timestamp && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(entry.timestamp.seconds * 1000).toLocaleString()}
                  </span>
                )}
              </button>

              {expanded.has(entry.id) && (
                <div className="px-12 pb-3 text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Performed by:</span>
                    <span className="font-mono">{entry.performedBy}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Target ID:</span>
                    <span className="font-mono">{entry.targetId}</span>
                  </div>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <div>
                      <span className="text-muted-foreground">Metadata:</span>
                      <pre className="mt-1 p-2 rounded bg-muted/50 overflow-x-auto text-xs">
                        {JSON.stringify(entry.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {entries.length >= limit && (
        <div className="text-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLimit((prev) => prev + 50)}
          >
            Load more
          </Button>
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
