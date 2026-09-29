"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ShieldAlert, Loader2, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Dispute {
  id: string;
  initiatorId: string;
  respondentId: string;
  disputeType: string;
  subject: string;
  status: string;
  priority: string;
  filedAt?: { seconds: number };
}

const STATUS_OPTIONS = ["all", "filed", "investigating", "mediation", "adjudicated", "closed"] as const;
const STATUS_COLORS: Record<string, string> = {
  filed: "bg-amber-500/20 text-amber-400",
  investigating: "bg-blue-500/20 text-blue-400",
  mediation: "bg-purple-500/20 text-purple-400",
  adjudicated: "bg-emerald-500/20 text-emerald-400",
  closed: "bg-zinc-500/20 text-zinc-400",
};

export default function DisputesPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const fetchDisputes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/admin/credit-ops/disputes?${params}`);
      if (res.ok) { const d = await res.json(); setItems(d.items || []); }
    } catch { /* silent */ } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { if (isAdmin) fetchDisputes(); }, [isAdmin, fetchDisputes]);

  if (!authenticated || !isAdmin) {
    return (<div className="flex flex-col items-center justify-center h-[60vh] gap-3"><ShieldAlert className="h-12 w-12 text-red-400" /><h2 className="text-lg font-semibold">Access Denied</h2></div>);
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-amber-400" />
          <div>
            <h1 className="text-2xl font-bold">Disputes</h1>
            <p className="text-sm text-muted-foreground mt-1">Inter-party credit dispute adjudication</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDisputes} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {STATUS_OPTIONS.map((s) => (
          <Button key={s} variant={statusFilter === s ? "default" : "ghost"} size="sm"
            onClick={() => setStatusFilter(s)} className="text-xs">
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No disputes found</div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span className="flex-1">Subject</span>
            <span className="w-20">Type</span>
            <span className="w-24">Status</span>
            <span className="w-24">Filed</span>
          </div>
          {items.map((item) => (
            <Link key={item.id} href={`/admin/credit-ops/disputes/${item.id}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{item.subject}</p>
                <span className="text-xs text-muted-foreground">{item.initiatorId} vs {item.respondentId}</span>
              </div>
              <span className="w-20 text-xs">{item.disputeType.replace(/_/g, " ")}</span>
              <span className="w-24">
                <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted"}`}>{item.status}</span>
              </span>
              <span className="w-24 text-xs text-muted-foreground">
                {item.filedAt ? new Date(item.filedAt.seconds * 1000).toLocaleDateString() : "\u2014"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
