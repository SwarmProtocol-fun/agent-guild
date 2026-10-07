/** Gigs — Fiverr-style marketplace: browse & order services from people and agents in any org, or sell your own. */
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import { getActiveGigs, getGigsByOrg, setGigStatus, type Gig } from "@/lib/firestore";
import { Pencil, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { FeaturedStrip } from "@/components/featured-strip";
import { GigCard } from "@/components/gigs/gig-card";
import { GIG_CATEGORIES } from "@/components/gigs/gig-editor";

export default function GigsPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();

  const [gigs, setGigs] = useState<Gig[]>([]);
  const [myGigs, setMyGigs] = useState<Gig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("__all__");
  const [sellerFilter, setSellerFilter] = useState<"__all__" | "person" | "agent">("__all__");

  const loadData = useCallback(async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      setError(null);
      const [active, mine] = await Promise.all([getActiveGigs(), getGigsByOrg(currentOrg.id)]);
      setGigs(active);
      setMyGigs(mine);
    } catch (err) {
      console.error("Failed to load gigs:", err);
      setError(err instanceof Error ? err.message : "Failed to load gigs");
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => { loadData(); }, [loadData]);

  const visibleGigs = gigs.filter((g) => {
    if (categoryFilter !== "__all__" && g.category !== categoryFilter) return false;
    if (sellerFilter !== "__all__" && (g.sellerType ?? "agent") !== sellerFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!g.title.toLowerCase().includes(q) && !g.description.toLowerCase().includes(q) && !g.tags.some(t => t.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const handleToggleStatus = async (gig: Gig) => {
    try {
      await setGigStatus(gig.id, gig.status === "active" ? "paused" : "active");
      await loadData();
    } catch (err) {
      console.error("Failed to update gig status:", err);
      setError(err instanceof Error ? err.message : "Failed to update gig");
    }
  };

  if (!currentOrg) {
    return (
      <div className="space-y-6">
        <p className="text-muted-foreground mt-1">No organization selected</p>
      </div>
    );
  }

  const spinner = (
    <div className="flex items-center justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
    </div>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <Tabs defaultValue="browse" className="space-y-6">
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="mine">My Gigs</TabsTrigger>
          </TabsList>
          <Button size="sm" asChild className="bg-amber-600 hover:bg-amber-700 text-white">
            <Link href="/gigs/new"><Plus className="h-4 w-4 mr-1.5" /> Offer a service</Link>
          </Button>
        </div>

        <TabsContent value="browse" className="space-y-4">
          <FeaturedStrip
            slot="gigs"
            className="pb-2"
            onSelect={(item) => router.push(`/gigs/${item.id}`)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search gigs..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-56 text-xs" />
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All categories</SelectItem>
                {GIG_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={sellerFilter} onValueChange={(v) => setSellerFilter(v as typeof sellerFilter)}>
              <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All sellers</SelectItem>
                <SelectItem value="person">People</SelectItem>
                <SelectItem value="agent">Agents</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {loading ? spinner : visibleGigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="text-5xl mb-4">🛒</div>
              <h2 className="text-lg font-semibold mb-1">No gigs found</h2>
              <p className="text-sm text-muted-foreground">Be the first to offer a service</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {visibleGigs.map((gig) => <GigCard key={gig.id} gig={gig} />)}
            </div>
          )}
        </TabsContent>

        <TabsContent value="mine" className="space-y-4">
          {loading ? spinner : myGigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="text-5xl mb-4">💼</div>
              <h2 className="text-lg font-semibold mb-1">No gigs listed</h2>
              <p className="text-sm text-muted-foreground mb-4">Offer a service yourself, or list one of your agents&apos; skills</p>
              <Button asChild className="bg-amber-600 hover:bg-amber-700 text-white"><Link href="/gigs/new">Offer a service</Link></Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {myGigs.map((gig) => (
                <GigCard
                  key={gig.id}
                  gig={gig}
                  className={cn(gig.status === "paused" && "opacity-70")}
                  footer={
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{gig.orderCount} order{gig.orderCount === 1 ? "" : "s"}</span>
                        <Badge variant={gig.status === "active" ? "default" : "outline"} className="text-[10px]">{gig.status}</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/gigs/${gig.id}/edit`}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit</Link>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleToggleStatus(gig)}>
                          {gig.status === "active" ? "Pause" : "Activate"}
                        </Button>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
