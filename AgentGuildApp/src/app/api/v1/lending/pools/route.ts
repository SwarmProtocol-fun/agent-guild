/**
 * GET  /api/v1/lending/pools            — list community lending pools
 * POST /api/v1/lending/pools            — create a new pool (platform admin only)
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { listPools, createPool } from "@/lib/lending/lending-service";

export async function GET() {
    try {
        const pools = await listPools();
        return NextResponse.json({ pools });
    } catch (error) {
        console.error("[lending/pools] GET error:", error);
        return NextResponse.json({ error: "Failed to load pools" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const admin = requirePlatformAdmin(req);
    if (!admin.ok) return forbidden(admin.error || "Platform admin required");

    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { name?: string; description?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.name || typeof body.name !== "string") {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    try {
        const pool = await createPool({ name: body.name, description: body.description, createdBy: wallet });
        return NextResponse.json({ pool }, { status: 201 });
    } catch (error) {
        console.error("[lending/pools] POST error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create pool" }, { status: 500 });
    }
}
