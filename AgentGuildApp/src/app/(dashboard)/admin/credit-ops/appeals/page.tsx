"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ShieldAlert, Loader2, RefreshCw, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Appeal {
  id: string;
  agentId: string;
  asn: string;
  appealType: string;
  subject: string;
  status: string;
  priority: string;
  submittedAt?: { seconds: number };
}

const STATUS_OPTIONS = ["all", "submitted", "under_review", "resolved", "rejected"] as const;
const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-amber-500/20 text-amber-400",
  under_review: "bg-blue-500/20 text-blue-400",
  additional_info_requested: "bg-purple-500/20 text-purple-400",
  resolved: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  escalated: "bg-red-600/20 text-red-500",
};
const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  high: "bg-amber-500/20 text-amber-400",
  medium: "bg-blue-500/20 text-blue-400",
  low: "bg-zinc-500/20 text-zinc-400",
};

export default function AppealsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<Appeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [stats, setStats] = useState<Record<string, number> | null>(null);

  const fetchAppeals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ stats: "true" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/admin/credit-ops/appeals?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
        if (d.stats) setStats(d.stats);
      }
    } catch { /* silent */ } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { if (isAdmin) fetchAppeals(); }, [isAdmin, fetchAppeals]);

  if (!authenticated || !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold">Appeals</h1>
            <p className="text-sm text-muted-foreground mt-1">Agent penalty appeals and review</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAppeals} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="flex gap-4">
          {Object.entries(stats).filter(([k]) => k !== "total").map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{key.replace(/_/g, " ")}:</span>
              <span className="text-sm font-bold">{val}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {STATUS_OPTIONS.map((s) => (
          <Button key={s} variant={statusFilter === s ? "default" : "ghost"} size="sm"
            onClick={() => setStatusFilter(s)} className="text-xs">
            {s === "all" ? "All" : s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No appeals found</div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="flex-1">Subject</span>
            <span className="w-20">Type</span>
            <span className="w-20">Priority</span>
            <span className="w-24">Status</span>
            <span className="w-24">Submitted</span>
          </div>
          {items.map((item) => (
            <Link key={item.id} href={`/admin/credit-ops/appeals/${item.id}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{item.subject}</p>
                <span className="text-xs text-muted-foreground">{item.asn || item.agentId}</span>
              </div>
              <span className="w-20 text-xs">{item.appealType.replace(/_/g, " ")}</span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority] || "bg-muted"}`}>{item.priority}</span>
              </span>
              <span className="w-24">
                <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted"}`}>{item.status.replace(/_/g, " ")}</span>
              </span>
              <span className="w-24 text-xs text-muted-foreground">
                {item.submittedAt ? new Date(item.submittedAt.seconds * 1000).toLocaleDateString() : "\u2014"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
