/**
 * GET /api/admin/featured
 * PUT /api/admin/featured  { slot, itemIds, title?, subtitle?, hidden? }
 *
 * Manage the featured section of each page (`platformConfig/featured`).
 * GET returns every slot with its stored config and resolved items so the
 * admin UI can show names; ids that no longer resolve are reported as stale.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { FEATURED_SLOTS, isFeaturedSlotId, type FeaturedSlotId } from "@/lib/featured";
import { getFeaturedConfig, resolveFeaturedItems, saveFeaturedSlot } from "@/lib/featured-server";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const config = await getFeaturedConfig();
    const slots = await Promise.all(
      (Object.keys(FEATURED_SLOTS) as FeaturedSlotId[]).map(async (slot) => {
        const cfg = config[slot] || { itemIds: [] };
        const items = await resolveFeaturedItems(FEATURED_SLOTS[slot].kind, cfg.itemIds || []);
        const resolved = new Set(items.map((i) => i.id));
        return {
          slot,
          ...FEATURED_SLOTS[slot],
          title: cfg.title || "",
          subtitle: cfg.subtitle ?? "",
          hidden: !!cfg.hidden,
          items,
          staleIds: (cfg.itemIds || []).filter((id) => !resolved.has(id)),
        };
      }),
    );
    return Response.json({ ok: true, slots });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load featured config" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { slot, itemIds, title, subtitle, hidden } = (body || {}) as Record<string, unknown>;

  if (!isFeaturedSlotId(slot)) return Response.json({ error: "Unknown slot" }, { status: 400 });
  const def = FEATURED_SLOTS[slot];
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) {
    return Response.json({ error: "itemIds must be an array of ids" }, { status: 400 });
  }
  const ids = [...new Set(itemIds as string[])];
  if (ids.length > def.max) {
    return Response.json({ error: `${def.page} can feature at most ${def.max} items` }, { status: 400 });
  }
  if ((title != null && typeof title !== "string") || (subtitle != null && typeof subtitle !== "string")) {
    return Response.json({ error: "title and subtitle must be strings" }, { status: 400 });
  }

  // Only accept ids that currently resolve, so a typo can't get stored.
  const items = await resolveFeaturedItems(def.kind, ids);
  if (items.length !== ids.length) {
    const ok = new Set(items.map((i) => i.id));
    return Response.json({ error: `Not found or not public: ${ids.filter((id) => !ok.has(id)).join(", ")}` }, { status: 400 });
  }

  const updatedBy = req.headers.get("x-wallet-address") || "platform-admin";
  try {
    await saveFeaturedSlot(slot, {
      itemIds: ids,
      title: ((title as string) || "").trim().slice(0, 120),
      subtitle: ((subtitle as string) || "").trim().slice(0, 240),
      hidden: !!hidden,
    }, updatedBy);

    await recordAuditEntry({
      action: "featured.updated",
      performedBy: updatedBy,
      targetType: "settings",
      targetId: `featured:${slot}`,
      metadata: { itemIds: ids, hidden: !!hidden },
    });

    return Response.json({ ok: true, items });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save" }, { status: 500 });
  }
}
