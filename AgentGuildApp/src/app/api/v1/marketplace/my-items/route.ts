/**
 * GET /api/v1/marketplace/my-items
 *
 * List all marketplace items published by the authenticated wallet.
 * Includes both community items (mods, plugins, skills, skins) and agent packages.
 *
 * Query params:
 *   ?type=mod|plugin|skill|skin|agent  (optional filter)
 *   ?status=pending|approved|rejected  (optional filter)
 *
 * Auth: x-wallet-address header
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getUserSubmissions, getCreatorPackages } from "@/lib/firestore-admin";

export async function GET(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) {
        return Response.json(
            { error: "Missing x-wallet-address header" },
            { status: 401 },
        );
    }

    const typeFilter = req.nextUrl.searchParams.get("type");
    const statusFilter = req.nextUrl.searchParams.get("status");

    try {
        // Fetch both community items and agent packages in parallel
        const [communityItems, agentPackages] = await Promise.all([
            typeFilter === "agent" ? Promise.resolve([]) : getUserSubmissions(wallet),
            typeFilter && typeFilter !== "agent" ? Promise.resolve([]) : getCreatorPackages(wallet),
        ]);

        // Normalize community items
        const community = communityItems.map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            category: item.category,
            icon: item.icon,
            description: item.description,
            version: item.version,
            status: item.status,
            submittedAt: item.submittedAt,
            pricing: item.pricing,
            tags: item.tags,
            collection: "community" as const,
        }));

        // Normalize agent packages
        const agents = agentPackages.map((pkg) => ({
            id: pkg.id,
            name: pkg.name,
            type: "agent" as const,
            category: pkg.category,
            icon: pkg.icon,
            description: pkg.description,
            version: pkg.version,
            status: pkg.status,
            submittedAt: pkg.publishedAt,
            pricing: pkg.pricing,
            tags: pkg.tags,
            collection: "agents" as const,
            installCount: pkg.installCount,
            avgRating: pkg.avgRating,
            ratingCount: pkg.ratingCount,
        }));

        let items = [...community, ...agents];

        // Apply filters
        if (typeFilter) {
            items = items.filter((i) => i.type === typeFilter);
        }
        if (statusFilter) {
            items = items.filter((i) => i.status === statusFilter);
        }

        return Response.json({
            wallet,
            count: items.length,
            items,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to fetch items" },
            { status: 500 },
        );
    }
}
