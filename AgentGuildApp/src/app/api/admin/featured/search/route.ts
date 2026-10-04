/**
 * GET /api/admin/featured/search?kind=gig|agent|template&q=
 *
 * Candidate picker for the featured admin page — publicly visible items of
 * one kind matching `q`.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import type { FeaturedKind } from "@/lib/featured";
import { searchFeaturedCandidates } from "@/lib/featured-server";

const KINDS: FeaturedKind[] = ["gig", "agent", "template"];

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const kind = req.nextUrl.searchParams.get("kind") as FeaturedKind;
  if (!KINDS.includes(kind)) return Response.json({ error: "Invalid kind" }, { status: 400 });
  const q = req.nextUrl.searchParams.get("q") || "";

  try {
    return Response.json({ ok: true, items: await searchFeaturedCandidates(kind, q) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Search failed" }, { status: 500 });
  }
}
