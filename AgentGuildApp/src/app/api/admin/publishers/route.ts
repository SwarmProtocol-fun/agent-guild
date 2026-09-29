/**
 * GET /api/admin/publishers
 *
 * Lists all publisher profiles for admin review.
 * Supports ?tier=0|1|2|3 and ?banned=true filters.
 *
 * POST /api/admin/publishers
 *
 * Admin actions: ban, unban, set-tier.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const tierFilter = url.searchParams.get("tier");
  const bannedFilter = url.searchParams.get("banned");

  try {
    // Note: matches original behavior — a filter replaces the base query
    // (drops ordering); bannedFilter wins if both are set.
    let q: Query = adminDb().collection("publisherProfiles").orderBy("updatedAt", "desc");

    if (tierFilter !== null) {
      q = adminDb().collection("publisherProfiles").where("tier", "==", Number(tierFilter));
    }
    if (bannedFilter === "true") {
      q = adminDb().collection("publisherProfiles").where("banned", "==", true);
    }

    const snap = await q.get();
    const publishers = snap.docs.map((d) => ({ wallet: d.id, ...d.data() }));

    return Response.json({ ok: true, publishers });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch publishers",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, wallet, tier, reason } = body as {
    action: "ban" | "unban" | "set-tier";
    wallet: string;
    tier?: number;
    reason?: string;
  };

  if (!action || !wallet) {
    return Response.json({ error: "Missing action or wallet" }, { status: 400 });
  }

  const ref = adminDb().collection("publisherProfiles").doc(wallet.toLowerCase());

  try {
    switch (action) {
      case "ban":
        await ref.update({
          banned: true,
          banReason: reason || "Banned by admin",
          bannedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        break;
      case "unban":
        await ref.update({
          banned: false,
          banReason: null,
          bannedAt: null,
          cooldownUntil: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        break;
      case "set-tier":
        if (tier === undefined || tier < 0 || tier > 3) {
          return Response.json({ error: "Invalid tier (0-3)" }, { status: 400 });
        }
        await ref.update({ tier, updatedAt: FieldValue.serverTimestamp() });
        break;
      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    await recordAuditEntry({
      action: `publisher.${action}`,
      performedBy: "platform-admin",
      targetType: "publisher",
      targetId: wallet,
      metadata: { reason, tier },
    }).catch(() => {}); // non-blocking

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
