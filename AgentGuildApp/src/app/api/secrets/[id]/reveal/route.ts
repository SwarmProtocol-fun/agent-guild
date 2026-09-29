/**
 * POST /api/secrets/:id/reveal
 *
 * Reveal (decrypt) a secret value.
 * Body: { orgId, masterSecret }
 *
 * Auth: org membership or platform admin.
 */

import { NextRequest } from "next/server";
import { revealSecret } from "@/lib/secrets";
import { requirePlatformAdminOrOrgMember, forbidden } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: secretId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, masterSecret } = body;

  if (!orgId || !masterSecret) {
    return Response.json(
      { error: "orgId and masterSecret are required" },
      { status: 400 }
    );
  }

  const auth = await requirePlatformAdminOrOrgMember(request, orgId as string);
  if (!auth.ok) {
    return forbidden(auth.error);
  }

  try {
    const decryptedValue = await revealSecret(
      secretId,
      orgId as string,
      masterSecret as string
    );

    return Response.json({
      ok: true,
      value: decryptedValue,
    });
  } catch (err) {
    console.error("Reveal secret error:", err);
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reveal secret",
      },
      { status: 500 }
    );
  }
}
