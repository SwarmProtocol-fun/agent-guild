/**
 * GET  /api/compute/admin/pricing — Get current pricing settings
 * POST /api/compute/admin/pricing — Update pricing settings
 *
 * Platform admin only.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getPricingSettings, updatePricingSettings } from "@/lib/compute/firestore";

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const settings = await getPricingSettings();
  return Response.json({ ok: true, settings });
}

export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const userId = req.headers.get("x-wallet-address") || "admin";

  await updatePricingSettings(body, userId);
  const settings = await getPricingSettings();
  return Response.json({ ok: true, settings });
}
