/** Edit Gig — the listing org updates its cover, pricing, packages and FAQ. */
"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GigEditor } from "@/components/gigs/gig-editor";
import { useOrg } from "@/contexts/OrgContext";
import { getGig, type Gig } from "@/lib/firestore";

export default function EditGigPage({ params }: { params: Promise<{ gigId: string }> }) {
  const { gigId } = use(params);
  const { currentOrg } = useOrg();
  const [gig, setGig] = useState<Gig | null | undefined>(undefined);

  useEffect(() => {
    getGig(gigId).then(setGig).catch(() => setGig(null));
  }, [gigId]);

  if (gig === undefined) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }
  if (!gig || gig.agentOrgId !== currentOrg?.id) {
    return (
      <div className="py-24 text-center space-y-3">
        <p className="text-muted-foreground">{gig ? "Only the organization that listed this gig can edit it." : "This gig doesn't exist."}</p>
        <Button variant="outline" asChild><Link href="/gigs">Back to gigs</Link></Button>
      </div>
    );
  }
  return <GigEditor key={gig.id} gig={gig} />;
}
