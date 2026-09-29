/** useGitHubEvents — Real-time Firestore subscription for GitHub webhook events. */
"use client";

import { useState, useEffect } from "react";
import { onGitHubEventsByOrg, onGitHubEventsByProject, type GitHubEvent } from "@/lib/firestore";

export function useGitHubEvents(opts: {
  orgId?: string;
  projectId?: string;
  limit?: number;
}) {
  const [events, setEvents] = useState<GitHubEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    let unsub: (() => void) | undefined;

    if (opts.projectId) {
      unsub = onGitHubEventsByProject(
        opts.projectId,
        (evts) => {
          setEvents(evts);
          setLoading(false);
        },
        opts.limit
      );
    } else if (opts.orgId) {
      unsub = onGitHubEventsByOrg(
        opts.orgId,
        (evts) => {
          setEvents(evts);
          setLoading(false);
        },
        opts.limit
      );
    } else {
      setLoading(false);
    }

    return () => unsub?.();
  }, [opts.orgId, opts.projectId, opts.limit]);

  return { events, loading };
}
