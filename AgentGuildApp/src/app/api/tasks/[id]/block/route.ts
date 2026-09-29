/**
 * POST /api/tasks/[id]/block
 *
 * Block a task with dependent tasks or reason.
 * Body: { orgId, blockedBy?: string[], blockReason?: string }
 */

import { NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { getWalletAddress, requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { rateLimit } from "@/app/api/v1/rate-limit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const limited = await rateLimit(`block:${ip}`);
  if (limited) return limited;

  // Auth: require authenticated user
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return unauthorized("Authentication required");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, blockedBy, blockReason } = body;

  // Verify org membership if orgId provided
  if (orgId) {
    const auth = await requireOrgMember(request, orgId as string);
    if (!auth.ok) {
      return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);
    }
  }

  if (!blockedBy && !blockReason) {
    return Response.json(
      { error: "Either blockedBy or blockReason is required" },
      { status: 400 }
    );
  }

  try {
    await adminDb().collection("kanbanTasks").doc(id).set(
      {
        blockedBy: blockedBy || [],
        blockReason: blockReason || "",
        blockedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return Response.json({
      ok: true,
      message: `Task ${id} has been blocked`,
      blockedBy,
      blockReason,
    });
  } catch (err) {
    console.error("Block task error:", err);
    return Response.json(
      { error: "Failed to block task" },
      { status: 500 }
    );
  }
}
