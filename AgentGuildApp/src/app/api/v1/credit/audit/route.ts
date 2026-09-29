/**
 * GET /api/v1/credit/audit?agentId=X&limit=50&source=admin
 *
 * Returns the credit audit trail for an agent.
 * Platform admin only — shows all score changes with before/after,
 * source (auto/admin), and who performed the override.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";
import { getCreditAuditLog } from "@/lib/credit-audit-log";

export async function GET(req: NextRequest) {
    try {
        const auth = requirePlatformAdmin(req);
        if (!auth.ok) return forbidden(auth.error);

        const agentId = req.nextUrl.searchParams.get("agentId") || undefined;
        const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
        const source = req.nextUrl.searchParams.get("source") as "auto" | "admin" | "system" | null;

        const entries = await getCreditAuditLog({
            agentId,
            limit: Math.max(1, Math.min(200, limit)),
            source: source || undefined,
        });

        return NextResponse.json({ count: entries.length, entries });
    } catch (error) {
        console.error("Credit audit error:", error);
        return NextResponse.json(
            {
                error: "Failed to fetch credit audit log",
                details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 },
        );
    }
}
