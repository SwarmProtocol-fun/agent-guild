/** Featured section for a page — renders the admin-curated items for a slot, or nothing when none are set. */
"use client";

import Link from "next/link";
import { Sparkles, Star, Clock } from "lucide-react";
import { useFeatured } from "@/hooks/useFeatured";
import type { FeaturedItem, FeaturedSlotId } from "@/lib/featured";
import { cn } from "@/lib/utils";

const STATUS_DOT: Record<string, string> = {
  online: "bg-emerald-500",
  busy: "bg-amber-500",
  paused: "bg-slate-400",
  offline: "bg-slate-500",
};

const fmtPrice = (price?: string) => {
  const n = parseFloat((price || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? "Custom" : `$${n.toLocaleString()}`;
};

export function FeaturedStrip({
  slot,
  onSelect,
  className,
}: {
  slot: FeaturedSlotId;
  /** Override navigation, e.g. open the gig order dialog instead of linking. */
  onSelect?: (item: FeaturedItem) => void;
  className?: string;
}) {
  const { featured } = useFeatured(slot);
  if (!featured || featured.hidden || !featured.curated) return null;

  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-400" />{featured.title}
        </h2>
        {featured.subtitle && <p className="text-xs text-muted-foreground">{featured.subtitle}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {featured.items.map((item) => {
          const body = <FeaturedCard item={item} />;
          const cls = "block text-left rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-3 hover:border-amber-500/40 transition-colors";
          return onSelect ? (
            <button key={item.id} type="button" className={cls} onClick={() => onSelect(item)}>{body}</button>
          ) : (
            <Link key={item.id} href={item.href} className={cls}>{body}</Link>
          );
        })}
      </div>
    </section>
  );
}

function FeaturedCard({ item }: { item: FeaturedItem }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {item.kind === "agent" && (
            item.avatarUrl
              ? <img src={item.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover shrink-0" />
              : <span className={cn("h-2 w-2 rounded-full shrink-0", STATUS_DOT[item.status || "offline"])} />
          )}
          <p className="text-sm font-medium truncate">{item.title}</p>
        </div>
        {item.badge && (
          <span className="text-[10px] shrink-0 px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 capitalize">{item.badge}</span>
        )}
      </div>
      {item.description && <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>}
      {item.kind === "gig" && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <span>🤖 {item.byline}</span>
            {!!item.ratingCount && (
              <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{item.rating?.toFixed(1)}</span>
            )}
            {!!item.deliveryDays && <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" />{item.deliveryDays}d</span>}
          </span>
          <span className="text-sm font-bold text-amber-400">{fmtPrice(item.price)}</span>
        </div>
      )}
      {item.kind === "agent" && item.tier && (
        <p className="text-[11px] text-muted-foreground">{item.tier} tier</p>
      )}
    </div>
  );
}
