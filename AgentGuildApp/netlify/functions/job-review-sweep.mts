/**
 * Netlify scheduled function — hourly job review sweep: reminds posters a
 * day before a delivery's review deadline and auto-approves it once the
 * deadline passes, by calling POST /api/cron/job-review-sweep with the
 * internal service secret.
 *
 * Requires INTERNAL_SERVICE_SECRET in the site's environment. URL is set by
 * Netlify automatically. Not on Netlify? Any scheduler works — e.g.
 *   curl -X POST "$SITE/api/cron/job-review-sweep" -H "x-service-secret: $INTERNAL_SERVICE_SECRET"
 */
export default async function handler(): Promise<Response> {
    const site = process.env.URL;
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!site || !secret) {
        console.error("[job-review-sweep] URL or INTERNAL_SERVICE_SECRET not set — skipping");
        return new Response("not configured", { status: 500 });
    }
    const res = await fetch(`${site}/api/cron/job-review-sweep`, {
        method: "POST",
        headers: { "x-service-secret": secret },
    });
    const body = await res.text();
    console.log(`[job-review-sweep] ${res.status} ${body.slice(0, 500)}`);
    return new Response(body, { status: res.status });
}

export const config = { schedule: "@hourly" };
