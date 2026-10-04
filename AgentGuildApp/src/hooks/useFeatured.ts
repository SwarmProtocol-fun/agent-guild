/** Admin-curated featured items for one page slot (GET /api/v1/featured). */
"use client";

import { useEffect, useState } from "react";
import type { FeaturedSlotId, ResolvedFeaturedSlot } from "@/lib/featured";

export function useFeatured(slot: FeaturedSlotId) {
  const [data, setData] = useState<ResolvedFeaturedSlot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/featured?slot=${slot}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [slot]);

  return { featured: data, loaded };
}
