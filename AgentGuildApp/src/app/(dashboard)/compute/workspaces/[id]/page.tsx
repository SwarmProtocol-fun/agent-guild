"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { Workspace, Computer } from "@/lib/compute/types";
import { ComputerCard } from "@/components/compute/computer-card";
import { FileBrowser } from "@/components/compute/file-browser";
import { MemoryEditor } from "@/components/compute/memory-editor";

export default function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    Promise.all([
      fetch(`/api/compute/workspaces/${id}`).then((r) => r.json()),
      fetch(`/api/compute/computers?workspaceId=${id}`).then((r) => r.json()),
    ])
      .then(([wsData, cData]) => {
        if (wsData.ok) setWorkspace(wsData.workspace);
        else setError(wsData.error || "Workspace not found");
        if (cData.ok) setComputers(cData.computers || []);
      })
      .catch((err) => setError(err.message || "Failed to load workspace"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-red-400">{error || "Workspace not found"}</p>
        <Link href="/compute/workspaces" className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Back to Workspaces</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/compute/workspaces" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
          <ChevronLeft className="h-3 w-3" />
          Workspaces
        </Link>
        <h1 className="text-2xl font-bold">{workspace.name}</h1>
        {workspace.description && (
          <p className="text-sm text-muted-foreground mt-1">{workspace.description}</p>
        )}
      </div>

      <Tabs defaultValue="computers">
        <TabsList>
          <TabsTrigger value="computers">Computers</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
        </TabsList>

        <TabsContent value="computers">
          {computers.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border">
              <p className="text-sm text-muted-foreground">No computers in this workspace</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {computers.map((c) => (
                <ComputerCard key={c.id} computer={c} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="files">
          <FileBrowser workspaceId={id} />
        </TabsContent>

        <TabsContent value="memory">
          <MemoryEditor scopeType="workspace" scopeId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
