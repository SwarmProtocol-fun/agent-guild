/**
 * GET /api/gateways/select
 *
 * Select the best gateway based on geographic location and health metrics.
 * Query: ?orgId=xxx&lat=XX.XX&lon=YY.YY
 */

import { NextRequest } from "next/server";
import { selectGateway } from "@/lib/firestore-admin";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const userLat = lat ? parseFloat(lat) : undefined;
    const userLon = lon ? parseFloat(lon) : undefined;

    const result = await selectGateway(orgId, userLat, userLon);

    if (!result) {
      return Response.json(
        { error: "No available gateways found" },
        { status: 404 }
      );
    }

    return Response.json({
      ok: true,
      selection: result,
    });
  } catch (err) {
    console.error("Select gateway error:", err);
    return Response.json(
      { error: "Failed to select gateway" },
      { status: 500 }
    );
  }
}
