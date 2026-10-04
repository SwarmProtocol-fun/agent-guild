/** Gigs — Fiverr-style marketplace: browse & order services from any org's agents, or sell your own. */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import {
  getActiveGigs,
  getGigsByOrg,
  getAgentsByOrg,
  createGig,
  setGigStatus,
  orderGig,
  type Gig,
  type Agent,
} from "@/lib/firestore";
import { Star, Zap, Clock, ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";
import { GigEscrowOrderForm } from "@/components/gigs/gig-escrow-order-form";
import { FeaturedStrip } from "@/components/featured-strip";

const SOLANA_ESCROW_AVAILABLE = process.env.NEXT_PUBLIC_WALLET_PROVIDER === "solana";
const LAMPORTS_PER_SOL = 1_000_000_000;

const CATEGORIES = ["Research", "Trading", "Operations", "Support", "Analytics", "Scout", "Content", "Dev"];

const fmtPrice = (price?: string) => {
  const n = parseFloat((price || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? "Custom" : `$${n.toLocaleString()}`;
};

export default function GigsPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const account = useWalletAccount();

  const [gigs, setGigs] = useState<Gig[]>([]);
  const [myGigs, setMyGigs] = useState<Gig[]>([]);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Browse filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("__all__");

  // Order dialog
  const [orderGigTarget, setOrderGigTarget] = useState<Gig | null>(null);
  const [requirements, setRequirements] = useState("");
  const [ordering, setOrdering] = useState(false);

  // New gig dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [gigAgentId, setGigAgentId] = useState("");
  const [gigTitle, setGigTitle] = useState("");
  const [gigDescription, setGigDescription] = useState("");
  const [gigCategory, setGigCategory] = useState(CATEGORIES[0]);
  const [gigPrice, setGigPrice] = useState("");
  const [gigDeliveryDays, setGigDeliveryDays] = useState("3");
  const [gigEscrowEnabled, setGigEscrowEnabled] = useState(false);
  const [gigPriceSol, setGigPriceSol] = useState("");
  const [creatingGig, setCreatingGig] = useState(false);

  const loadData = useCallback(async () => {
    if (!currentOrg) return;
    try {
      setLoading(true);
      setError(null);
      const [active, mine, agents] = await Promise.all([
        getActiveGigs(),
        getGigsByOrg(currentOrg.id),
        getAgentsByOrg(currentOrg.id),
      ]);
      setGigs(active);
      setMyGigs(mine);
      setMyAgents(agents);
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
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!g.title.toLowerCase().includes(q) && !g.description.toLowerCase().includes(q) && !g.tags.some(t => t.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const handleOrder = async () => {
    if (!orderGigTarget || !currentOrg) return;
    setOrdering(true);
    setError(null);
    try {
      const jobId = await orderGig(
        orderGigTarget.id,
        { orgId: currentOrg.id, address: account?.address || "" },
        requirements.trim() || undefined
      );
      setOrderGigTarget(null);
      setRequirements("");
      router.push(`/jobs/${jobId}`);
    } catch (err) {
      console.error("Failed to order gig:", err);
      setError(err instanceof Error ? err.message : "Failed to place order");
    } finally {
      setOrdering(false);
    }
  };

  const handleEscrowOrdered = (jobId: string) => {
    setOrderGigTarget(null);
    setRequirements("");
    router.push(`/jobs/${jobId}`);
  };

  const handleCreateGig = async () => {
    if (!currentOrg || !gigAgentId || !gigTitle.trim() || !gigPrice.trim()) return;
    const agent = myAgents.find((a) => a.id === gigAgentId);
    if (!agent) return;
    if (gigEscrowEnabled && !agent.solanaAddress) {
      setError(`${agent.name} has no Solana address on file — generate one for this agent before enabling escrow.`);
      return;
    }
    if (gigEscrowEnabled && (!gigPriceSol.trim() || parseFloat(gigPriceSol) <= 0)) {
      setError("Enter a SOL price for on-chain escrow.");
      return;
    }
    setCreatingGig(true);
    setError(null);
    try {
      await createGig({
        agentId: agent.id,
        agentOrgId: currentOrg.id,
        agentName: agent.name,
        title: gigTitle.trim(),
        description: gigDescription.trim(),
        category: gigCategory,
        tags: agent.capabilities?.slice(0, 5) ?? [],
        price: gigEscrowEnabled ? `${gigPriceSol.trim()} SOL` : gigPrice.trim(),
        deliveryDays: Math.max(1, parseInt(gigDeliveryDays, 10) || 1),
        status: "active",
        ...(gigEscrowEnabled ? {
          escrowEnabled: true,
          priceLamports: Math.round(parseFloat(gigPriceSol) * LAMPORTS_PER_SOL),
          sellerSolanaAddress: agent.solanaAddress,
        } : {}),
      });
      setGigAgentId(""); setGigTitle(""); setGigDescription(""); setGigPrice(""); setGigDeliveryDays("3");
      setGigEscrowEnabled(false); setGigPriceSol("");
      setCreateOpen(false);
      await loadData();
    } catch (err) {
      console.error("Failed to create gig:", err);
      setError(err instanceof Error ? err.message : "Failed to create gig");
    } finally {
      setCreatingGig(false);
    }
  };

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

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <Tabs defaultValue="browse" className="space-y-6">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="mine">My Gigs</TabsTrigger>
          </TabsList>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white" disabled={myAgents.length === 0}>
            <Zap className="h-4 w-4 mr-1.5" /> New Gig
          </Button>
        </div>

        <TabsContent value="browse" className="space-y-4">
          <FeaturedStrip
            slot="gigs"
            className="pb-2"
            onSelect={(item) => {
              const gig = gigs.find((g) => g.id === item.id);
              if (gig && gig.agentOrgId !== currentOrg.id) setOrderGigTarget(gig);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search gigs..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-56 text-xs" />
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All categories</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            </div>
          ) : visibleGigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="text-5xl mb-4">🛒</div>
              <h2 className="text-lg font-semibold mb-1">No gigs yet</h2>
              <p className="text-sm text-muted-foreground">Be the first to list a service from one of your agents</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleGigs.map((gig) => (
                <Card key={gig.id} className="hover:shadow-md transition-all hover:border-amber-300 dark:hover:border-amber-700">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium leading-snug">{gig.title}</h3>
                      <Badge variant="outline" className="text-[10px] shrink-0">{gig.category}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3">{gig.description}</p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>🤖 {gig.agentName}</span>
                      {(gig.ratingCount ?? 0) > 0 && (
                        <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{(gig.avgRating ?? 0).toFixed(1)} ({gig.ratingCount})</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />{gig.deliveryDays}d delivery
                      </div>
                      <span className="text-base font-bold text-amber-600 dark:text-amber-400">{fmtPrice(gig.price)}</span>
                    </div>
                    <Button
                      size="sm"
                      className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                      onClick={() => setOrderGigTarget(gig)}
                      disabled={gig.agentOrgId === currentOrg.id}
                    >
                      <ShoppingCart className="h-3.5 w-3.5 mr-1.5" />
                      {gig.agentOrgId === currentOrg.id ? "Your gig" : "Order Now"}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="mine" className="space-y-4">
          {myAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">You need at least one agent before you can list a gig.</p>
          ) : myGigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="text-5xl mb-4">💼</div>
              <h2 className="text-lg font-semibold mb-1">No gigs listed</h2>
              <p className="text-sm text-muted-foreground mb-4">List a service one of your agents offers</p>
              <Button onClick={() => setCreateOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white">+ New Gig</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {myGigs.map((gig) => (
                <Card key={gig.id} className={cn(gig.status === "paused" && "opacity-60")}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium leading-snug">{gig.title}</h3>
                      <Badge variant={gig.status === "active" ? "default" : "outline"} className="text-[10px] shrink-0">{gig.status}</Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground">🤖 {gig.agentName} · {gig.category}</div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{gig.orderCount} order{gig.orderCount === 1 ? "" : "s"}</span>
                      {(gig.ratingCount ?? 0) > 0 && (
                        <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{(gig.avgRating ?? 0).toFixed(1)}</span>
                      )}
                      <span className="font-medium text-amber-600 dark:text-amber-400">{fmtPrice(gig.price)}</span>
                    </div>
                    <Button size="sm" variant="outline" className="w-full" onClick={() => handleToggleStatus(gig)}>
                      {gig.status === "active" ? "Pause" : "Activate"}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Order Dialog */}
      <Dialog open={!!orderGigTarget} onOpenChange={(open) => !open && setOrderGigTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Order: {orderGigTarget?.title}</DialogTitle>
            <DialogDescription>
              {orderGigTarget?.escrowEnabled
                ? `Half pays ${orderGigTarget?.agentName} immediately, half is held in on-chain escrow until you approve delivery.`
                : `This creates an order assigned directly to ${orderGigTarget?.agentName} for ${fmtPrice(orderGigTarget?.price)}. You'll track delivery on the Job Board.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Requirements (optional)</label>
              <Textarea placeholder="Anything specific this order needs, beyond the gig description..." value={requirements} onChange={(e) => setRequirements(e.target.value)} rows={4} />
            </div>
            {orderGigTarget?.escrowEnabled ? (
              SOLANA_ESCROW_AVAILABLE ? (
                <GigEscrowOrderForm
                  gig={orderGigTarget}
                  buyerOrgId={currentOrg.id}
                  requirements={requirements}
                  onOrdered={handleEscrowOrdered}
                  onError={(msg) => setError(msg)}
                />
              ) : (
                <p className="text-xs text-destructive">This deployment isn't configured for Solana wallets (NEXT_PUBLIC_WALLET_PROVIDER), so escrow orders aren't available here.</p>
              )
            ) : (
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setOrderGigTarget(null)} disabled={ordering}>Cancel</Button>
                <Button onClick={handleOrder} disabled={ordering} className="bg-amber-600 hover:bg-amber-700 text-white">
                  {ordering ? "Placing order..." : "Place Order"}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* New Gig Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>List a New Gig</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium mb-1 block">Agent <span className="text-red-500">*</span></label>
              <Select value={gigAgentId} onValueChange={setGigAgentId}>
                <SelectTrigger><SelectValue placeholder="Which agent offers this?" /></SelectTrigger>
                <SelectContent>
                  {myAgents.map((a) => <SelectItem key={a.id} value={a.id}>🤖 {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Title <span className="text-red-500">*</span></label>
              <Input placeholder="e.g. On-chain wallet research report" value={gigTitle} onChange={(e) => setGigTitle(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Description</label>
              <Textarea placeholder="What the buyer gets, scope, and any requirements you need from them..." value={gigDescription} onChange={(e) => setGigDescription(e.target.value)} rows={3} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Category</label>
                <Select value={gigCategory} onValueChange={setGigCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Price <span className="text-red-500">*</span></label>
                <Input placeholder="e.g. 150" value={gigPrice} onChange={(e) => setGigPrice(e.target.value)} disabled={gigEscrowEnabled} />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Delivery (days)</label>
                <Input type="number" min="1" value={gigDeliveryDays} onChange={(e) => setGigDeliveryDays(e.target.value)} />
              </div>
            </div>
            {SOLANA_ESCROW_AVAILABLE && (
              <div className="rounded-md border p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <input type="checkbox" checked={gigEscrowEnabled} onChange={(e) => setGigEscrowEnabled(e.target.checked)} className="h-3.5 w-3.5" />
                  Real on-chain escrow — half paid upfront, half held until delivery is approved
                </label>
                {gigEscrowEnabled && (
                  <div>
                    <label className="text-xs font-medium mb-1 block">Price in SOL <span className="text-red-500">*</span></label>
                    <Input type="number" min="0" step="0.01" placeholder="e.g. 0.5" value={gigPriceSol} onChange={(e) => setGigPriceSol(e.target.value)} />
                    <p className="text-[11px] text-muted-foreground mt-1">Requires the selected agent to have a Solana address on file.</p>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creatingGig}>Cancel</Button>
              <Button
                onClick={handleCreateGig}
                disabled={creatingGig || !gigAgentId || !gigTitle.trim() || (gigEscrowEnabled ? !gigPriceSol.trim() : !gigPrice.trim())}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {creatingGig ? "Listing..." : "List Gig"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
