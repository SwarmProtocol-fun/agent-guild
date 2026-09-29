/**
 * useWorkflowRun — Polling hook for driving and observing workflow execution.
 *
 * Polls the advance endpoint every 1.5s while the run is active, then stops
 * automatically when the run reaches a terminal state.
 */
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { WorkflowRun } from "@/lib/workflow/types";

const POLL_INTERVAL_MS = 1500;

interface UseWorkflowRunResult {
  run: WorkflowRun | null;
  isPolling: boolean;
  error: string | null;
  cancel: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function useWorkflowRun(
  runId: string | null,
  orgId: string,
): UseWorkflowRunResult {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  // Clean up on unmount or runId change
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId]);

  // Start polling when runId is set
  useEffect(() => {
    if (!runId || !orgId) {
      setRun(null);
      setIsPolling(false);
      return;
    }

    activeRef.current = true;
    setIsPolling(true);
    setError(null);

    const poll = async () => {
      if (!activeRef.current) return;

      try {
        // Advance the run by one step
        const res = await fetch(`/api/workflows/runs/${runId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || `HTTP ${res.status}`);
          setIsPolling(false);
          return;
        }

        const data = await res.json();
        const updatedRun = data.run as WorkflowRun;
        setRun(updatedRun);

        if (isTerminal(updatedRun.status)) {
          setIsPolling(false);
          activeRef.current = false;
          return;
        }

        if (updatedRun.status === "paused") {
          // Don't advance while paused, but keep polling for status
          timerRef.current = setTimeout(async () => {
            if (!activeRef.current) return;
            const statusRes = await fetch(
              `/api/workflows/runs/${runId}?orgId=${orgId}`,
            );
            if (statusRes.ok) {
              const statusData = await statusRes.json();
              setRun(statusData.run);
              if (statusData.run.status === "paused") {
                timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
              } else {
                poll();
              }
            }
          }, POLL_INTERVAL_MS * 2);
          return;
        }

        // Schedule next poll
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (activeRef.current) {
          setError(err instanceof Error ? err.message : "Polling failed");
          // Retry after a longer interval on error
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS * 3);
        }
      }
    };

    // Initial fetch to get current state
    fetch(`/api/workflows/runs/${runId}?orgId=${orgId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.run) {
          setRun(data.run);
          if (isTerminal(data.run.status)) {
            setIsPolling(false);
            activeRef.current = false;
            return;
          }
        }
        poll();
      })
      .catch(() => {
        poll();
      });

    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId, orgId]);

  const cancel = useCallback(async () => {
    if (!runId || !orgId) return;
    try {
      await fetch(`/api/workflows/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, action: "cancel" }),
      });
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      setIsPolling(false);
      // Fetch final state
      const res = await fetch(`/api/workflows/runs/${runId}?orgId=${orgId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data.run);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    }
  }, [runId, orgId]);

  const pause = useCallback(async () => {
    if (!runId || !orgId) return;
    try {
      const res = await fetch(`/api/workflows/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, action: "pause" }),
      });
      if (res.ok) {
        const data = await res.json();
        setRun(data.run);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pause failed");
    }
  }, [runId, orgId]);

  const resume = useCallback(async () => {
    if (!runId || !orgId) return;
    try {
      const res = await fetch(`/api/workflows/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, action: "resume" }),
      });
      if (res.ok) {
        const data = await res.json();
        setRun(data.run);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed");
    }
  }, [runId, orgId]);

  return { run, isPolling, error, cancel, pause, resume };
}
