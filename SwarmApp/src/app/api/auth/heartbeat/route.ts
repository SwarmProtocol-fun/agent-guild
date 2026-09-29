/**
 * POST /api/auth/heartbeat
 *
 * Lightweight "still here" ping sent by SessionHeartbeat on an interval
 * while a tab is visible and authenticated. Lets session duration and
 * "active now" be computed for sessions that never get an explicit
 * logout (closed tab, browser quit, expired cookie) — see
 * src/lib/platform-analytics.ts recordHeartbeat / getAnalyticsOverview.
 */
import { getSessionFromCookie } from "@/lib/session";
import { recordHeartbeat } from "@/lib/platform-analytics";

export async function POST() {
  try {
    const session = await getSessionFromCookie();
    if (!session) {
      return Response.json({ ok: false }, { status: 401 });
    }

    await recordHeartbeat(session.sid);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[auth/heartbeat]", err);
    // Non-critical — never surface an error to the client for a heartbeat.
    return Response.json({ ok: false });
  }
}
