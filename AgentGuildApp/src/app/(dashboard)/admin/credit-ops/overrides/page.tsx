"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, ArrowUpDown, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface OverrideItem {
  id: string;
  agentId: string;
  asn: string;
  overrideType: string;
  previousCreditScore: number;
  previousTrustScore: number;
  newCreditScore: number;
  newTrustScore: number;
  creditDelta: number;
  trustDelta: number;
  reason: string;
  approvalStatus: string;
  rolledBack: boolean;
  expired: boolean;
  requestedBy: string;
  createdAt?: { seconds: number };
  appliedAt?: { seconds: number };
}

const STATUS_FILTER_OPTIONS = ["all", "pending", "approved", "rejected"] as const;

const APPROVAL_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  approved: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
};

export default function OverridesPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<OverrideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const fetchOverrides = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("approvalStatus", statusFilter);
      const res = await fetch(`/api/admin/credit-ops/overrides?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (isAdmin) fetchOverrides();
  }, [isAdmin, fetchOverrides]);

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
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Score Overrides</h1>
          <p className="text-sm text-muted-foreground mt-1">Manual score adjustments with audit trail</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchOverrides} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {STATUS_FILTER_OPTIONS.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "ghost"}
            size="sm"
            onClick={() => setStatusFilter(s)}
            className="text-xs"
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No overrides found</p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="flex-1">Agent</span>
            <span className="w-20">Type</span>
            <span className="w-32">Score Change</span>
            <span className="w-20">Status</span>
            <span className="w-20">State</span>
            <span className="w-24">Date</span>
          </div>

          {items.map((item) => (
            <Link
              key={item.id}
              href={`/admin/credit-ops/overrides/${item.id}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{item.asn || item.agentId}</p>
                <p className="text-xs text-muted-foreground truncate">{item.reason}</p>
              </div>
              <span className="w-20">
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted">
                  {item.overrideType}
                </span>
              </span>
              <span className="w-32 font-mono text-xs">
                <span className={item.creditDelta >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {item.creditDelta >= 0 ? "+" : ""}{item.creditDelta} C
                </span>
                {" / "}
                <span className={item.trustDelta >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {item.trustDelta >= 0 ? "+" : ""}{item.trustDelta} T
                </span>
              </span>
              <span className="w-20">
                <span className={`text-xs px-1.5 py-0.5 rounded ${APPROVAL_COLORS[item.approvalStatus] || "bg-muted"}`}>
                  {item.approvalStatus}
                </span>
              </span>
              <span className="w-20">
                {item.rolledBack ? (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 flex items-center gap-1">
                    <Undo2 className="h-3 w-3" /> Rolled back
                  </span>
                ) : item.expired ? (
                  <span className="text-xs text-muted-foreground">Expired</span>
                ) : item.approvalStatus === "approved" ? (
                  <span className="text-xs text-emerald-400">Applied</span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </span>
              <span className="w-24 text-xs text-muted-foreground">
                {item.createdAt
                  ? new Date(item.createdAt.seconds * 1000).toLocaleDateString()
                  : "—"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
