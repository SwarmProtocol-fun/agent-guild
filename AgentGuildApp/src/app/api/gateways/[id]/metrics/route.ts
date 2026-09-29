/**
 * GET /api/gateways/:id/metrics
 * POST /api/gateways/:id/metrics
 *
 * Get or update gateway metrics.
 */

import { NextRequest } from "next/server";
import { updateGatewayMetrics } from "@/lib/firestore-admin";
import { adminDb } from "@/lib/firebase-admin";
import type { Gateway } from "@/lib/gateways";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: gatewayId } = await params;

  try {
    const gatewayDoc = await adminDb().collection("gateways").doc(gatewayId).get();

    if (!gatewayDoc.exists) {
      return Response.json({ error: "Gateway not found" }, { status: 404 });
    }

    const gateway = { id: gatewayDoc.id, ...gatewayDoc.data() } as Gateway;

    return Response.json({
      ok: true,
      metrics: gateway.metrics || null,
      capacity: gateway.capacity || null,
      lastHeartbeat: gateway.lastHeartbeat || null,
    });
  } catch (err) {
    console.error("Get gateway metrics error:", err);
    return Response.json(
      { error: "Failed to get gateway metrics" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: gatewayId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { metrics, capacity } = body;

  if (!metrics) {
    return Response.json({ error: "metrics is required" }, { status: 400 });
  }

  try {
    await updateGatewayMetrics(
      gatewayId,
      metrics as Gateway["metrics"],
      capacity as Gateway["capacity"] | undefined
    );

    return Response.json({
      ok: true,
      message: "Gateway metrics updated successfully",
    });
  } catch (err) {
    console.error("Update gateway metrics error:", err);
    return Response.json(
      { error: "Failed to update gateway metrics" },
      { status: 500 }
    );
  }
}
