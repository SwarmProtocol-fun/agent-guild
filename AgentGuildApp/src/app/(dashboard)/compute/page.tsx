"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Monitor, Plus, HardDrive, FolderKanban, LayoutGrid } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import type { Computer, Workspace, ComputeTemplate } from "@/lib/compute/types";
import { StatusBadge } from "@/components/compute/status-badge";

export default function ComputeOverview() {
  const { currentOrg } = useOrg();
  const [computers, setComputers] = useState<Computer[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<ComputeTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!currentOrg?.id) return;
    setError("");
    Promise.all([
      fetch(`/api/compute/computers?orgId=${currentOrg.id}`).then((r) => r.json()),
      fetch(`/api/compute/workspaces?orgId=${currentOrg.id}`).then((r) => r.json()),
      fetch("/api/compute/templates?isPublic=true").then((r) => r.json()),
    ])
      .then(([cData, wData, tData]) => {
        if (cData.ok) setComputers(cData.computers || []);
        if (wData.ok) setWorkspaces(wData.workspaces || []);
        if (tData.ok) setTemplates(tData.templates || []);
      })
      .catch((err) => setError(err.message || "Failed to load compute data"))
      .finally(() => setLoading(false));
  }, [currentOrg?.id]);

  const running = computers.filter((c) => c.status === "running").length;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-red-400">Failed to load compute data</p>
        <p className="text-xs text-muted-foreground">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Compute</h1>
          <p className="text-sm text-muted-foreground mt-1">Cloud desktops for humans and AI</p>
        </div>
        <Link
          href="/compute/computers/new"
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Computer
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Monitor className="h-4 w-4" />
            <span className="text-xs">Running</span>
          </div>
          <p className="mt-2 text-2xl font-bold">{running}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            <span className="text-xs">Total</span>
          </div>
          <p className="mt-2 text-2xl font-bold">{computers.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FolderKanban className="h-4 w-4" />
            <span className="text-xs">Workspaces</span>
          </div>
          <p className="mt-2 text-2xl font-bold">{workspaces.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <LayoutGrid className="h-4 w-4" />
            <span className="text-xs">Templates</span>
          </div>
          <p className="mt-2 text-2xl font-bold">{templates.length}</p>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Link href="/compute/computers/new" className="rounded-lg border border-border p-3 text-center text-sm hover:bg-muted transition-colors">
          New Computer
        </Link>
        <Link href="/compute/templates" className="rounded-lg border border-border p-3 text-center text-sm hover:bg-muted transition-colors">
          Browse Templates
        </Link>
        <Link href="/compute/workspaces" className="rounded-lg border border-border p-3 text-center text-sm hover:bg-muted transition-colors">
          Manage Workspaces
        </Link>
        <Link href="/compute/sessions" className="rounded-lg border border-border p-3 text-center text-sm hover:bg-muted transition-colors">
          Session History
        </Link>
      </div>

      {/* Recent computers */}
      {computers.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Recent Computers</h2>
          <div className="divide-y divide-border rounded-lg border border-border">
            {computers.slice(0, 5).map((c) => (
              <Link
                key={c.id}
                href={`/compute/computers/${c.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Monitor className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{c.controllerType} · {c.region}</p>
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Featured templates */}
      {templates.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Featured Templates</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {templates.slice(0, 4).map((t) => (
              <Link
                key={t.id}
                href={`/compute/templates/${t.id}`}
                className="rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors"
              >
                <p className="text-sm font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.description}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
