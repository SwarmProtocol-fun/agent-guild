"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/contexts/OrgContext";
import type { Workspace } from "@/lib/compute/types";
import { FileBrowser } from "@/components/compute/file-browser";

export default function FilesPage() {
  const { currentOrg } = useOrg();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
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
        <h1 className="text-2xl font-bold">Files</h1>
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

      {selectedWorkspace ? (
        <FileBrowser workspaceId={selectedWorkspace} />
      ) : (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground">Create a workspace first</p>
        </div>
      )}
    </div>
  );
}
