/**
 * POST /api/v1/marketplace/checkout
 *
 * Creates a Stripe Checkout Session for mod subscriptions.
 *
 * Input: { modId, plan: "monthly" | "yearly" | "lifetime", orgId }
 * Returns: { ok, url } — redirect user to Stripe Checkout
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY    — Stripe API secret key
 *   NEXT_PUBLIC_APP_URL  — Base URL for success/cancel redirects
 */

import { NextRequest, NextResponse } from "next/server";
import { SKILL_REGISTRY, type SubscriptionPlan } from "@/lib/skills";
// [swarm-core] mod-gateway extracted — remote mod lookup disabled
const getModService = async (_id: string) => null;

export async function POST(req: NextRequest) {
  const wallet = req.headers.get("x-wallet-address")?.toLowerCase();
  if (!wallet) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  const body = await req.json();
  const { modId, plan, orgId } = body as { modId: string; plan: SubscriptionPlan; orgId: string };

  if (!modId || !plan || !orgId) {
    return NextResponse.json({ error: "Missing modId, plan, or orgId" }, { status: 400 });
  }

  if (!["monthly", "yearly", "lifetime"].includes(plan)) {
    return NextResponse.json({ error: "Invalid plan. Must be monthly, yearly, or lifetime" }, { status: 400 });
  }

  // Look up pricing — check static registry first, then remote registry
  const staticMod = SKILL_REGISTRY.find((s) => s.id === modId);
  const remoteMod = !staticMod ? await getModService(modId) : null;
  const pricing = staticMod?.pricing || remoteMod?.pricing;

  if (!pricing || pricing.model === "free") {
    return NextResponse.json({ error: "This mod is free — no checkout needed" }, { status: 400 });
  }

  const tier = pricing.tiers?.find((t) => t.plan === plan);
  if (!tier) {
    return NextResponse.json({ error: `Plan "${plan}" not available for this mod` }, { status: 400 });
  }

  const modName = staticMod?.name || remoteMod?.name || modId;
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  try {
    // Create Stripe Checkout Session via REST API (no SDK dependency needed)
    const params = new URLSearchParams();
    params.set("mode", plan === "lifetime" ? "payment" : "subscription");
    params.set("success_url", `${appUrl}/market?checkout=success&mod=${modId}`);
    params.set("cancel_url", `${appUrl}/market?checkout=cancelled&mod=${modId}`);
    params.set("metadata[orgId]", orgId);
    params.set("metadata[itemId]", modId);
    params.set("metadata[plan]", plan);
    params.set("metadata[subscribedBy]", wallet);
    params.set("line_items[0][price_data][currency]", tier.currency?.toLowerCase() || "usd");
    params.set("line_items[0][price_data][unit_amount]", String(Math.round(tier.price * 100)));
    params.set("line_items[0][price_data][product_data][name]", `${modName} — ${plan}`);
    params.set("line_items[0][price_data][product_data][description]", `${plan} subscription to ${modName}`);
    params.set("line_items[0][quantity]", "1");

    if (plan !== "lifetime") {
      const interval = plan === "monthly" ? "month" : "year";
      params.set("line_items[0][price_data][recurring][interval]", interval);
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe checkout error:", session);
      return NextResponse.json(
        { error: session.error?.message || "Failed to create checkout session" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
