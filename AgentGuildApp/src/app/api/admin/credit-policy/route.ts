/**
 * GET/POST /api/admin/credit-policy
 *
 * Platform admin route for reading/writing the global credit policy config.
 * Stored at Firestore: platformConfig/creditPolicy
 */

import { NextRequest } from "next/server";
import { requirePlatformAdmin, unauthorized } from "@/lib/auth-guard";
import { getCreditPolicyConfig, setCreditPolicyConfig } from "@/lib/credit-policy-settings";

export async function GET(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return unauthorized(auth.error);

    const config = await getCreditPolicyConfig();
    return Response.json(config);
}

export async function POST(req: NextRequest) {
    const auth = requirePlatformAdmin(req);
    if (!auth.ok) return unauthorized(auth.error);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const wallet = req.headers.get("x-wallet-address") || "platform-admin";

    await setCreditPolicyConfig(body, wallet);

    const updated = await getCreditPolicyConfig();
    return Response.json({ success: true, config: updated });
}
