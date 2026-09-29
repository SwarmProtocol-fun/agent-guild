"use client";

import { useState, useEffect } from "react";
import { Search, Pin, PinOff, Trash2, Plus } from "lucide-react";
import type { MemoryEntry, MemoryScopeType } from "@/lib/compute/types";

interface MemoryEditorProps {
  scopeType: MemoryScopeType;
  scopeId: string;
}

export function MemoryEditor({ scopeType, scopeId }: MemoryEditorProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");

  const [error, setError] = useState("");

  const fetchEntries = async () => {
    try {
      setError("");
      const res = await fetch(`/api/compute/memory?scopeType=${scopeType}&scopeId=${scopeId}`);
      const data = await res.json();
      if (data.ok) setEntries(data.entries || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memory");
    }
    setLoading(false);
  };

  useEffect(() => { fetchEntries(); }, [scopeType, scopeId]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return fetchEntries();
    const res = await fetch("/api/compute/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeType, scopeId, query: searchQuery }),
    });
    const data = await res.json();
    if (data.ok) setEntries(data.entries);
  };

  const handleCreate = async () => {
    if (!newContent.trim()) return;
    const res = await fetch("/api/compute/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopeType,
        scopeId,
        content: newContent,
        tags: newTags ? newTags.split(",").map((t) => t.trim()) : [],
      }),
    });
    if (res.ok) { setNewContent(""); setNewTags(""); fetchEntries(); }
  };

  const handleTogglePin = async (entry: MemoryEntry) => {
    await fetch(`/api/compute/memory/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !entry.pinned }),
    });
    fetchEntries();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/compute/memory/${id}`, { method: "DELETE" });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading memory...</div>;
  }

  if (error) {
    return <div className="flex h-40 items-center justify-center text-sm text-red-400">{error}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search memory..."
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-sm"
          />
        </div>
        <button onClick={handleSearch} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">
          Search
        </button>
      </div>

      {/* Create */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Add a memory entry..."
          rows={2}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none"
        />
        <div className="flex items-center gap-2">
          <input
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            placeholder="Tags (comma-separated)"
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
          />
          <button
            onClick={handleCreate}
            disabled={!newContent.trim()}
            className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </div>
      </div>

      {/* Entries */}
      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">No memory entries</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-lg border p-3 ${entry.pinned ? "border-amber-500/30 bg-amber-500/5" : "border-border"}`}
            >
              <p className="text-sm whitespace-pre-wrap">{entry.content}</p>
              {entry.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex gap-1">
                <button
                  onClick={() => handleTogglePin(entry)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                  title={entry.pinned ? "Unpin" : "Pin"}
                >
                  {entry.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => handleDelete(entry.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
