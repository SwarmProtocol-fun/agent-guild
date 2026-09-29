"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import type { Workspace, EmbedToken, Computer } from "@/lib/compute/types";
import { EmbedSnippet } from "@/components/compute/embed-snippet";

export default function EmbedsPage() {
  const { currentOrg } = useOrg();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [tokens, setTokens] = useState<EmbedToken[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const [selectedComputer, setSelectedComputer] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<"read_only" | "interactive">("read_only");
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
    Promise.all([
      fetch(`/api/compute/embeds?workspaceId=${selectedWorkspace}`).then((r) => r.json()),
      fetch(`/api/compute/computers?workspaceId=${selectedWorkspace}`).then((r) => r.json()),
    ]).then(([eData, cData]) => {
      if (eData.ok) setTokens(eData.tokens || []);
      if (cData.ok) {
        setComputers(cData.computers || []);
        if (cData.computers?.length > 0) setSelectedComputer(cData.computers[0].id);
      }
    }).catch((err) => setError(err.message || "Failed to load embed data"));
  }, [selectedWorkspace]);

  const handleCreate = async () => {
    if (!selectedComputer) return;
    const res = await fetch("/api/compute/embeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: selectedWorkspace,
        computerId: selectedComputer,
        mode,
      }),
    });
    if (res.ok) {
      setShowCreate(false);
      const data = await fetch(`/api/compute/embeds?workspaceId=${selectedWorkspace}`).then((r) => r.json());
      if (data.ok) setTokens(data.tokens);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/compute/embeds/${id}`, { method: "DELETE" });
    setTokens((prev) => prev.filter((t) => t.id !== id));
  };

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
        <h1 className="text-2xl font-bold">Embeds</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Embed Token
        </button>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Computer</label>
              <select
                value={selectedComputer}
                onChange={(e) => setSelectedComputer(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {computers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "read_only" | "interactive")}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="read_only">Read Only</option>
                <option value="interactive">Interactive</option>
              </select>
            </div>
          </div>
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

      {tokens.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground">No embed tokens yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {tokens.map((token) => (
            <div key={token.id} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium font-mono">{token.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {token.mode} · Computer: {token.computerId.slice(0, 8)}...
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(token.id)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <EmbedSnippet tokenId={token.id} mode={token.mode} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
