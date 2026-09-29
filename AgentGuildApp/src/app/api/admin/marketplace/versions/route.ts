/**
 * GET /api/admin/marketplace/versions
 * POST /api/admin/marketplace/versions
 *
 * Version management: list items with version history,
 * revert versions, force version bumps.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

interface VersionItem {
  id: string;
  source: "community" | "agents";
  name: string;
  version: string;
  previousVersion?: string;
  updateOf?: string;
  status: string;
  submittedBy: string;
  submittedAt?: { seconds: number };
  parentItem?: {
    id: string;
    name: string;
    version: string;
    status: string;
  };
}

/** GET — List items with version info */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const filter = req.nextUrl.searchParams.get("filter") || "all";
  const colFilter = req.nextUrl.searchParams.get("collection") || "all";

  try {
    const results: VersionItem[] = [];
    let totalWithVersions = 0;
    let pendingUpdates = 0;
    let totalVersionBumps = 0;

    const collections: { name: string; source: "community" | "agents"; pendingStatus: string }[] = [];
    if (colFilter === "all" || colFilter === "community") {
      collections.push({ name: "communityMarketItems", source: "community", pendingStatus: "pending" });
    }
    if (colFilter === "all" || colFilter === "agents") {
      collections.push({ name: "marketplaceAgents", source: "agents", pendingStatus: "review" });
    }

    for (const col of collections) {
      const snap = await adminDb().collection(col.name).get();

      for (const d of snap.docs) {
        const data = d.data();
        const hasPreviousVersion = !!data.previousVersion;
        const hasUpdateOf = !!data.updateOf;
        const isPending = data.status === col.pendingStatus;

        if (hasPreviousVersion || hasUpdateOf) {
          totalWithVersions++;
          totalVersionBumps++;
        }
        if (hasUpdateOf && isPending) pendingUpdates++;

        // Apply filter
        if (filter === "has_versions" && !hasPreviousVersion && !hasUpdateOf) continue;
        if (filter === "pending_update" && !(hasUpdateOf && isPending)) continue;

        // Only include items with version relevance when filtering, or all items
        if (filter !== "all" && !hasPreviousVersion && !hasUpdateOf) continue;

        const item: VersionItem = {
          id: d.id,
          source: col.source,
          name: data.name || data.title || "Untitled",
          version: data.version || "1.0.0",
          previousVersion: data.previousVersion,
          updateOf: data.updateOf,
          status: data.status || "unknown",
          submittedBy: data.submittedBy || data.authorWallet || "unknown",
          submittedAt: data.submittedAt,
        };

        // Fetch parent item if updateOf exists
        if (data.updateOf) {
          const parentRef = adminDb().collection(col.name).doc(data.updateOf);
          const parentSnap = await parentRef.get();
          if (parentSnap.exists) {
            const parentData = parentSnap.data()!;
            item.parentItem = {
              id: parentSnap.id,
              name: parentData.name || "Untitled",
              version: parentData.version || "1.0.0",
              status: parentData.status || "unknown",
            };
          }
        }

        results.push(item);
      }
    }

    // Sort: pending updates first, then by name
    results.sort((a, b) => {
      if (a.updateOf && !b.updateOf) return -1;
      if (!a.updateOf && b.updateOf) return 1;
      return a.name.localeCompare(b.name);
    });

    return Response.json({
      ok: true,
      stats: { totalWithVersions, pendingUpdates, totalVersionBumps },
      items: results,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch versions",
    }, { status: 500 });
  }
}

/** POST — Version actions */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemId, collection: colParam, newVersion } = body as {
    action: "revert" | "force_bump";
    itemId: string;
    collection?: string;
    newVersion?: string;
  };

  if (!action || !itemId) {
    return Response.json({ error: "action and itemId required" }, { status: 400 });
  }

  const colName = colParam === "agents" ? "marketplaceAgents" : "communityMarketItems";

  try {
    const ref = adminDb().collection(colName).doc(itemId);
    const snap = await ref.get();

    if (!snap.exists) {
      return Response.json({ error: "Item not found" }, { status: 404 });
    }

    const data = snap.data()!;

    switch (action) {
      case "revert": {
        if (!data.updateOf) {
          return Response.json({ error: "Item has no parent to revert to" }, { status: 400 });
        }
        // Set this item to reverted
        await ref.update({
          status: "reverted",
          revertedAt: FieldValue.serverTimestamp(),
        });
        // Ensure parent is still approved
        const parentRef = adminDb().collection(colName).doc(data.updateOf);
        const parentSnap = await parentRef.get();
        if (parentSnap.exists && parentSnap.data()!.status !== "approved") {
          await parentRef.update({ status: "approved" });
        }
        break;
      }

      case "force_bump": {
        if (!newVersion) {
          return Response.json({ error: "newVersion required for force_bump" }, { status: 400 });
        }
        await ref.update({
          previousVersion: data.version || "1.0.0",
          version: newVersion.trim().slice(0, 20),
          updatedAt: FieldValue.serverTimestamp(),
        });
        break;
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    await recordAuditEntry({
      action: `version.${action}`,
      performedBy: "platform-admin",
      targetType: "listing",
      targetId: itemId,
      metadata: {
        collection: colParam || "community",
        previousVersion: data.version,
        newVersion: action === "force_bump" ? newVersion : undefined,
        updateOf: data.updateOf,
      },
    }).catch(() => {});

    return Response.json({
      ok: true,
      action,
      itemId,
      version: action === "force_bump" ? newVersion : data.version,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
