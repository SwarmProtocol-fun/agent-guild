/**
 * Featured placements — server side. Reads/writes `platformConfig/featured`
 * and resolves stored ids into display-ready items. Only items that are still
 * publicly visible resolve (active gigs, public agents, public templates), so
 * a paused gig or an agent that went private silently drops out.
 */

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import { buildAgentPassport, type AgentPassport } from "./agent-passport";
import { searchDirectory } from "./agent-directory";
import { getTemplate, getTemplates } from "./compute/firestore";
import type { ComputeTemplate } from "./compute/types";
import {
  FEATURED_SLOTS,
  type FeaturedItem,
  type FeaturedKind,
  type FeaturedSlotConfig,
  type FeaturedSlotId,
  type ResolvedFeaturedSlot,
} from "./featured";

const DOC = () => adminDb().collection("platformConfig").doc("featured");

export async function getFeaturedConfig(): Promise<Partial<Record<FeaturedSlotId, FeaturedSlotConfig>>> {
  const snap = await DOC().get();
  return (snap.exists ? snap.data()?.slots : null) || {};
}

export async function saveFeaturedSlot(slot: FeaturedSlotId, config: FeaturedSlotConfig, updatedBy: string): Promise<void> {
  await DOC().set({
    slots: { [slot]: config },
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy,
  }, { merge: true });
}

// ── Item mapping ──

function gigToItem(id: string, d: FirebaseFirestore.DocumentData): FeaturedItem {
  return {
    id,
    kind: "gig",
    title: d.title || "Untitled",
    description: d.description || "",
    href: "/gigs",
    badge: d.category || "General",
    byline: d.agentName || "Unknown agent",
    price: d.price || "",
    deliveryDays: d.deliveryDays || 0,
    rating: d.avgRating || 0,
    ratingCount: d.ratingCount || 0,
  };
}

function agentToItem(p: AgentPassport): FeaturedItem {
  return {
    id: p.agentId,
    kind: "agent",
    title: p.name,
    description: p.bio || "",
    href: `/directory/${p.agentId}`,
    badge: p.type,
    status: p.status,
    avatarUrl: p.avatarUrl,
    tier: p.reputation?.tier?.name,
  };
}

function templateToItem(t: ComputeTemplate): FeaturedItem {
  return {
    id: t.id,
    kind: "template",
    title: t.name,
    description: t.description,
    href: `/compute/templates/${t.id}`,
    badge: t.category,
  };
}

/** Resolve ids → items in the given order, dropping anything no longer public. */
export async function resolveFeaturedItems(kind: FeaturedKind, ids: string[]): Promise<FeaturedItem[]> {
  if (!ids.length) return [];
  let items: (FeaturedItem | null)[];
  if (kind === "gig") {
    const snaps = await adminDb().getAll(...ids.map((id) => adminDb().collection("gigs").doc(id)));
    items = snaps.map((s) => (s.exists && s.data()?.status === "active" ? gigToItem(s.id, s.data()!) : null));
  } else if (kind === "agent") {
    const passports = await Promise.all(ids.map((id) => buildAgentPassport(id, { walletBalances: false }).catch(() => null)));
    items = passports.map((p) => (p ? agentToItem(p) : null));
  } else {
    const templates = await Promise.all(ids.map((id) => getTemplate(id).catch(() => null)));
    items = templates.map((t) => (t?.isPublic ? templateToItem(t) : null));
  }
  return items.filter((i): i is FeaturedItem => i !== null);
}

export async function getResolvedFeaturedSlot(slot: FeaturedSlotId): Promise<ResolvedFeaturedSlot> {
  const def = FEATURED_SLOTS[slot];
  const cfg = (await getFeaturedConfig())[slot];
  const items = await resolveFeaturedItems(def.kind, (cfg?.itemIds || []).slice(0, def.max));
  return {
    slot,
    title: cfg?.title?.trim() || def.defaultTitle,
    subtitle: cfg?.subtitle?.trim() || def.defaultSubtitle,
    hidden: !!cfg?.hidden,
    curated: items.length > 0,
    items,
  };
}

/** Admin picker: publicly visible items of a kind matching `q`. */
export async function searchFeaturedCandidates(kind: FeaturedKind, q: string, limit = 20): Promise<FeaturedItem[]> {
  const needle = q.trim().toLowerCase();
  if (kind === "gig") {
    const snap = await adminDb().collection("gigs").where("status", "==", "active").limit(500).get();
    return snap.docs
      .map((d) => gigToItem(d.id, d.data()))
      .filter((i) => !needle || `${i.title} ${i.byline} ${i.badge}`.toLowerCase().includes(needle))
      .slice(0, limit);
  }
  if (kind === "agent") {
    const results = await searchDirectory({ q: needle });
    return results.slice(0, limit).map(agentToItem);
  }
  const templates = await getTemplates({ isPublic: true });
  return templates
    .map(templateToItem)
    .filter((i) => !needle || `${i.title} ${i.description} ${i.badge}`.toLowerCase().includes(needle))
    .slice(0, limit);
}
