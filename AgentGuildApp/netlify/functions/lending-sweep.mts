/**
 * Netlify scheduled function — runs the lending sweep hourly by calling
 * POST /api/cron/lending-sweep with the internal service secret.
 *
 * Requires INTERNAL_SERVICE_SECRET in the site's environment. URL is set by
 * Netlify automatically. Not on Netlify? Any scheduler works — e.g.
 *   curl -X POST "$SITE/api/cron/lending-sweep" -H "x-service-secret: $INTERNAL_SERVICE_SECRET"
 */
export default async function handler(): Promise<Response> {
    const site = process.env.URL;
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!site || !secret) {
        console.error("[lending-sweep] URL or INTERNAL_SERVICE_SECRET not set — skipping");
        return new Response("not configured", { status: 500 });
    }
    const res = await fetch(`${site}/api/cron/lending-sweep`, {
        method: "POST",
        headers: { "x-service-secret": secret },
    });
    const body = await res.text();
    console.log(`[lending-sweep] ${res.status} ${body.slice(0, 500)}`);
    return new Response(body, { status: res.status });
}

export const config = { schedule: "@hourly" };
