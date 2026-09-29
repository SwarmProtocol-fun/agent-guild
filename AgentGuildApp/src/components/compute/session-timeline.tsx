"use client";

import { Clock, User, Bot, Cpu } from "lucide-react";
import type { ComputerSession } from "@/lib/compute/types";

interface SessionTimelineProps {
  sessions: ComputerSession[];
}

const CONTROLLER_ICONS: Record<string, React.ReactNode> = {
  human: <User className="h-3.5 w-3.5" />,
  agent: <Bot className="h-3.5 w-3.5" />,
  hybrid: <Cpu className="h-3.5 w-3.5" />,
};

export function SessionTimeline({ sessions }: SessionTimelineProps) {
  // Firestore timestamps arrive as Timestamp objects with .toDate(); coerce to native Date
  const toDate = (v: Date | { toDate(): Date } | null | undefined): Date | null => {
    if (!v) return null;
    if (typeof (v as { toDate?: unknown }).toDate === "function") return (v as { toDate(): Date }).toDate();
    if (v instanceof Date) return v;
    return new Date(v as unknown as string | number);
  };

  const formatDuration = (start: Date | null, end: Date | null) => {
    const s = toDate(start);
    if (!s) return "—";
    const e = toDate(end);
    const ms = (e?.getTime() || Date.now()) - s.getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const formatDate = (d: Date | null) => {
    const nd = toDate(d);
    if (!nd) return "—";
    return nd.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  if (sessions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No sessions yet
      </div>
    );
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {sessions.map((session) => (
        <div key={session.id} className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              {CONTROLLER_ICONS[session.controllerType] || <Clock className="h-3.5 w-3.5" />}
            </div>
            <div>
              <p className="text-sm font-medium capitalize">{session.controllerType} session</p>
              <p className="text-xs text-muted-foreground">
                {formatDate(session.startedAt)}
                {session.modelKey && ` · ${session.modelKey}`}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm">{formatDuration(session.startedAt, session.endedAt)}</p>
            <p className="text-xs text-muted-foreground">
              {session.totalActions} actions · {session.totalScreenshots} shots
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
