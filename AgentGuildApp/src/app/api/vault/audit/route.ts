/**
 * GET /api/vault/audit?orgId=&limit=  — newest-first vault audit entries plus
 * an integrity check of the returned window of the hash chain.
 */
import { NextRequest } from "next/server";
import { listAudit, verifyAuditWindow } from "@/lib/vault/store";
import { vaultAuth, vaultErrorResponse } from "@/lib/vault/http";

export async function GET(req: NextRequest) {
  const auth = await vaultAuth(req, req.nextUrl.searchParams.get("orgId"), "member");
  if (!auth.ok) return auth.response;
  try {
    const limit = Math.max(1, Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500));
    const entries = await listAudit(auth.orgId, limit);
    return Response.json({ entries, chain: verifyAuditWindow(entries) });
  } catch (err) {
    return vaultErrorResponse(err, "list audit");
  }
}
