/**
 * GET /api/admin/analytics/pages — Page-level analytics from PostHog
 *
 * Queries PostHog for $pageview events broken down by URL path.
 * Returns top pages by views and a daily pageview trend.
 *
 * Query params:
 *   ?days=30 — lookback window (default 30, max 90)
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";

interface PageStat {
  path: string;
  views: number;
}

interface DailyPageviews {
  date: string;
  views: number;
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
        topPages: [] as PageStat[],
        dailyPageviews: [] as DailyPageviews[],
        totalPageviews: 0,
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
    // Query pageviews broken down by current_url
    const [trendRes, breakdownRes] = await Promise.all([
      // Daily trend
      fetch(`${posthogHost}/api/projects/${projectId}/insights/trend/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          events: [{ id: "$pageview", type: "events" }],
          date_from: dateFrom,
          date_to: dateTo,
          interval: "day",
        }),
      }),
      // Breakdown by path
      fetch(`${posthogHost}/api/projects/${projectId}/insights/trend/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          events: [{ id: "$pageview", type: "events" }],
          date_from: dateFrom,
          date_to: dateTo,
          breakdown: "$pathname",
          breakdown_type: "event",
        }),
      }),
    ]);

    let totalPageviews = 0;
    const dailyPageviews: DailyPageviews[] = [];
    let topPages: PageStat[] = [];

    // Parse daily trend
    if (trendRes.ok) {
      const trendData = await trendRes.json();
      if (trendData.result?.[0]) {
        const series = trendData.result[0];
        totalPageviews = series.count || 0;
        if (series.data && series.labels) {
          for (let i = 0; i < series.labels.length; i++) {
            dailyPageviews.push({
              date: series.labels[i],
              views: series.data[i] || 0,
            });
          }
        }
      }
    }

    // Parse breakdown
    if (breakdownRes.ok) {
      const breakdownData = await breakdownRes.json();
      if (breakdownData.result) {
        topPages = breakdownData.result
          .map((r: { breakdown_value: string; count: number }) => ({
            path: r.breakdown_value || "unknown",
            views: r.count || 0,
          }))
          .filter((p: PageStat) => p.views > 0)
          .sort((a: PageStat, b: PageStat) => b.views - a.views)
          .slice(0, 30);
      }
    }

    return Response.json({
      ok: true,
      analytics: {
        topPages,
        dailyPageviews,
        totalPageviews,
        configured: true,
      },
    });
  } catch (err) {
    console.error("[admin/analytics/pages]", err);
    return Response.json({
      ok: true,
      analytics: {
        topPages: [],
        dailyPageviews: [],
        totalPageviews: 0,
        configured: true,
        error: "Failed to fetch from PostHog",
      },
    });
  }
}
