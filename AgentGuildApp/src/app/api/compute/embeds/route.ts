/**
 * GET  /api/compute/embeds?workspaceId=xxx  — List embed tokens
 * POST /api/compute/embeds                  — Create embed token
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { getEmbedTokens, getWorkspace } from "@/lib/compute/firestore";
import { generateEmbedToken } from "@/lib/compute/embed";
import type { EmbedMode } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return Response.json({ error: "workspaceId required" }, { status: 400 });

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const tokens = await getEmbedTokens(workspaceId);
  return Response.json({ ok: true, tokens });
}

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, computerId, mode, allowedOrigins, expiresInMs } = body as {
    workspaceId: string;
    computerId: string;
    mode: EmbedMode;
    allowedOrigins?: string[];
    expiresInMs?: number;
  };

  if (!workspaceId || !computerId || !mode) {
    return Response.json({ error: "workspaceId, computerId, and mode are required" }, { status: 400 });
  }
  if (mode !== "read_only" && mode !== "interactive") {
    return Response.json({ error: "mode must be 'read_only' or 'interactive'" }, { status: 400 });
  }
  if (allowedOrigins && (!Array.isArray(allowedOrigins) || allowedOrigins.length > 20)) {
    return Response.json({ error: "allowedOrigins must be an array with at most 20 entries" }, { status: 400 });
  }
  if (expiresInMs !== undefined && (typeof expiresInMs !== "number" || expiresInMs < 60000 || expiresInMs > 86400000 * 365)) {
    return Response.json({ error: "expiresInMs must be between 60000 (1 min) and 31536000000 (1 year)" }, { status: 400 });
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const tokenId = await generateEmbedToken(
    workspaceId,
    computerId,
    mode,
    allowedOrigins || ["*"],
    wallet,
    expiresInMs,
  );

  return Response.json({ ok: true, tokenId }, { status: 201 });
}
