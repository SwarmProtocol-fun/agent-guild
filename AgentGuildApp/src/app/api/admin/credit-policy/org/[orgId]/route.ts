/**
 * GET/POST /api/admin/credit-policy/org/[orgId]
 *
 * Org admin or platform admin route for reading/writing per-org policy overrides.
 * Stored at Firestore: orgPolicies/{orgId}
 */

import { NextRequest } from "next/server";
import {
    requirePlatformAdmin,
    requireOrgAdmin,
    unauthorized,
    forbidden,
} from "@/lib/auth-guard";
import { getOrgPolicyOverride, setOrgPolicyOverride } from "@/lib/credit-policy-settings";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ orgId: string }> },
) {
    const { orgId } = await params;

    // Allow platform admin or org admin
    const adminCheck = requirePlatformAdmin(req);
    if (!adminCheck.ok) {
        const orgCheck = await requireOrgAdmin(req, orgId);
        if (!orgCheck.ok) return unauthorized(orgCheck.error);
    }

    const override = await getOrgPolicyOverride(orgId);
    return Response.json({ orgId, override: override || null });
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ orgId: string }> },
) {
    const { orgId } = await params;

    // Allow platform admin or org admin
    const adminCheck = requirePlatformAdmin(req);
    if (!adminCheck.ok) {
        const orgCheck = await requireOrgAdmin(req, orgId);
        if (!orgCheck.ok) return forbidden(orgCheck.error);
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const wallet = req.headers.get("x-wallet-address") || "admin";

    await setOrgPolicyOverride(orgId, body, wallet);

    const updated = await getOrgPolicyOverride(orgId);
    return Response.json({ success: true, orgId, override: updated });
}
