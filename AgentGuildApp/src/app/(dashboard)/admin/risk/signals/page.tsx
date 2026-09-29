"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, AlertTriangle, Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Signal {
  id: string;
  agentId: string;
  asn: string;
  orgId: string;
  signalType: string;
  severity: string;
  confidence: number;
  status: string;
  evidence: {
    description: string;
    metric?: number;
    threshold?: number;
    counterpartyIds?: string[];
  };
  createdAt?: { seconds: number };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  high: "bg-orange-500/20 text-orange-400",
  medium: "bg-amber-500/20 text-amber-400",
  low: "bg-blue-500/20 text-blue-400",
};

const SIGNAL_TYPES = [
  "self_deal_loop", "trust_ring", "spam_task_farming", "wash_settlement",
  "repetitive_low_value", "graph_concentration", "identity_reset",
  "velocity_anomaly", "cross_validation_abuse",
];

export default function SignalExplorerPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (severityFilter) params.set("severity", severityFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/risk/signals?${params}`);
      if (res.ok) {
        const d = await res.json();
        setSignals(d.signals || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [typeFilter, severityFilter, statusFilter]);

  useEffect(() => {
    if (isAdmin) fetchSignals();
  }, [isAdmin, fetchSignals]);

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
          <h1 className="text-2xl font-bold">Signal Explorer</h1>
          <p className="text-sm text-muted-foreground">{signals.length} signals</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSignals} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <select
          className="bg-muted border border-border rounded px-3 py-1.5 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All Types</option>
          {SIGNAL_TYPES.map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
          ))}
        </select>
        <select
          className="bg-muted border border-border rounded px-3 py-1.5 text-sm"
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          className="bg-muted border border-border rounded px-3 py-1.5 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="dismissed">Dismissed</option>
          <option value="penalized">Penalized</option>
          <option value="escalated">Escalated</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : signals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <AlertTriangle className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">No signals found</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Type</th>
                <th className="text-left p-3 font-medium">Agent</th>
                <th className="text-left p-3 font-medium">Severity</th>
                <th className="text-left p-3 font-medium">Confidence</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {signals.map((s) => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="p-3">
                    <span className="font-mono text-xs">{s.signalType.replace(/_/g, " ")}</span>
                  </td>
                  <td className="p-3">
                    <div className="font-mono text-xs">{s.asn || s.agentId.slice(0, 12)}</div>
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${SEVERITY_COLORS[s.severity] || ""}`}>
                      {s.severity}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-400 rounded-full"
                          style={{ width: `${s.confidence * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{(s.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="text-xs capitalize">{s.status}</span>
                  </td>
                  <td className="p-3">
                    <span className="text-xs text-muted-foreground line-clamp-2">{s.evidence.description}</span>
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
