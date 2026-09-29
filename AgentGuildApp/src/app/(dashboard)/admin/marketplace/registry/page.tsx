"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Database, Pencil, Trash2,
  Star, StarOff, Package, Search, Download, X, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface VerifiedItem {
  id: string;
  name: string;
  description: string;
  type: string;
  category: string;
  icon: string;
  version: string;
  author: string;
  tags: string[];
  pricing: { model: string; tiers?: { plan: string; price: number; currency: string }[] };
  featured: boolean;
  enabled: boolean;
  installCount: number;
  avgRating: number;
  ratingCount: number;
}

const TYPE_COLORS: Record<string, string> = {
  mod: "bg-purple-500/20 text-purple-300",
  plugin: "bg-blue-500/20 text-blue-300",
  skill: "bg-green-500/20 text-green-300",
  skin: "bg-amber-500/20 text-amber-300",
  agent: "bg-cyan-500/20 text-cyan-300",
};

export default function RegistryPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [items, setItems] = useState<VerifiedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [editItem, setEditItem] = useState<VerifiedItem | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string; description: string; version: string;
    category: string; tags: string; featured: boolean; enabled: boolean;
    pricingModel: string;
  }>({ name: "", description: "", version: "", category: "", tags: "", featured: false, enabled: true, pricingModel: "free" });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      const res = await fetch(`/api/admin/marketplace/registry?${params}`);
      if (res.ok) {
        const d = await res.json();
        setItems(d.items || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin, fetchData]);

  async function handleSeed() {
    setActionLoading("seed");
    try {
      const res = await fetch("/api/admin/marketplace/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      if (res.ok) {
        await fetchData();
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleToggleFeatured(item: VerifiedItem) {
    setActionLoading(`featured-${item.id}`);
    try {
      await fetch("/api/admin/marketplace/registry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, updates: { featured: !item.featured } }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleToggleEnabled(item: VerifiedItem) {
    setActionLoading(`enabled-${item.id}`);
    try {
      await fetch("/api/admin/marketplace/registry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, updates: { enabled: !item.enabled } }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`Delete verified item "${id}"? It can be re-seeded later.`)) return;
    setActionLoading(`delete-${id}`);
    try {
      await fetch("/api/admin/marketplace/registry", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await fetchData();
    } finally {
      setActionLoading(null);
    }
  }

  function openEditDialog(item: VerifiedItem) {
    setEditItem(item);
    setEditForm({
      name: item.name,
      description: item.description,
      version: item.version,
      category: item.category,
      tags: item.tags.join(", "),
      featured: item.featured,
      enabled: item.enabled,
      pricingModel: item.pricing.model,
    });
  }

  async function handleSaveEdit() {
    if (!editItem) return;
    setActionLoading(`edit-${editItem.id}`);
    try {
      const updates: Record<string, unknown> = {};
      if (editForm.name !== editItem.name) updates.name = editForm.name;
      if (editForm.description !== editItem.description) updates.description = editForm.description;
      if (editForm.version !== editItem.version) updates.version = editForm.version;
      if (editForm.category !== editItem.category) updates.category = editForm.category;
      if (editForm.featured !== editItem.featured) updates.featured = editForm.featured;
      if (editForm.enabled !== editItem.enabled) updates.enabled = editForm.enabled;

      const newTags = editForm.tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (JSON.stringify(newTags) !== JSON.stringify(editItem.tags)) updates.tags = newTags;

      if (Object.keys(updates).length > 0) {
        await fetch("/api/admin/marketplace/registry", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editItem.id, updates }),
        });
        await fetchData();
      }
      setEditItem(null);
    } finally {
      setActionLoading(null);
    }
  }

  // Filter items by search
  const filtered = items.filter((item) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!item.name.toLowerCase().includes(q) &&
          !item.id.toLowerCase().includes(q) &&
          !item.tags.some((t) => t.toLowerCase().includes(q))) {
        return false;
      }
    }
    return true;
  });

  // Stat counts
  const typeCounts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.type] = (acc[i.type] || 0) + 1;
    return acc;
  }, {});

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Database className="h-6 w-6 text-blue-400" />
          <h1 className="text-2xl font-bold">Verified Registry</h1>
          <span className="text-sm text-muted-foreground">({items.length} items)</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={handleSeed} disabled={actionLoading === "seed"}>
            {actionLoading === "seed" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
            Seed from Code
          </Button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="border-border">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold">{items.length}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </CardContent>
        </Card>
        {["mod", "plugin", "skill", "skin"].map((t) => (
          <Card key={t} className="border-border">
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold">{typeCounts[t] || 0}</p>
              <p className="text-xs text-muted-foreground capitalize">{t}s</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-background text-sm"
            placeholder="Search by name, id, or tag..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <select
          className="px-3 py-2 rounded-md border border-border bg-background text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All Types</option>
          <option value="mod">Mods</option>
          <option value="plugin">Plugins</option>
          <option value="skill">Skills</option>
          <option value="skin">Skins</option>
        </select>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <Card className="border-border">
          <CardContent className="p-8 text-center">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-lg font-semibold mb-1">No verified items in Firestore</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Click &quot;Seed from Code&quot; to populate the registry from the static SKILL_REGISTRY.
            </p>
            <Button onClick={handleSeed} disabled={actionLoading === "seed"}>
              {actionLoading === "seed" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Seed Registry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Items Table */}
      {!loading && filtered.length > 0 && (
        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              {filtered.length} item{filtered.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2">Item</th>
                    <th className="text-left px-4 py-2">Type</th>
                    <th className="text-left px-4 py-2">Category</th>
                    <th className="text-left px-4 py-2">Version</th>
                    <th className="text-left px-4 py-2">Pricing</th>
                    <th className="text-center px-4 py-2">Featured</th>
                    <th className="text-center px-4 py-2">Enabled</th>
                    <th className="text-right px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.id} className={`border-b border-border/50 hover:bg-muted/20 ${!item.enabled ? "opacity-50" : ""}`}>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{item.icon}</span>
                          <div>
                            <p className="font-medium">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{item.id}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge className={`text-xs ${TYPE_COLORS[item.type] || ""}`}>{item.type}</Badge>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{item.category}</td>
                      <td className="px-4 py-2 font-mono text-xs">{item.version}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">{item.pricing.model}</Badge>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleFeatured(item)}
                          disabled={actionLoading === `featured-${item.id}`}
                        >
                          {item.featured
                            ? <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
                            : <StarOff className="h-4 w-4 text-muted-foreground" />}
                        </Button>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleEnabled(item)}
                          disabled={actionLoading === `enabled-${item.id}`}
                        >
                          <span className={`inline-block w-2 h-2 rounded-full ${item.enabled ? "bg-green-400" : "bg-red-400"}`} />
                        </Button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex gap-1 justify-end">
                          <Button variant="ghost" size="sm" onClick={() => openEditDialog(item)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(item.id)}
                            disabled={actionLoading === `delete-${item.id}`}
                            className="text-red-400 hover:text-red-300"
                          >
                            {actionLoading === `delete-${item.id}`
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog (modal overlay) */}
      {editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <Card className="w-full max-w-lg border-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Edit: {editItem.name}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setEditItem(null)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Name</label>
                <input
                  className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Description</label>
                <textarea
                  className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm h-20 resize-none"
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">Version</label>
                  <input
                    className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                    value={editForm.version}
                    onChange={(e) => setEditForm({ ...editForm, version: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Category</label>
                  <input
                    className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                    value={editForm.category}
                    onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Tags (comma-separated)</label>
                <input
                  className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                  value={editForm.tags}
                  onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editForm.featured}
                    onChange={(e) => setEditForm({ ...editForm, featured: e.target.checked })}
                  />
                  Featured
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
                  />
                  Enabled
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => setEditItem(null)}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={handleSaveEdit}
                  disabled={actionLoading === `edit-${editItem.id}`}
                >
                  {actionLoading === `edit-${editItem.id}`
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <Pencil className="h-4 w-4 mr-2" />}
                  Save Changes
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
