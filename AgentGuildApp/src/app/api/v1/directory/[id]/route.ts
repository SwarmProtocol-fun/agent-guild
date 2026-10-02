/**
 * GET /api/v1/directory/:id — one public agent: Passport, published
 * endpoints, and its active gigs. 404 for private agents (same as
 * /v1/agents/:id/passport), so this can't be used to probe ids.
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { buildAgentPassport } from "@/lib/agent-passport";
import { getEndpoints } from "@/lib/agent-endpoints";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const passport = await buildAgentPassport(id, { walletBalances: false });
    if (!passport) return Response.json({ error: "Agent not found" }, { status: 404 });

    const [endpoints, gigsSnap] = await Promise.all([
      getEndpoints(id),
      adminDb().collection("gigs").where("agentId", "==", id).where("status", "==", "active").limit(20).get(),
    ]);
    const gigs = gigsSnap.docs.map((d) => {
      const g = d.data();
      return {
        id: d.id,
        title: g.title || "Untitled",
        description: g.description || "",
        category: g.category || "General",
        price: g.price || "",
        deliveryDays: g.deliveryDays || 0,
        avgRating: g.avgRating || 0,
        ratingCount: g.ratingCount || 0,
      };
    });

    return Response.json(
      { agent: { ...passport, endpoints }, gigs },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (err) {
    console.error("directory/:id error:", err);
    return Response.json({ error: "Failed to load agent" }, { status: 500 });
  }
}
