/**
 * GET /api/admin/analytics/events — Platform event analytics from PostHog
 *
 * Queries PostHog for all custom events (compute.*, marketplace.*, etc.)
 * and returns counts + daily trends.
 *
 * Query params:
 *   ?days=30 — lookback window (default 30, max 90)
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";

interface EventCount {
  event: string;
  count: number;
}

interface DailyTrend {
  date: string;
  count: number;
}

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  const posthogKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const posthogHost = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
  const projectId = process.env.POSTHOG_PROJECT_ID;

  if (!posthogKey || !projectId) {
    return Response.json({
      ok: true,
      analytics: {
        events: [] as EventCount[],
        dailyTrend: [] as DailyTrend[],
        totalEvents: 0,
        configured: false,
      },
    });
  }

  const days = Math.min(Number(req.nextUrl.searchParams.get("days")) || 30, 90);
  const now = new Date();
  const dateFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const dateTo = now.toISOString().split("T")[0];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${posthogKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Query all custom events
    const eventsRes = await fetch(
      `${posthogHost}/api/projects/${projectId}/insights/trend/`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          events: [
            { id: "compute.computer_start", type: "events" },
            { id: "compute.computer_stop", type: "events" },
            { id: "compute.computer_created", type: "events" },
            { id: "compute.workspace_created", type: "events" },
            { id: "compute.wizard_step", type: "events" },
            { id: "marketplace.search", type: "events" },
            { id: "marketplace.item_installed", type: "events" },
            { id: "marketplace.item_removed", type: "events" },
            { id: "marketplace.checkout_started", type: "events" },
            { id: "marketplace.tab_changed", type: "events" },
            { id: "marketplace.sort_changed", type: "events" },
            { id: "marketplace.rating_submitted", type: "events" },
            { id: "marketplace.submission_started", type: "events" },
            { id: "marketplace.publisher_viewed", type: "events" },
            { id: "$pageview", type: "events" },
            { id: "$pageleave", type: "events" },
            { id: "$autocapture", type: "events" },
          ],
          date_from: dateFrom,
          date_to: dateTo,
          interval: "day",
        }),
      },
    );

    let events: EventCount[] = [];
    let totalEvents = 0;
    const dailyTrend: DailyTrend[] = [];

    if (eventsRes.ok) {
      const data = await eventsRes.json();
      if (data.result) {
        // Aggregate daily totals across all event types
        const dailyMap = new Map<string, number>();

        events = data.result
          .map((r: { label: string; count: number; data?: number[]; labels?: string[] }) => {
            // Accumulate daily data
            if (r.data && r.labels) {
              for (let i = 0; i < r.labels.length; i++) {
                const day = r.labels[i];
                dailyMap.set(day, (dailyMap.get(day) || 0) + (r.data[i] || 0));
              }
            }
            return {
              event: r.label,
              count: r.count || 0,
            };
          })
          .filter((e: EventCount) => e.count > 0)
          .sort((a: EventCount, b: EventCount) => b.count - a.count);

        totalEvents = events.reduce((sum, e) => sum + e.count, 0);

        // Build daily trend from aggregated data
        for (const [date, count] of dailyMap.entries()) {
          dailyTrend.push({ date, count });
        }
        dailyTrend.sort((a, b) => a.date.localeCompare(b.date));
      }
    }

    return Response.json({
      ok: true,
      analytics: {
        events,
        dailyTrend,
        totalEvents,
        configured: true,
      },
    });
  } catch (err) {
    console.error("[admin/analytics/events]", err);
    return Response.json({
      ok: true,
      analytics: {
        events: [],
        dailyTrend: [],
        totalEvents: 0,
        configured: true,
        error: "Failed to fetch from PostHog",
      },
    });
  }
}
