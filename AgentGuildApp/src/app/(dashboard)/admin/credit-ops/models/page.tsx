"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Plus, Play, CheckCircle, Undo2,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface Model {
  id: string;
  version: string;
  status: string;
  policyId: string;
  description: string;
  changelog: string;
  shadowModeEnabled: boolean;
  shadowResults?: {
    agentsSampled: number;
    avgCreditDivergence: number;
    avgTrustDivergence: number;
    maxCreditDivergence: number;
  };
  createdAt?: { seconds: number };
  activatedAt?: { seconds: number };
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  draft: "bg-amber-500/20 text-amber-400",
  shadow: "bg-purple-500/20 text-purple-400",
  deprecated: "bg-zinc-500/20 text-zinc-400",
  rolled_back: "bg-red-500/20 text-red-400",
};

export default function ModelsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/credit-ops/models");
      if (res.ok) { const d = await res.json(); setModels(d.items || []); }
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isAdmin) fetchModels(); }, [isAdmin, fetchModels]);

  async function modelAction(id: string, action: string) {
    setActionLoading(`${action}-${id}`);
    try {
      await fetch(`/api/admin/credit-ops/models/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await fetchModels();
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

  const activeModel = models.find((m) => m.status === "active");

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Model Rollout Controls</h1>
          <p className="text-sm text-muted-foreground mt-1">Score model versions, shadow mode, and rollback</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchModels} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Active model highlight */}
      {activeModel && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-emerald-400" />
            <div>
              <span className="font-medium">Active Model: v{activeModel.version}</span>
              <p className="text-xs text-muted-foreground">{activeModel.description}</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : models.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No models created yet</div>
      ) : (
        <div className="space-y-3">
          {models.map((m) => (
            <div key={m.id} className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-medium">v{m.version}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[m.status] || "bg-muted"}`}>
                    {m.status.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="flex gap-1">
                  {m.status === "draft" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => modelAction(m.id, "start_shadow")} disabled={!!actionLoading}>
                        <Play className="h-3 w-3 mr-1" /> Shadow
                      </Button>
                      <Button size="sm" onClick={() => modelAction(m.id, "promote")} disabled={!!actionLoading}>
                        <CheckCircle className="h-3 w-3 mr-1" /> Promote
                      </Button>
                    </>
                  )}
                  {m.status === "shadow" && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => modelAction(m.id, "compute_shadow")} disabled={!!actionLoading}>
                        Compute
                      </Button>
                      <Button size="sm" onClick={() => modelAction(m.id, "promote")} disabled={!!actionLoading}>
                        <CheckCircle className="h-3 w-3 mr-1" /> Promote
                      </Button>
                    </>
                  )}
                  {m.status === "active" && (
                    <Button size="sm" variant="destructive" onClick={() => modelAction(m.id, "rollback")} disabled={!!actionLoading}>
                      <Undo2 className="h-3 w-3 mr-1" /> Rollback
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-sm text-muted-foreground">{m.description}</p>

              {/* Shadow results */}
              {m.shadowResults && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="p-2 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground">Sampled</span>
                    <p className="font-mono text-sm">{m.shadowResults.agentsSampled}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground">Avg Credit Div</span>
                    <p className="font-mono text-sm">{m.shadowResults.avgCreditDivergence.toFixed(1)}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground">Avg Trust Div</span>
                    <p className="font-mono text-sm">{m.shadowResults.avgTrustDivergence.toFixed(1)}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground">Max Credit Div</span>
                    <p className="font-mono text-sm">{m.shadowResults.maxCreditDivergence.toFixed(1)}</p>
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                {m.createdAt && `Created: ${new Date(m.createdAt.seconds * 1000).toLocaleString()}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
