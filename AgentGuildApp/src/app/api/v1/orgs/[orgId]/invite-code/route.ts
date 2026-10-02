/**
 * GET  /api/v1/orgs/:orgId/invite-code — the org's human-member invite code (members only).
 * POST /api/v1/orgs/:orgId/invite-code — rotate it; the old code stops working (owner only).
 *
 * Codes live in server-only orgInvites, not on the org doc — every signed-in
 * wallet can read org docs, so a code stored there was readable by anyone.
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin, requireOrgMember } from "@/lib/auth-guard";
import { getOrCreateOrgInviteCode, rotateOrgInviteCode } from "@/lib/firestore-admin";

type Params = { params: Promise<{ orgId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { orgId } = await params;
  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });

  const inviteCode = await getOrCreateOrgInviteCode(orgId);
  return Response.json({ inviteCode });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });

  const inviteCode = await rotateOrgInviteCode(orgId);
  return Response.json({ inviteCode });
}
