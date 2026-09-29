/**
 * GET /api/v1/mods
 *
 * List all available mods. Public catalog endpoint (no auth required).
 * Query params: category, status, search
 */
import { NextRequest } from "next/server";
import { MOD_REGISTRY } from "@/lib/skills";

export async function GET(req: NextRequest) {
    const url = req.nextUrl;
    const category = url.searchParams.get("category");
    const status = url.searchParams.get("status");
    const search = url.searchParams.get("search");

    let mods = [...MOD_REGISTRY];

    if (category) {
        mods = mods.filter((m) => m.category === category);
    }
    if (status) {
        mods = mods.filter((m) => m.status === status);
    }
    if (search) {
        const q = search.toLowerCase();
        mods = mods.filter(
            (m) =>
                m.name.toLowerCase().includes(q) ||
                m.description.toLowerCase().includes(q) ||
                m.tags?.some((t) => t.toLowerCase().includes(q)),
        );
    }

    return Response.json({ count: mods.length, mods });
}
