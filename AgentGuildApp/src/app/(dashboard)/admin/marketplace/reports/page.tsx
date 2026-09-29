"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Flag, Ban, XCircle, CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Report {
  id: string;
  itemId: string;
  collection?: string;
  reportedBy: string;
  reason: string;
  comment?: string;
  resolution?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  createdAt?: { seconds: number };
  resolvedAt?: { seconds: number };
}

const STATUS_TABS = ["open", "dismissed", "resolved"] as const;

export default function ReportsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/marketplace/reports?status=${statusFilter}`);
      if (res.ok) {
        const d = await res.json();
        setReports(d.reports || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (isAdmin) fetchReports();
  }, [isAdmin, fetchReports]);

  async function reportAction(action: string, reportId: string) {
    setActionLoading(`${action}-${reportId}`);
    try {
      await fetch("/api/admin/marketplace/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reportId }),
      });
      await fetchReports();
    } finally {
      setActionLoading(null);
    }
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
          <Flag className="h-6 w-6 text-red-400" />
          <h1 className="text-2xl font-bold">Reports</h1>
          <span className="text-sm text-muted-foreground">({reports.length})</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchReports} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {STATUS_TABS.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "ghost"}
            size="sm"
            onClick={() => setStatusFilter(s)}
            className="text-xs"
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {/* Reports list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : reports.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No {statusFilter} reports</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reports.map((report) => (
            <div
              key={report.id}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Flag className="h-4 w-4 text-red-400 shrink-0" />
                  <span className="font-medium">{report.reason}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {report.itemId?.slice(0, 12)}...
                  </span>
                  {report.collection && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">
                      {report.collection}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {report.comment && <span className="mr-2">&quot;{report.comment}&quot;</span>}
                  by {report.reportedBy?.slice(0, 10)}...
                  {report.createdAt && (
                    <span className="ml-2">
                      {new Date(report.createdAt.seconds * 1000).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {report.resolution && (
                  <div className="text-xs mt-1 flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                      {report.resolution}
                    </span>
                    {report.resolutionNote && (
                      <span className="text-muted-foreground">{report.resolutionNote}</span>
                    )}
                    {report.resolvedAt && (
                      <span className="text-muted-foreground">
                        {new Date(report.resolvedAt.seconds * 1000).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {!report.resolution && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => reportAction("dismiss", report.id)}
                      disabled={actionLoading === `dismiss-${report.id}`}
                    >
                      {actionLoading === `dismiss-${report.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <XCircle className="h-3 w-3 mr-1" /> Dismiss
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reportAction("resolve", report.id)}
                      disabled={actionLoading === `resolve-${report.id}`}
                    >
                      {actionLoading === `resolve-${report.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <CheckCircle className="h-3 w-3 mr-1" /> Resolve
                        </>
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => reportAction("suspend_item", report.id)}
                      disabled={actionLoading === `suspend_item-${report.id}`}
                    >
                      {actionLoading === `suspend_item-${report.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <Ban className="h-3 w-3 mr-1" /> Suspend Item
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
