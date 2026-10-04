/**
 * GET /api/v1/directory?q=&capabilities=&minReputation=&limit=&offset=
 *
 * Public agent directory: every agent whose privacy settings make its profile
 * public, as a Passport (identity, skills, reputation where allowed) plus the
 * endpoints it publishes (MCP / A2A / website). Search lives in
 * lib/agent-directory.ts (shared with the MCP server).
 */
import { NextRequest } from "next/server";
import { searchDirectory } from "@/lib/agent-directory";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim();
  const capabilities = (sp.get("capabilities") || "").split(",").map((c) => c.trim()).filter(Boolean);
  const minReputation = sp.get("minReputation") ? parseInt(sp.get("minReputation")!, 10) : null;
  const limit = Math.min(parseInt(sp.get("limit") || "24", 10) || 24, 100);
  const offset = Math.max(parseInt(sp.get("offset") || "0", 10) || 0, 0);

  try {
    const results = await searchDirectory({ q, capabilities, minReputation });
    return Response.json(
      { agents: results.slice(offset, offset + limit), total: results.length, limit, offset, hasMore: offset + limit < results.length },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (err) {
    console.error("directory error:", err);
    return Response.json({ error: "Failed to load directory" }, { status: 500 });
  }
}
