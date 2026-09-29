"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Plus, CheckCircle, FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Policy {
  id: string;
  version: number;
  status: string;
  description?: string;
  tierBoundaries: { platinum: number; gold: number; silver: number };
  eventWeights: Record<string, { credit: number; trust: number }>;
  slashingRules: Record<string, { credit: number; trust: number; hoursThreshold?: number }> & { governanceThreshold?: number };
  createdAt?: { seconds: number };
  activatedAt?: { seconds: number };
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  draft: "bg-amber-500/20 text-amber-400",
  archived: "bg-zinc-500/20 text-zinc-400",
};

export default function PoliciesPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/credit-ops/policies");
      if (res.ok) {
        const d = await res.json();
        setPolicies(d.items || []);
      }
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isAdmin) fetchPolicies(); }, [isAdmin, fetchPolicies]);

  async function createDraft() {
    setActionLoading("create");
    try {
      await fetch("/api/admin/credit-ops/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "New draft policy" }),
      });
      await fetchPolicies();
    } finally { setActionLoading(null); }
  }

  async function activatePolicy(id: string) {
    setActionLoading(`activate-${id}`);
    try {
      await fetch(`/api/admin/credit-ops/policies/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate" }),
      });
      await fetchPolicies();
    } finally { setActionLoading(null); }
  }

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
        <div>
          <h1 className="text-2xl font-bold">Policy Configuration</h1>
          <p className="text-sm text-muted-foreground mt-1">Scoring rules, tier boundaries, and slashing parameters</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={createDraft} disabled={!!actionLoading}>
            <Plus className="h-4 w-4 mr-2" /> New Draft
          </Button>
          <Button variant="outline" size="sm" onClick={fetchPolicies} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : policies.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No policies configured</div>
      ) : (
        <div className="space-y-4">
          {policies.map((p) => (
            <div key={p.id} className={`rounded-xl border p-4 space-y-3 ${
              p.status === "active" ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-card/50"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <span className="font-medium">v{p.version}</span>
                    <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[p.status] || "bg-muted"}`}>
                      {p.status}
                    </span>
                  </div>
                </div>
                {p.status === "draft" && (
                  <Button size="sm" onClick={() => activatePolicy(p.id)} disabled={!!actionLoading}>
                    <CheckCircle className="h-3 w-3 mr-1" /> Activate
                  </Button>
                )}
              </div>

              {p.description && (
                <p className="text-sm text-muted-foreground">{p.description}</p>
              )}

              {/* Tier boundaries */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-2 rounded-lg bg-muted/30">
                  <span className="text-xs text-muted-foreground">Platinum</span>
                  <p className="font-mono text-sm">{p.tierBoundaries?.platinum}</p>
                </div>
                <div className="p-2 rounded-lg bg-muted/30">
                  <span className="text-xs text-muted-foreground">Gold</span>
                  <p className="font-mono text-sm">{p.tierBoundaries?.gold}</p>
                </div>
                <div className="p-2 rounded-lg bg-muted/30">
                  <span className="text-xs text-muted-foreground">Silver</span>
                  <p className="font-mono text-sm">{p.tierBoundaries?.silver}</p>
                </div>
              </div>

              {/* Event weights */}
              {p.eventWeights && (
                <div>
                  <h4 className="text-xs text-muted-foreground mb-2">Event Weights</h4>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    {Object.entries(p.eventWeights).map(([key, val]) => (
                      <div key={key} className="p-2 rounded-lg bg-muted/30">
                        <span className="text-xs text-muted-foreground">{key.replace(/_/g, " ")}</span>
                        <p className="font-mono text-xs">
                          C:{val.credit >= 0 ? "+" : ""}{val.credit} T:{val.trust >= 0 ? "+" : ""}{val.trust}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                {p.activatedAt && `Activated: ${new Date(p.activatedAt.seconds * 1000).toLocaleString()}`}
                {p.createdAt && !p.activatedAt && `Created: ${new Date(p.createdAt.seconds * 1000).toLocaleString()}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
