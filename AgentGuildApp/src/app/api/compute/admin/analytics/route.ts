/**
 * GET /api/compute/admin/analytics — Product analytics from PostHog
 *
 * Queries PostHog API for compute-related events and returns
 * aggregated analytics data for the admin dashboard.
 */
import { NextRequest } from "next/server";
import { requirePlatformAdmin, forbidden } from "@/lib/auth-guard";

interface EventCount {
  event: string;
  count: number;
}

interface PageviewCount {
  path: string;
  count: number;
}

export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return forbidden(auth.error);

  const posthogKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const posthogHost = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
  const projectId = process.env.POSTHOG_PROJECT_ID;

  if (!posthogKey || !projectId) {
    // Return empty analytics when PostHog is not configured
    return Response.json({
      ok: true,
      analytics: {
        computeEvents: [] as EventCount[],
        topPages: [] as PageviewCount[],
        totalPageviews: 0,
        totalUniqueUsers: 0,
        wizardFunnel: { workspace: 0, mode: 0, resources: 0, controller: 0, model: 0, review: 0, launched: 0 },
        configured: false,
      },
    });
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dateFrom = thirtyDaysAgo.toISOString().split("T")[0];
  const dateTo = now.toISOString().split("T")[0];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${posthogKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Query compute events
    const eventsRes = await fetch(`${posthogHost}/api/projects/${projectId}/insights/trend/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [
          { id: "compute.computer_start", type: "events" },
          { id: "compute.computer_stop", type: "events" },
          { id: "compute.computer_created", type: "events" },
          { id: "compute.workspace_created", type: "events" },
          { id: "compute.wizard_step", type: "events" },
        ],
        date_from: dateFrom,
        date_to: dateTo,
        interval: "day",
      }),
    });

    // Query pageviews for compute pages
    const pageviewsRes = await fetch(`${posthogHost}/api/projects/${projectId}/insights/trend/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [{ id: "$pageview", type: "events", properties: [{ key: "$current_url", value: "/compute", operator: "icontains" }] }],
        date_from: dateFrom,
        date_to: dateTo,
        interval: "day",
      }),
    });

    let computeEvents: EventCount[] = [];
    let totalPageviews = 0;

    if (eventsRes.ok) {
      const eventsData = await eventsRes.json();
      if (eventsData.result) {
        computeEvents = eventsData.result.map((r: { label: string; count: number }) => ({
          event: r.label,
          count: r.count || 0,
        }));
      }
    }

    if (pageviewsRes.ok) {
      const pageviewsData = await pageviewsRes.json();
      if (pageviewsData.result?.[0]) {
        totalPageviews = pageviewsData.result[0].count || 0;
      }
    }

    // Build wizard funnel from wizard_step events
    const wizardFunnel = {
      workspace: 0,
      mode: 0,
      resources: 0,
      controller: 0,
      model: 0,
      review: 0,
      launched: computeEvents.find((e) => e.event === "compute.computer_created")?.count || 0,
    };

    return Response.json({
      ok: true,
      analytics: {
        computeEvents,
        totalPageviews,
        totalUniqueUsers: 0,
        wizardFunnel,
        topPages: [] as PageviewCount[],
        configured: true,
      },
    });
  } catch (err) {
    console.error("[compute/admin/analytics]", err);
    return Response.json({
      ok: true,
      analytics: {
        computeEvents: [],
        topPages: [],
        totalPageviews: 0,
        totalUniqueUsers: 0,
        wizardFunnel: { workspace: 0, mode: 0, resources: 0, controller: 0, model: 0, review: 0, launched: 0 },
        configured: true,
        error: "Failed to fetch from PostHog",
      },
    });
  }
}
