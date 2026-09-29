"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/contexts/OrgContext";
import type { Workspace, UsageSummary } from "@/lib/compute/types";
import { SIZE_PRESETS, type SizeKey } from "@/lib/compute/types";
import { estimateHourlyCost, estimateMonthlyCost } from "@/lib/compute/pricing";
import { UsageChart } from "@/components/compute/usage-chart";

export default function UsagePage() {
  const { currentOrg } = useOrg();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [summary, setSummary] = useState<UsageSummary>({
    totalComputeHours: 0,
    totalStorageGb: 0,
    totalActions: 0,
    totalSessions: 0,
    estimatedCostCents: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!currentOrg?.id) return;
    setError("");
    fetch(`/api/compute/workspaces?orgId=${currentOrg.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.workspaces?.length > 0) {
          setWorkspaces(data.workspaces);
          setSelectedWorkspace(data.workspaces[0].id);
        }
      })
      .catch((err) => setError(err.message || "Failed to load workspaces"))
      .finally(() => setLoading(false));
  }, [currentOrg?.id]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    fetch(`/api/compute/usage?workspaceId=${selectedWorkspace}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.summary) setSummary(data.summary);
      })
      .catch((err) => setError(err.message || "Failed to load usage data"));
  }, [selectedWorkspace]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Usage & Billing</h1>
        {workspaces.length > 1 && (
          <select
            value={selectedWorkspace}
            onChange={(e) => setSelectedWorkspace(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        )}
      </div>

      <UsageChart summary={summary} />

      {/* Pricing Rates Reference */}
      <div className="mt-6">
        <h2 className="text-sm font-medium mb-3">Pricing Rates</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.entries(SIZE_PRESETS) as [SizeKey, typeof SIZE_PRESETS[SizeKey]][]).map(
            ([key, preset]) => {
              const hourly = estimateHourlyCost(key);
              const monthly = estimateMonthlyCost(key, 8);
              return (
                <div key={key} className="rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">{preset.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">{preset.disk} GB disk</p>
                  <div className="mt-3 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Hourly</span>
                      <span className="font-medium">${(hourly / 100).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Monthly (8h/day)</span>
                      <span className="font-medium">${(monthly / 100).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              );
            },
          )}
        </div>
      </div>
    </div>
  );
}
