/** Gig Detail View — presentational listing page: cover, gallery, packages, FAQ, reviews and the order panel. */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, Check, Clock, Pencil, RefreshCw, ShoppingCart, Star, User } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { orderGig, type Gig, type GigPackage, type GigReview } from "@/lib/firestore";
import { isHostedGigImage } from "@/lib/gig-packages";
import { GigEscrowOrderForm } from "@/components/gigs/gig-escrow-order-form";
import { fmtGigPrice } from "@/components/gigs/gig-card";
import { cn } from "@/lib/utils";

const SOLANA_ESCROW_AVAILABLE = process.env.NEXT_PUBLIC_WALLET_PROVIDER === "solana";

interface GigDetailViewProps {
  gig: Gig;
  reviews: GigReview[];
  /** The viewer's org — null when none is selected (can't order). */
  currentOrg: { id: string } | null;
  buyerAddress?: string;
}

export function GigDetailView({ gig, reviews, currentOrg, buyerAddress }: GigDetailViewProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [activeImage, setActiveImage] = useState(0);
  const [tier, setTier] = useState<GigPackage["id"] | undefined>(gig.packages?.[0]?.id);
  const [requirements, setRequirements] = useState("");
  const [ordering, setOrdering] = useState(false);

  const images = [gig.coverImageUrl, ...(gig.galleryUrls ?? [])].filter((u): u is string => isHostedGigImage(u));
  const packages = gig.packages ?? [];
  const pkg = packages.find((p) => p.id === tier);
  const isOwn = gig.agentOrgId === currentOrg?.id;
  const isPerson = gig.sellerType === "person";
  const canOrder = !!currentOrg && !isOwn && gig.status === "active";

  const handleOrder = async () => {
    if (!currentOrg) return;
    setOrdering(true);
    setError(null);
    try {
      const jobId = await orderGig(gig.id, { orgId: currentOrg.id, address: buyerAddress || "" }, requirements.trim() || undefined, undefined, pkg?.id);
      router.push(`/jobs/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place order");
      setOrdering(false);
    }
  };

  const summary = pkg
    ? { price: pkg.price, days: pkg.deliveryDays, revisions: pkg.revisions as number | undefined, features: pkg.features, description: pkg.description }
    : { price: gig.price, days: gig.deliveryDays, revisions: undefined, features: [] as string[], description: "" };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/gigs"><ArrowLeft className="h-4 w-4 mr-1" /> All gigs</Link>
        </Button>
        {isOwn && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/gigs/${gig.id}/edit`}><Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit gig</Link>
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:grid-rows-[auto_1fr]">
        {/* Title + gallery, then (on mobile) the order panel, then the details. */}
        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{gig.category}</Badge>
              {gig.status !== "active" && <Badge variant="secondary">{gig.status}</Badge>}
            </div>
            <h1 className="text-2xl font-semibold leading-tight">{gig.title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                {isPerson ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                {gig.agentName}
                <span className="text-xs">({isPerson ? "person" : "agent"})</span>
              </span>
              {(gig.ratingCount ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  <span className="font-medium text-foreground">{(gig.avgRating ?? 0).toFixed(1)}</span> ({gig.ratingCount})
                </span>
              )}
              <span>{gig.orderCount} order{gig.orderCount === 1 ? "" : "s"}</span>
            </div>
          </div>

          {images.length > 0 && (
            <div className="space-y-2">
              <div className="aspect-[16/9] overflow-hidden rounded-lg border bg-muted">
                <img src={images[Math.min(activeImage, images.length - 1)]} alt={gig.title} className="h-full w-full object-cover" />
              </div>
              {images.length > 1 && (
                <div className="flex gap-2 overflow-x-auto">
                  {images.map((src, i) => (
                    <button
                      key={src}
                      onClick={() => setActiveImage(i)}
                      className={cn("h-16 w-24 shrink-0 overflow-hidden rounded-md border-2", i === activeImage ? "border-amber-500" : "border-transparent opacity-70 hover:opacity-100")}
                      aria-label={`Show image ${i + 1}`}
                    >
                      <img src={src} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>

        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-2">
          <section className="space-y-2">
            <h2 className="text-base font-semibold">About this gig</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{gig.description || "No description provided."}</p>
            {gig.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {gig.tags.map((t) => <Badge key={t} variant="secondary" className="text-[11px]">{t}</Badge>)}
              </div>
            )}
          </section>

          {packages.length > 1 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">Compare packages</h2>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3 text-left font-medium text-muted-foreground">Package</th>
                      {packages.map((p) => <th key={p.id} className="p-3 text-left font-semibold">{p.name}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr><td className="p-3 text-muted-foreground">Price</td>{packages.map((p) => <td key={p.id} className="p-3 font-semibold tabular-nums">{fmtGigPrice(p.price)}</td>)}</tr>
                    <tr><td className="p-3 text-muted-foreground">Delivery</td>{packages.map((p) => <td key={p.id} className="p-3 tabular-nums">{p.deliveryDays} day{p.deliveryDays === 1 ? "" : "s"}</td>)}</tr>
                    <tr><td className="p-3 text-muted-foreground">Revisions</td>{packages.map((p) => <td key={p.id} className="p-3 tabular-nums">{p.revisions}</td>)}</tr>
                    {Array.from(new Set(packages.flatMap((p) => p.features))).map((f) => (
                      <tr key={f}>
                        <td className="p-3 text-muted-foreground">{f}</td>
                        {packages.map((p) => (
                          <td key={p.id} className="p-3">{p.features.includes(f) ? <Check className="h-4 w-4 text-green-600" aria-label="Included" /> : <span className="text-muted-foreground" aria-label="Not included">—</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(gig.faqs?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">FAQ</h2>
              <div className="divide-y rounded-lg border">
                {gig.faqs!.map((f, i) => (
                  <details key={i} className="group p-3">
                    <summary className="cursor-pointer list-none text-sm font-medium">{f.question}</summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{f.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Reviews {reviews.length > 0 && <span className="text-muted-foreground font-normal">({reviews.length})</span>}</h2>
            {reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reviews yet.</p>
            ) : (
              <div className="space-y-3">
                {reviews.map((r) => (
                  <div key={r.id} className="rounded-lg border p-3 space-y-1">
                    <div className="flex items-center gap-0.5" aria-label={`${r.rating} out of 5 stars`}>
                      {Array.from({ length: 5 }, (_, i) => (
                        <Star key={i} className={cn("h-3.5 w-3.5", i < r.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />
                      ))}
                    </div>
                    {r.review && <p className="text-sm">{r.review}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Order panel */}
        <div className="row-start-2 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-4 lg:self-start">
          <Card>
            {packages.length > 0 && (
              <div className="grid border-b" style={{ gridTemplateColumns: `repeat(${packages.length}, minmax(0, 1fr))` }} role="tablist">
                {packages.map((p) => (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={p.id === tier}
                    onClick={() => setTier(p.id)}
                    className={cn("px-2 py-3 text-sm font-medium border-b-2 transition-colors", p.id === tier ? "border-amber-500 bg-amber-500/10 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <CardContent className="space-y-4 p-5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{pkg?.name ?? "Price"}</span>
                <span className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmtGigPrice(summary.price)}</span>
              </div>
              {summary.description && <p className="text-sm text-muted-foreground">{summary.description}</p>}
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4 text-muted-foreground" />{summary.days}-day delivery</span>
                {summary.revisions !== undefined && (
                  <span className="inline-flex items-center gap-1.5"><RefreshCw className="h-4 w-4 text-muted-foreground" />{summary.revisions} revision{summary.revisions === 1 ? "" : "s"}</span>
                )}
              </div>
              {summary.features.length > 0 && (
                <ul className="space-y-1.5 text-sm">
                  {summary.features.map((f) => (
                    <li key={f} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />{f}</li>
                  ))}
                </ul>
              )}

              {canOrder ? (
                <div className="space-y-3 border-t pt-4">
                  <div>
                    <label htmlFor="gig-requirements" className="text-xs font-medium mb-1 block">Requirements (optional)</label>
                    <Textarea id="gig-requirements" placeholder="Anything specific this order needs..." value={requirements} onChange={(e) => setRequirements(e.target.value)} rows={3} />
                  </div>
                  {gig.escrowEnabled ? (
                    SOLANA_ESCROW_AVAILABLE ? (
                      <GigEscrowOrderForm
                        gig={gig}
                        pkg={pkg}
                        buyerOrgId={currentOrg!.id}
                        requirements={requirements}
                        onOrdered={(jobId) => router.push(`/jobs/${jobId}`)}
                        onError={setError}
                      />
                    ) : (
                      <p className="text-xs text-destructive">This deployment isn&apos;t configured for Solana wallets, so escrow orders aren&apos;t available here.</p>
                    )
                  ) : (
                    <Button onClick={handleOrder} disabled={ordering} className="w-full bg-amber-600 hover:bg-amber-700 text-white">
                      <ShoppingCart className="h-4 w-4 mr-1.5" />
                      {ordering ? "Placing order..." : `Continue (${fmtGigPrice(summary.price)})`}
                    </Button>
                  )}
                  {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
                </div>
              ) : (
                <p className="border-t pt-4 text-xs text-muted-foreground">
                  {isOwn ? "This is your gig — buyers order it from here." : gig.status !== "active" ? "This gig is paused and not taking orders." : "Select an organization to order."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
