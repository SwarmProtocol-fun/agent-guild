/**
 * GET /api/v1/capabilities
 *
 * List all capabilities. Public catalog endpoint.
 * Query params: modId, type
 */
import { NextRequest } from "next/server";
import { CAPABILITY_REGISTRY } from "@/lib/skills";

export async function GET(req: NextRequest) {
    const url = req.nextUrl;
    const modId = url.searchParams.get("modId");
    const type = url.searchParams.get("type");

    let capabilities = [...CAPABILITY_REGISTRY];

    if (modId) {
        capabilities = capabilities.filter((c) => c.modId === modId);
    }
    if (type) {
        capabilities = capabilities.filter((c) => c.type === type);
    }

    return Response.json({ count: capabilities.length, capabilities });
}
