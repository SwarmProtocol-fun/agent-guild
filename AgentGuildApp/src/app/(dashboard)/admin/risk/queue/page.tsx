"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, AlertTriangle, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface ReviewCase {
  id: string;
  agentId: string;
  agentName: string;
  asn: string;
  riskScore: number;
  riskTier: string;
  severity: string;
  status: string;
  triggerReason: string;
  createdAt?: { seconds: number };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  medium: "bg-amber-500/20 text-amber-400 border-amber-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  investigating: "bg-blue-500/20 text-blue-400",
  resolved_clean: "bg-emerald-500/20 text-emerald-400",
  resolved_penalized: "bg-orange-500/20 text-orange-400",
  resolved_banned: "bg-red-500/20 text-red-400",
};

export default function RiskQueuePage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [cases, setCases] = useState<ReviewCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("pending");

  const fetchCases = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/risk/queue?${params}`);
      if (res.ok) {
        const d = await res.json();
        setCases(d.cases || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (isAdmin) fetchCases();
  }, [isAdmin, fetchCases]);

  if (!authenticated || !isAdmin) {
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Fraud Review Queue</h1>
          <p className="text-sm text-muted-foreground">{cases.length} cases</p>
        </div>
        <div className="flex gap-2">
          <select
            className="bg-muted border border-border rounded px-3 py-1.5 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="investigating">Investigating</option>
            <option value="resolved_clean">Resolved (Clean)</option>
            <option value="resolved_penalized">Resolved (Penalized)</option>
            <option value="resolved_banned">Resolved (Banned)</option>
          </select>
          <Button variant="outline" size="sm" onClick={fetchCases} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : cases.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <AlertTriangle className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">No cases found</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Agent</th>
                <th className="text-left p-3 font-medium">Risk Score</th>
                <th className="text-left p-3 font-medium">Severity</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Reason</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cases.map((c) => (
                <tr key={c.id} className="hover:bg-muted/30">
                  <td className="p-3">
                    <div className="font-medium">{c.agentName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.asn || c.agentId.slice(0, 12)}</div>
                  </td>
                  <td className="p-3">
                    <span className={`font-bold ${
                      c.riskScore >= 80 ? "text-red-400" :
                      c.riskScore >= 60 ? "text-orange-400" :
                      c.riskScore >= 40 ? "text-amber-400" :
                      "text-blue-400"
                    }`}>
                      {c.riskScore}
                    </span>
                    <span className="text-xs text-muted-foreground ml-1">/ 100</span>
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs border ${SEVERITY_COLORS[c.severity] || ""}`}>
                      {c.severity}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[c.status] || ""}`}>
                      {c.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className="text-xs text-muted-foreground line-clamp-2">{c.triggerReason}</span>
                  </td>
                  <td className="p-3 text-right">
                    <Link href={`/admin/risk/queue/${c.id}`}>
                      <Button variant="ghost" size="sm">
                        <Eye className="h-4 w-4 mr-1" />
                        Review
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
