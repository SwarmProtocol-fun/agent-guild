/** Gig Card — browse-grid tile for one service listing (cover, seller, rating, "from" price). */
"use client";

import Link from "next/link";
import { Bot, Clock, ImageIcon, Star, User } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Gig } from "@/lib/firestore";
import { isHostedGigImage, parsePriceNumber } from "@/lib/gig-packages";
import { cn } from "@/lib/utils";

/** "$150", "0.5 SOL", or "Custom" for unparseable/zero prices. */
export function fmtGigPrice(price?: string): string {
  const n = parsePriceNumber(price);
  if (isNaN(n) || n <= 0) return "Custom";
  return /sol/i.test(price ?? "") ? `${n.toLocaleString()} SOL` : `$${n.toLocaleString()}`;
}

export function GigCard({ gig, footer, className }: { gig: Gig; footer?: React.ReactNode; className?: string }) {
  const cover = isHostedGigImage(gig.coverImageUrl) ? gig.coverImageUrl : undefined;
  const hasPackages = (gig.packages?.length ?? 0) > 1;

  return (
    <Card className={cn("group overflow-hidden transition-all hover:shadow-md hover:border-amber-300 dark:hover:border-amber-700", className)}>
      <Link href={`/gigs/${gig.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="aspect-[16/9] bg-muted overflow-hidden">
          {cover ? (
            <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-amber-500/15 to-[#27A0FD]/15">
              <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
            </div>
          )}
        </div>
        <CardContent className="p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              {gig.sellerType === "person" ? <User className="h-3 w-3 shrink-0" /> : <Bot className="h-3 w-3 shrink-0" />}
              <span className="truncate">{gig.agentName}</span>
            </span>
            <Badge variant="outline" className="text-[10px] shrink-0">{gig.category}</Badge>
          </div>
          <h3 className="text-sm font-medium leading-snug line-clamp-2 min-h-[2.5em]">{gig.title}</h3>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {(gig.ratingCount ?? 0) > 0 ? (
              <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{(gig.avgRating ?? 0).toFixed(1)} ({gig.ratingCount})</span>
            ) : (
              <span>New</span>
            )}
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{gig.deliveryDays}d</span>
          </div>
          <div className="flex items-baseline justify-end gap-1 border-t pt-2">
            {hasPackages && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">From</span>}
            <span className="text-base font-bold tabular-nums text-amber-600 dark:text-amber-400">{fmtGigPrice(gig.price)}</span>
          </div>
        </CardContent>
      </Link>
      {footer && <div className="px-4 pb-4">{footer}</div>}
    </Card>
  );
}
