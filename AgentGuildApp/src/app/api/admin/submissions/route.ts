/**
 * GET /api/admin/submissions
 *
 * Lists marketplace submissions pending review across both collections.
 * Supports ?status=pending|approved|rejected&collection=community|agents
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const url = req.nextUrl;
  const statusFilter = url.searchParams.get("status") || "pending";
  const collectionFilter = url.searchParams.get("collection"); // "community" | "agents"
  const limitParam = Number(url.searchParams.get("limit")) || 50;

  try {
    const results: { source: string; id: string; [key: string]: unknown }[] = [];

    // Community items
    if (!collectionFilter || collectionFilter === "community") {
      const statusField = statusFilter === "pending" ? "pending" : statusFilter;
      const snap = await adminDb().collection("communityMarketItems")
        .where("status", "==", statusField)
        .get();
      for (const d of snap.docs) {
        results.push({ source: "community", id: d.id, ...d.data() });
      }
    }

    // Agent marketplace
    if (!collectionFilter || collectionFilter === "agents") {
      const agentStatus = statusFilter === "pending" ? "review" : statusFilter;
      const snap = await adminDb().collection("marketplaceAgents")
        .where("status", "==", agentStatus)
        .get();
      for (const d of snap.docs) {
        results.push({ source: "agents", id: d.id, ...d.data() });
      }
    }

    // Sorted here rather than with orderBy(): status + submittedAt would need a
    // composite index per collection, and a missing one 500s the whole admin page.
    const ts = (v: unknown) =>
      typeof v === "object" && v !== null && "seconds" in v ? Number((v as { seconds: number }).seconds) : 0;
    results.sort((a, b) => ts(b.submittedAt) - ts(a.submittedAt));

    return Response.json({ ok: true, submissions: results.slice(0, limitParam) });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch submissions",
    }, { status: 500 });
  }
}
