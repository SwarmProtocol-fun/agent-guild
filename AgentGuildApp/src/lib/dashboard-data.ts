/**
 * Dashboard data aggregation helpers.
 * Pure transform functions — no Firestore calls.
 */

import type { Task, Agent } from "./firestore";
import type { ActivityEvent } from "./activity";

// ── Types ──

export interface TaskVelocityPoint {
  date: string; // "Mon", "Tue", etc.
  created: number;
  completed: number;
}

export interface AgentWorkloadItem {
  name: string;
  completed: number;
  inProgress: number;
}

export interface ActivityHeatmapPoint {
  hour: string; // "12a", "1a", …, "11p"
  count: number;
}

// ── Helpers ──

function parseTimestamp(ts: unknown): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts === "object" && ts !== null && "seconds" in ts) {
    return new Date((ts as { seconds: number }).seconds * 1000);
  }
  if (typeof ts === "object" && ts !== null && "toMillis" in ts) {
    return new Date((ts as { toMillis: () => number }).toMillis());
  }
  if (typeof ts === "string" || typeof ts === "number") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHour(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

// ── Compute Functions ──

export function computeTaskVelocity(tasks: Task[], days = 14): TaskVelocityPoint[] {
  const now = Date.now();
  const buckets: Map<string, { created: number; completed: number }> = new Map();

  // Initialize buckets for last N days
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = SHORT_DAYS[d.getDay()];
    // Use index to avoid duplicate day-name collisions within a 14-day span
    const label = `${key} ${d.getMonth() + 1}/${d.getDate()}`;
    buckets.set(label, { created: 0, completed: 0 });
  }

  const cutoff = now - days * 86400000;

  for (const task of tasks) {
    const created = parseTimestamp(task.createdAt);
    if (created && created.getTime() > cutoff) {
      const label = `${SHORT_DAYS[created.getDay()]} ${created.getMonth() + 1}/${created.getDate()}`;
      const b = buckets.get(label);
      if (b) b.created++;
    }
    if (task.status === "done") {
      const completed = parseTimestamp((task as any).completedAt || (task as any).updatedAt);
      if (completed && completed.getTime() > cutoff) {
        const label = `${SHORT_DAYS[completed.getDay()]} ${completed.getMonth() + 1}/${completed.getDate()}`;
        const b = buckets.get(label);
        if (b) b.completed++;
      }
    }
  }

  return Array.from(buckets.entries()).map(([date, v]) => ({
    date,
    created: v.created,
    completed: v.completed,
  }));
}

export function computeAgentWorkload(tasks: Task[], agents: Agent[], topN = 5): AgentWorkloadItem[] {
  const map: Map<string, { name: string; completed: number; inProgress: number }> = new Map();

  for (const task of tasks) {
    if (!task.assigneeAgentId) continue;
    if (!map.has(task.assigneeAgentId)) {
      const agent = agents.find((a) => a.id === task.assigneeAgentId);
      map.set(task.assigneeAgentId, {
        name: agent?.name || task.assigneeAgentId.slice(0, 8),
        completed: 0,
        inProgress: 0,
      });
    }
    const entry = map.get(task.assigneeAgentId)!;
    if (task.status === "done") entry.completed++;
    else if (task.status === "in_progress") entry.inProgress++;
  }

  return Array.from(map.values())
    .sort((a, b) => b.completed + b.inProgress - (a.completed + a.inProgress))
    .slice(0, topN);
}

export function computeActivityByHour(events: ActivityEvent[]): ActivityHeatmapPoint[] {
  const counts = new Array(24).fill(0);

  for (const event of events) {
    if (event.createdAt) {
      counts[event.createdAt.getHours()]++;
    }
  }

  return counts.map((count, h) => ({
    hour: formatHour(h),
    count,
  }));
}
