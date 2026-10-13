/**
 * Netlify scheduled function — calls POST /api/cron/solana-tick with the internal
 * service secret (see that route for what it does).
 *
 * Requires INTERNAL_SERVICE_SECRET in the site's environment. URL is set by
 * Netlify automatically. Not on Netlify? Any scheduler works — e.g.
 *   curl -X POST "$SITE/api/cron/solana-tick" -H "x-service-secret: $INTERNAL_SERVICE_SECRET"
 */
export default async function handler(): Promise<Response> {
    const site = process.env.URL;
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!site || !secret) {
        console.error("[solana-tick] URL or INTERNAL_SERVICE_SECRET not set — skipping");
        return new Response("not configured", { status: 500 });
    }
    const res = await fetch(`${site}/api/cron/solana-tick`, {
        method: "POST",
        headers: { "x-service-secret": secret },
    });
    const body = await res.text();
    console.log(`[solana-tick] ${res.status} ${body.slice(0, 500)}`);
    return new Response(body, { status: res.status });
}

// Every minute: standing orders and watches should react within a minute of the price.
export const config = { schedule: "* * * * *" };
