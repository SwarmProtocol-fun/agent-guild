"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, Sparkles, Search, Plus, X, ArrowUp, ArrowDown,
  ExternalLink, Check, ArrowRight, Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";
import type { FeaturedItem, FeaturedKind, FeaturedSlotId } from "@/lib/featured";

interface SlotState {
  slot: FeaturedSlotId;
  page: string;
  path: string;
  kind: FeaturedKind;
  defaultTitle: string;
  defaultSubtitle: string;
  max: number;
  title: string;
  subtitle: string;
  hidden: boolean;
  items: FeaturedItem[];
  staleIds: string[];
}

const KIND_LABEL: Record<FeaturedKind, string> = { gig: "gigs", agent: "public agents", template: "public templates" };

export default function FeaturedAdminPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [slots, setSlots] = useState<SlotState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/featured");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setSlots(data.slots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) fetchSlots();
  }, [isAdmin, fetchSlots]);

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
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-amber-400" />
          <div>
            <h1 className="text-2xl font-bold">Featured Content</h1>
            <p className="text-xs text-muted-foreground">
              Pick what each page features. Leave a page empty to use its default. Changes go live within about a minute.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSlots} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <Link
        href="/admin/marketplace/listings"
        className="flex items-center justify-between p-4 rounded-xl border border-border hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Store className="h-5 w-5 text-amber-400" />
          <div>
            <p className="font-medium">Market</p>
            <p className="text-xs text-muted-foreground">Marketplace items are featured from the listings manager (sparkle button).</p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </Link>

      {loading && slots.length === 0 ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        slots.map((s) => <SlotEditor key={s.slot} initial={s} onSaved={fetchSlots} />)
      )}
    </div>
  );
}

function SlotEditor({ initial, onSaved }: { initial: SlotState; onSaved: () => void }) {
  const [items, setItems] = useState<FeaturedItem[]>(initial.items);
  const [title, setTitle] = useState(initial.title);
  const [subtitle, setSubtitle] = useState(initial.subtitle);
  const [hidden, setHidden] = useState(initial.hidden);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FeaturedItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setItems(initial.items);
    setTitle(initial.title);
    setSubtitle(initial.subtitle);
    setHidden(initial.hidden);
  }, [initial]);

  const dirty =
    title !== initial.title ||
    subtitle !== initial.subtitle ||
    hidden !== initial.hidden ||
    initial.staleIds.length > 0 ||
    items.map((i) => i.id).join() !== initial.items.map((i) => i.id).join();

  async function search() {
    setSearching(true);
    try {
      const res = await fetch(`/api/admin/featured/search?kind=${initial.kind}&q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      setResults(res.ok ? data.items : []);
    } finally {
      setSearching(false);
    }
  }

  function move(idx: number, delta: number) {
    const next = [...items];
    const [it] = next.splice(idx, 1);
    next.splice(idx + delta, 0, it);
    setItems(next);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/featured", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: initial.slot, itemIds: items.map((i) => i.id), title, subtitle, hidden }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMessage({ ok: true, text: "Saved" });
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  const selected = new Set(items.map((i) => i.id));
  const full = items.length >= initial.max;

  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            {initial.page}
            <Link href={initial.path} target="_blank" className="text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </h2>
          <p className="text-xs text-muted-foreground">
            Up to {initial.max} {KIND_LABEL[initial.kind]} · {items.length === 0 ? "using page default" : `${items.length} featured`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Hide section
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder={initial.defaultTitle} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Section title" />
        <Input placeholder={initial.defaultSubtitle || "Subtitle (optional)"} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} aria-label="Section subtitle" />
      </div>

      {initial.staleIds.length > 0 && (
        <p className="text-xs text-amber-400">
          {initial.staleIds.length} previously featured item(s) are no longer public and were dropped. Save to clean up.
        </p>
      )}

      {items.length > 0 && (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {items.map((item, idx) => (
            <li key={item.id} className="flex items-center gap-2 px-3 py-2">
              <span className="text-xs text-muted-foreground w-4">{idx + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.title}</p>
                <p className="text-[11px] text-muted-foreground truncate">{[item.badge, item.byline].filter(Boolean).join(" · ")}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={idx === 0} onClick={() => move(idx, -1)} aria-label="Move up">
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={idx === items.length - 1} onClick={() => move(idx, 1)} aria-label="Move down">
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setItems(items.filter((i) => i.id !== item.id))} aria-label="Remove">
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <Input placeholder={`Search ${KIND_LABEL[initial.kind]} to add`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" variant="outline" disabled={searching}>
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </form>

      {results && (
        <div className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
          {results.length === 0 && <p className="p-3 text-xs text-muted-foreground">No matches.</p>}
          {results.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{r.title}</p>
                <p className="text-[11px] text-muted-foreground truncate">{[r.badge, r.byline, r.id].filter(Boolean).join(" · ")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={selected.has(r.id) || full}
                onClick={() => setItems([...items, r])}
              >
                {selected.has(r.id) ? <Check className="h-3.5 w-3.5" /> : <><Plus className="h-3.5 w-3.5 mr-1" />Add</>}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-xs ${message.ok ? "text-emerald-400" : "text-red-400"}`}>{message.text}</span>}
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
