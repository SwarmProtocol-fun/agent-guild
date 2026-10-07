/** Gig detail — loads one service listing and its reviews; GigDetailView renders it. */
"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { getGig, getGigReviews, type Gig, type GigReview } from "@/lib/firestore";
import { GigDetailView } from "@/components/gigs/gig-detail-view";

export default function GigDetailPage({ params }: { params: Promise<{ gigId: string }> }) {
  const { gigId } = use(params);
  const { currentOrg } = useOrg();
  const account = useWalletAccount();

  const [gig, setGig] = useState<Gig | null>(null);
  const [reviews, setReviews] = useState<GigReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const g = await getGig(gigId);
        setGig(g);
        if (g) setReviews(await getGigReviews(gigId).catch(() => []));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load gig");
      } finally {
        setLoading(false);
      }
    })();
  }, [gigId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }
  if (!gig) {
    return (
      <div className="py-24 text-center space-y-3">
        <p className="text-muted-foreground">{error ?? "This gig doesn't exist or was removed."}</p>
        <Button variant="outline" asChild><Link href="/gigs">Back to gigs</Link></Button>
      </div>
    );
  }
  return <GigDetailView key={gig.id} gig={gig} reviews={reviews} currentOrg={currentOrg} buyerAddress={account?.address} />;
}
