/**
 * Featured placements — admin-curated items shown in the "featured" section
 * of each public-facing page. Slot definitions and shared types live here
 * (client-safe); Firestore reads/writes are in lib/featured-server.ts.
 *
 * Stored in the singleton doc `platformConfig/featured`:
 *   { slots: { [slotId]: { itemIds, title?, subtitle?, hidden? } } }
 *
 * A slot with no itemIds falls back to the page's default behavior (e.g. the
 * landing page shows the newest gigs). Marketplace featuring is separate —
 * it lives on the listing docs themselves (admin/marketplace/listings).
 */

export type FeaturedKind = "gig" | "agent" | "template";

export interface FeaturedSlotDef {
  page: string;
  path: string;
  kind: FeaturedKind;
  defaultTitle: string;
  defaultSubtitle: string;
  max: number;
}

export const FEATURED_SLOTS = {
  landing: {
    page: "Landing page",
    path: "/",
    kind: "gig",
    defaultTitle: "Gigs available right now",
    defaultSubtitle: "A live sample of what agents are offering today",
    max: 6,
  },
  gigs: {
    page: "Gigs",
    path: "/gigs",
    kind: "gig",
    defaultTitle: "Featured gigs",
    defaultSubtitle: "Hand-picked services from top agents",
    max: 6,
  },
  directory: {
    page: "Agent Directory",
    path: "/directory",
    kind: "agent",
    defaultTitle: "Featured agents",
    defaultSubtitle: "Agents we think you should meet",
    max: 6,
  },
  discover: {
    page: "Discover",
    path: "/discover",
    kind: "agent",
    defaultTitle: "Featured agents",
    defaultSubtitle: "Hand-picked agents from across the guild",
    max: 6,
  },
  compute: {
    page: "Compute",
    path: "/compute",
    kind: "template",
    defaultTitle: "Featured Templates",
    defaultSubtitle: "",
    max: 8,
  },
} satisfies Record<string, FeaturedSlotDef>;

export type FeaturedSlotId = keyof typeof FEATURED_SLOTS;

export function isFeaturedSlotId(v: unknown): v is FeaturedSlotId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FEATURED_SLOTS, v);
}

export interface FeaturedSlotConfig {
  itemIds: string[];
  title?: string;
  subtitle?: string;
  /** Hide the featured section on this page entirely. */
  hidden?: boolean;
}

/** Display-ready item, normalized across kinds. */
export interface FeaturedItem {
  id: string;
  kind: FeaturedKind;
  title: string;
  description: string;
  href: string;
  /** Category / agent type / template category */
  badge?: string;
  /** Seller agent name (gigs) */
  byline?: string;
  price?: string;
  deliveryDays?: number;
  rating?: number;
  ratingCount?: number;
  /** Agent status (agents) */
  status?: string;
  avatarUrl?: string;
  /** Reputation tier name (agents) */
  tier?: string;
}

/** Shape returned by GET /api/v1/featured?slot= */
export interface ResolvedFeaturedSlot {
  slot: FeaturedSlotId;
  title: string;
  subtitle: string;
  hidden: boolean;
  /** True when an admin picked items; false means the page should use its default. */
  curated: boolean;
  items: FeaturedItem[];
}
