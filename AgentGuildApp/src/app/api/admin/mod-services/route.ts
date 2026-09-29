/**
 * GET /api/admin/mod-services
 *
 * Lists all registered mod services and their health status.
 *
 * POST /api/admin/mod-services
 *
 * Admin actions: remove, set-status.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  try {
    const snap = await adminDb().collection("modServiceRegistry").get();
    const services = snap.docs.map((d) => ({ slug: d.id, ...d.data() }));

    return Response.json({ ok: true, services });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch mod services",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, slug, status } = body as {
    action: "remove" | "set-status";
    slug: string;
    status?: "active" | "degraded" | "offline";
  };

  if (!action || !slug) {
    return Response.json({ error: "Missing action or slug" }, { status: 400 });
  }

  try {
    const ref = adminDb().collection("modServiceRegistry").doc(slug);
    switch (action) {
      case "remove":
        await ref.delete();
        break;
      case "set-status":
        if (!status) return Response.json({ error: "Missing status" }, { status: 400 });
        await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
        break;
      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Action failed",
    }, { status: 500 });
  }
}
