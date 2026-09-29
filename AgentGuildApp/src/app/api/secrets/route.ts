/**
 * GET /api/secrets - List all secrets (masked)
 * POST /api/secrets - Create new encrypted secret
 *
 * Query: ?orgId=xxx
 * Body: { orgId, key, value, createdBy, masterSecret, tags?, description? }
 */

import { NextRequest } from "next/server";
import { getSecrets, storeSecret } from "@/lib/secrets";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`secrets:${ip}`);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Auth: caller must be a member of the org
  const auth = await requireOrgMember(request, orgId);
  if (!auth.ok) {
    return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
  }

  try {
    const secrets = await getSecrets(orgId);

    // Remove sensitive fields before sending
    const masked = secrets.map((s) => ({
      id: s.id,
      key: s.key,
      maskedPreview: s.maskedPreview,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      lastAccessedAt: s.lastAccessedAt,
      accessCount: s.accessCount,
      tags: s.tags,
      description: s.description,
    }));

    return Response.json({
      ok: true,
      secrets: masked,
      count: masked.length,
    });
  } catch (err) {
    console.error("Get secrets error:", err);
    return Response.json(
      { error: "Failed to get secrets" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`secrets:${ip}`);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, key, value, createdBy, masterSecret, tags, description } = body;

  if (!orgId || !key || !value || !createdBy || !masterSecret) {
    return Response.json(
      {
        error: "orgId, key, value, createdBy, and masterSecret are required",
      },
      { status: 400 }
    );
  }

  // Auth: caller must be a member of the org
  const auth = await requireOrgMember(request, orgId as string);
  if (!auth.ok) {
    return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
  }

  try {
    const secretId = await storeSecret(
      orgId as string,
      key as string,
      value as string,
      createdBy as string,
      masterSecret as string,
      {
        tags: tags as string[] | undefined,
        description: description as string | undefined,
      }
    );

    return Response.json({
      ok: true,
      secretId,
      message: "Secret stored successfully",
    });
  } catch (err) {
    console.error("Store secret error:", err);
    return Response.json(
      { error: "Failed to store secret" },
      { status: 500 }
    );
  }
}
