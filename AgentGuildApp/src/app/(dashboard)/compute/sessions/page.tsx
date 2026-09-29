"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/contexts/OrgContext";
import type { ComputerSession, Workspace } from "@/lib/compute/types";
import { SessionTimeline } from "@/components/compute/session-timeline";

export default function SessionsPage() {
  const { currentOrg } = useOrg();
  const [sessions, setSessions] = useState<ComputerSession[]>([]);
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

  useEffect(() => {
    if (!selectedWorkspace) return;
    fetch(`/api/compute/sessions?workspaceId=${selectedWorkspace}`)
      .then((r) => r.json())
      .then((data) => { if (data.ok) setSessions(data.sessions || []); })
      .catch((err) => setError(err.message || "Failed to load sessions"));
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
        <h1 className="text-2xl font-bold">Sessions</h1>
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

      <SessionTimeline sessions={sessions} />
    </div>
  );
}
