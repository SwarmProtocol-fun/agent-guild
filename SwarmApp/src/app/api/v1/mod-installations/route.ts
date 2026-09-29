/**
 * GET /api/v1/mod-installations
 *
 * Get all mod installations for an org.
 * Query params: orgId (required)
 */
import { NextRequest } from "next/server";
import { getModById } from "@/lib/skills";
import { getModInstallations } from "@/lib/firestore-admin";
import { requireOrgMember, forbidden } from "@/lib/auth-guard";

export async function GET(req: NextRequest) {
    const orgId = req.nextUrl.searchParams.get("orgId");

    if (!orgId) {
        return Response.json({ error: "orgId parameter is required" }, { status: 400 });
    }

    // Auth: require org membership to view installation details
    const auth = await requireOrgMember(req, orgId);
    if (!auth.ok) return forbidden(auth.error);

    try {
        const installations = await getModInstallations(orgId);

        // Enrich with mod metadata
        const enriched = installations.map((inst) => {
            const mod = getModById(inst.modId);
            return {
                ...inst,
                modName: mod?.name ?? "Unknown",
                modSlug: mod?.slug,
                modVendor: mod?.vendor,
            };
        });

        return Response.json({
            orgId,
            count: enriched.length,
            installations: enriched,
        });
    } catch (err) {
        console.error("mod-installations error:", err);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
