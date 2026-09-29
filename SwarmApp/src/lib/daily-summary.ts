/**
 * Daily Summary / Standup Generator
 *
 * Automatically generates daily activity reports for agents.
 * Aggregates activity events from the last 24 hours and formats
 * them into readable standups.
 *
 * Features:
 * - Aggregate tasks completed, tokens used, cost, errors
 * - Template-based formatting
 * - Manual and cron-triggered generation
 * - Delivery to channels or email
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getActivityFeed, type ActivityEvent } from "./activity";
import { getUsageRecords } from "./usage";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface DailySummary {
  id: string;
  orgId: string;
  agentId: string;
  agentName: string;
  date: string; // YYYY-MM-DD
  summary: SummaryData;
  deliveredTo: string[];
  createdAt: Date | null;
}

export interface SummaryData {
  tasksCompleted: number;
  tasksFailed: number;
  messagesPosted: number;
  tokensUsed: number;
  costUsd: number;
  topActivities: ActivitySummary[];
  errors: ErrorSummary[];
  highlights: string[];
}

export interface ActivitySummary {
  type: string;
  count: number;
  details: string;
}

export interface ErrorSummary {
  type: string;
  count: number;
  lastError: string;
}

export interface SummaryTemplate {
  format: "text" | "markdown" | "html";
  includeStats: boolean;
  includeErrors: boolean;
  includeHighlights: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Summary Generation
// ═══════════════════════════════════════════════════════════════

export async function generateDailySummary(
  orgId: string,
  agentId: string,
  agentName: string,
  date?: string // YYYY-MM-DD, defaults to today
): Promise<string> {
  const targetDate = date || new Date().toISOString().split("T")[0];

  // Get activity events for the target date
  const activities = await getActivitiesForDate(orgId, agentId, targetDate);

  // Get usage records for the target date
  const usage = await getUsageForDate(orgId, agentId, targetDate);

  // Aggregate data
  const summaryData = aggregateSummaryData(activities, usage);

  // Save to Firestore
  const ref = await adminDb().collection("dailySummaries").add({
    orgId,
    agentId,
    agentName,
    date: targetDate,
    summary: summaryData,
    deliveredTo: [],
    createdAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}

async function getActivitiesForDate(
  orgId: string,
  agentId: string,
  date: string
): Promise<ActivityEvent[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const snap = await adminDb()
    .collection("activityLog")
    .where("orgId", "==", orgId)
    .where("agentId", "==", agentId)
    .where("timestamp", ">=", Timestamp.fromDate(startOfDay))
    .where("timestamp", "<=", Timestamp.fromDate(endOfDay))
    .orderBy("timestamp", "desc")
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      projectId: data.projectId,
      eventType: data.eventType,
      actorType: data.actorType || "agent",
      actorId: data.actorId || data.agentId,
      actorName: data.actorName || data.agentName,
      targetType: data.targetType,
      targetId: data.targetId,
      targetName: data.targetName,
      description: data.description || data.details || "",
      metadata: data.metadata || data.details,
      createdAt: data.createdAt?.toDate() || data.timestamp?.toDate() || null,
    } as ActivityEvent;
  });
}

async function getUsageForDate(orgId: string, agentId: string, date: string) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const snap = await adminDb()
    .collection("usageRecords")
    .where("orgId", "==", orgId)
    .where("agentId", "==", agentId)
    .where("timestamp", ">=", Timestamp.fromDate(startOfDay))
    .where("timestamp", "<=", Timestamp.fromDate(endOfDay))
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      tokensIn: data.tokensIn || 0,
      tokensOut: data.tokensOut || 0,
      costUsd: data.costUsd || 0,
    };
  });
}

function aggregateSummaryData(
  activities: ActivityEvent[],
  usage: Array<{ tokensIn: number; tokensOut: number; costUsd: number }>
): SummaryData {
  const activityCounts = new Map<string, number>();
  const errorCounts = new Map<string, string[]>();
  const highlights: string[] = [];

  let tasksCompleted = 0;
  let tasksFailed = 0;
  const messagesPosted = 0;

  // Aggregate activities
  for (const activity of activities) {
    const type = activity.eventType;
    activityCounts.set(type, (activityCounts.get(type) || 0) + 1);

    if (type === "task.completed") tasksCompleted++;
    if (type === "task.failed") tasksFailed++;

    // Collect errors from failed tasks
    if (type === "task.failed") {
      if (!errorCounts.has(type)) {
        errorCounts.set(type, []);
      }
      errorCounts.get(type)!.push(activity.description || "Unknown error");
    }

    // Highlight important events
    if (["cron.created", "cron.triggered", "skill.installed"].includes(type)) {
      highlights.push(`${type}: ${activity.description || ""}`.trim());
    }
  }

  // Aggregate usage
  const totalTokens = usage.reduce((sum, u) => sum + u.tokensIn + u.tokensOut, 0);
  const totalCost = usage.reduce((sum, u) => sum + u.costUsd, 0);

  // Top activities
  const topActivities: ActivitySummary[] = Array.from(activityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({
      type,
      count,
      details: `${count} ${type.replace(/_/g, " ")} event${count > 1 ? "s" : ""}`,
    }));

  // Error summaries
  const errors: ErrorSummary[] = Array.from(errorCounts.entries()).map(([type, messages]) => ({
    type,
    count: messages.length,
    lastError: messages[messages.length - 1],
  }));

  return {
    tasksCompleted,
    tasksFailed,
    messagesPosted,
    tokensUsed: totalTokens,
    costUsd: totalCost,
    topActivities,
    errors,
    highlights: highlights.slice(0, 3), // Top 3 highlights
  };
}

// ═══════════════════════════════════════════════════════════════
// Summary Formatting
// ═══════════════════════════════════════════════════════════════

export function formatSummary(
  summary: DailySummary,
  template: SummaryTemplate = { format: "markdown", includeStats: true, includeErrors: true, includeHighlights: true }
): string {
  const { agentName, date, summary: data } = summary;

  if (template.format === "markdown") {
    let md = `# Daily Standup: ${agentName}\n`;
    md += `**Date:** ${date}\n\n`;

    if (template.includeStats) {
      md += `## 📊 Stats\n`;
      md += `- **Tasks Completed:** ${data.tasksCompleted}\n`;
      md += `- **Tasks Failed:** ${data.tasksFailed}\n`;
      md += `- **Messages Posted:** ${data.messagesPosted}\n`;
      md += `- **Tokens Used:** ${(data.tokensUsed / 1000).toFixed(1)}K\n`;
      md += `- **Cost:** $${data.costUsd.toFixed(4)}\n\n`;
    }

    if (template.includeHighlights && data.highlights.length > 0) {
      md += `## ✨ Highlights\n`;
      data.highlights.forEach((h) => {
        md += `- ${h}\n`;
      });
      md += `\n`;
    }

    if (data.topActivities.length > 0) {
      md += `## 🎯 Top Activities\n`;
      data.topActivities.forEach((a) => {
        md += `- **${a.type.replace(/_/g, " ")}:** ${a.count} times\n`;
      });
      md += `\n`;
    }

    if (template.includeErrors && data.errors.length > 0) {
      md += `## ⚠️ Errors\n`;
      data.errors.forEach((e) => {
        md += `- **${e.type}** (${e.count}x): ${e.lastError}\n`;
      });
      md += `\n`;
    }

    return md;
  }

  if (template.format === "text") {
    let text = `Daily Standup: ${agentName}\n`;
    text += `Date: ${date}\n\n`;

    if (template.includeStats) {
      text += `Stats:\n`;
      text += `  Tasks Completed: ${data.tasksCompleted}\n`;
      text += `  Tasks Failed: ${data.tasksFailed}\n`;
      text += `  Messages Posted: ${data.messagesPosted}\n`;
      text += `  Tokens Used: ${(data.tokensUsed / 1000).toFixed(1)}K\n`;
      text += `  Cost: $${data.costUsd.toFixed(4)}\n\n`;
    }

    if (template.includeHighlights && data.highlights.length > 0) {
      text += `Highlights:\n`;
      data.highlights.forEach((h) => {
        text += `  - ${h}\n`;
      });
      text += `\n`;
    }

    if (data.topActivities.length > 0) {
      text += `Top Activities:\n`;
      data.topActivities.forEach((a) => {
        text += `  - ${a.details}\n`;
      });
      text += `\n`;
    }

    if (template.includeErrors && data.errors.length > 0) {
      text += `Errors:\n`;
      data.errors.forEach((e) => {
        text += `  - ${e.type} (${e.count}x): ${e.lastError}\n`;
      });
      text += `\n`;
    }

    return text;
  }

  // HTML format
  let html = `<div style="font-family: sans-serif;">`;
  html += `<h1>Daily Standup: ${agentName}</h1>`;
  html += `<p><strong>Date:</strong> ${date}</p>`;

  if (template.includeStats) {
    html += `<h2>📊 Stats</h2><ul>`;
    html += `<li><strong>Tasks Completed:</strong> ${data.tasksCompleted}</li>`;
    html += `<li><strong>Tasks Failed:</strong> ${data.tasksFailed}</li>`;
    html += `<li><strong>Messages Posted:</strong> ${data.messagesPosted}</li>`;
    html += `<li><strong>Tokens Used:</strong> ${(data.tokensUsed / 1000).toFixed(1)}K</li>`;
    html += `<li><strong>Cost:</strong> $${data.costUsd.toFixed(4)}</li>`;
    html += `</ul>`;
  }

  if (template.includeHighlights && data.highlights.length > 0) {
    html += `<h2>✨ Highlights</h2><ul>`;
    data.highlights.forEach((h) => {
      html += `<li>${h}</li>`;
    });
    html += `</ul>`;
  }

  if (data.topActivities.length > 0) {
    html += `<h2>🎯 Top Activities</h2><ul>`;
    data.topActivities.forEach((a) => {
      html += `<li><strong>${a.type.replace(/_/g, " ")}:</strong> ${a.count} times</li>`;
    });
    html += `</ul>`;
  }

  if (template.includeErrors && data.errors.length > 0) {
    html += `<h2>⚠️ Errors</h2><ul>`;
    data.errors.forEach((e) => {
      html += `<li><strong>${e.type}</strong> (${e.count}x): ${e.lastError}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════

export async function getDailySummary(
  orgId: string,
  agentId: string,
  date: string
): Promise<DailySummary | null> {
  const snap = await adminDb()
    .collection("dailySummaries")
    .where("orgId", "==", orgId)
    .where("agentId", "==", agentId)
    .where("date", "==", date)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  return {
    id: doc.id,
    orgId: data.orgId,
    agentId: data.agentId,
    agentName: data.agentName,
    date: data.date,
    summary: data.summary,
    deliveredTo: data.deliveredTo || [],
    createdAt: data.createdAt?.toDate() || null,
  };
}

export async function getAllSummaries(orgId: string, maxResults: number = 30): Promise<DailySummary[]> {
  function mapDoc(d: QueryDocumentSnapshot): DailySummary {
    const data = d.data();
    return {
      id: d.id,
      orgId: data.orgId,
      agentId: data.agentId,
      agentName: data.agentName,
      date: data.date,
      summary: data.summary,
      deliveredTo: data.deliveredTo || [],
      createdAt: data.createdAt?.toDate() || null,
    };
  }

  // Try composite index query first (orgId + createdAt desc)
  try {
    const snap = await adminDb()
      .collection("dailySummaries")
      .where("orgId", "==", orgId)
      .orderBy("createdAt", "desc")
      .get();
    return snap.docs.slice(0, maxResults).map(mapDoc);
  } catch (err) {
    // Composite index may not exist — fall back to filter-only query + in-memory sort
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("index") || msg.includes("requires an index")) {
      console.warn("[daily-summary] Composite index missing for dailySummaries (orgId + createdAt). Falling back to in-memory sort.");
      const snap = await adminDb().collection("dailySummaries").where("orgId", "==", orgId).get();
      const docs = snap.docs.map(mapDoc);
      docs.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
      return docs.slice(0, maxResults);
    }
    throw err;
  }
}
