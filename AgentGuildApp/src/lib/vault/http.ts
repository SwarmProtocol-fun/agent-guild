/** Shared plumbing for the /api/vault/* (org dashboard) routes. */

import type { NextRequest } from "next/server";
import { requireOrgAdmin, requireOrgMember } from "@/lib/auth-guard";
import { VaultError } from "./store";

export async function vaultAuth(req: NextRequest, orgId: string | null | undefined, level: "member" | "admin") {
  if (!orgId) return { ok: false as const, response: Response.json({ error: "orgId is required" }, { status: 400 }) };
  const auth = level === "admin" ? await requireOrgAdmin(req, orgId) : await requireOrgMember(req, orgId);
  if (!auth.ok) {
    return { ok: false as const, response: Response.json({ error: auth.error }, { status: auth.status || 403 }) };
  }
  return { ok: true as const, orgId, actor: auth.walletAddress || "unknown" };
}

export function vaultErrorResponse(err: unknown, label: string) {
  if (err instanceof VaultError) return Response.json({ error: err.message }, { status: err.status });
  console.error(`[vault] ${label}:`, err);
  const message = err instanceof Error && err.message.startsWith("Vault not configured") ? err.message : "Vault request failed";
  return Response.json({ error: message }, { status: 500 });
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
