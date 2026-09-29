/**
 * SessionHeartbeat — global invisible component that pings the server
 * periodically while the user is authenticated and the tab is visible.
 *
 * Fixes a real gap in session-duration tracking: duration used to only get
 * recorded on an explicit "disconnect wallet" click. Most sessions end by
 * the user just closing the tab, so most sessions had no duration at all.
 * This heartbeat gives platform-analytics.ts a `lastActiveAt` to fall back
 * on for those sessions. See src/lib/platform-analytics.ts recordHeartbeat.
 *
 * Mounted once in layout.tsx, inside SessionProvider.
 */
"use client";

import { useEffect } from "react";
import { useSession } from "@/contexts/SessionContext";

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s — well under the 5-min "active now" window

function ping() {
  fetch("/api/auth/heartbeat", { method: "POST", credentials: "include" }).catch(() => {});
}

export default function SessionHeartbeat() {
  const { authenticated } = useSession();

  useEffect(() => {
    if (!authenticated) return;

    // Ping immediately on becoming authenticated, then on an interval —
    // only while the tab is actually visible, so background tabs don't
    // inflate "active now" or session duration.
    ping();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") ping();
    }, HEARTBEAT_INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") ping();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authenticated]);

  return null;
}
