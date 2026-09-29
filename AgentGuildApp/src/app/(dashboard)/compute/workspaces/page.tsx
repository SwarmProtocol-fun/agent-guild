"use client";

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import type { Workspace } from "@/lib/compute/types";
const trackComputeEvent = (..._args: unknown[]) => {}; // posthog removed
import { WorkspaceCard } from "@/components/compute/workspace-card";

export default function WorkspacesPage() {
  const { currentOrg } = useOrg();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const loadWorkspaces = () => {
    if (!currentOrg?.id) return;
    setError("");
    fetch(`/api/compute/workspaces?orgId=${currentOrg.id}`)
      .then((r) => r.json())
      .then((data) => { if (data.ok) setWorkspaces(data.workspaces || []); })
      .catch((err) => setError(err.message || "Failed to load workspaces"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadWorkspaces(); }, [currentOrg?.id]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch("/api/compute/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: currentOrg?.id, name: newName, description: newDesc }),
      });
      if (res.ok) {
        trackComputeEvent("workspace_created", { name: newName });
        setShowCreate(false);
        setNewName("");
        setNewDesc("");
        loadWorkspaces();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to create workspace");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error && workspaces.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={() => { setLoading(true); loadWorkspaces(); }} className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Workspaces</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Workspace
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Workspace name"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {workspaces.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground">No workspaces yet</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <WorkspaceCard key={ws.id} workspace={ws} />
          ))}
        </div>
      )}
    </div>
  );
}
