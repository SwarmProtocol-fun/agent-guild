/** Daily Briefing card — shows the latest scheduled org summary and edits its cron job. */
'use client';

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil } from "lucide-react";
import { DashboardCard } from "@/components/dashboard/dashboard-cards";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { ensureAgentGroupChat, sendMessage, type Agent } from "@/lib/firestore";
import { createCronJob, updateCronJob, SCHEDULE_PRESETS, parseCronToHuman, type CronJob } from "@/lib/cron";
import type { DailySummary } from "@/lib/daily-summary";

const DEFAULT_PROMPT =
  "Generate a daily activity summary for the organization. Include task completion stats, agent activity highlights, any errors or failures, and key metrics like token usage and cost.";

const briefingPresets = SCHEDULE_PRESETS.filter(p =>
  ["daily", "weekly"].includes(p.type) || p.value === "0 */6 * * *"
);

interface DailyBriefingCardProps {
  orgId: string;
  agents: Agent[];
  /** Agent assigned to the "daily-briefings" slot in the Agent Guild inventory, if any. */
  slotAgentId?: string;
  cronJob: CronJob | null;
  latestBriefing: DailySummary | null;
  createdBy: string;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}

export function DailyBriefingCard({
  orgId,
  agents,
  slotAgentId,
  cronJob,
  latestBriefing,
  createdBy,
  canEdit,
  onSaved,
}: DailyBriefingCardProps) {
  const [editing, setEditing] = useState(false);
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [agentId, setAgentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronAgentId = cronJob?.agentIds?.[0];
  const briefingAgentId = cronAgentId || slotAgentId;
  const briefingAgent = briefingAgentId ? agents.find(a => a.id === briefingAgentId) : undefined;

  const openEditor = () => {
    if (cronJob) {
      setSchedule(cronJob.schedule);
      setPrompt(cronJob.message);
      setAgentId(cronJob.agentIds?.[0] || "");
    } else {
      setAgentId(slotAgentId || "");
    }
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const assigned = agentId ? agents.find(a => a.id === agentId) : null;
      const scheduleLabel = parseCronToHuman(schedule);
      const isEditing = !!cronJob;

      // Preserve the existing assignment if the user didn't pick one
      const agentIdsToSave = agentId
        ? [agentId]
        : cronJob?.agentIds?.length
          ? cronJob.agentIds
          : undefined;

      if (cronJob) {
        await updateCronJob(cronJob.id, { message: prompt, schedule, scheduleLabel, agentIds: agentIdsToSave });
      } else {
        await createCronJob({
          orgId,
          name: "Daily Briefing",
          message: prompt,
          schedule,
          scheduleLabel,
          agentIds: agentIdsToSave,
          priority: "medium",
          enabled: true,
          createdBy: createdBy || "unknown",
        });
      }

      // Notify the assigned briefing agent through Agent Hub
      if (assigned) {
        ensureAgentGroupChat(orgId).then(hub => {
          sendMessage({
            channelId: hub.id,
            senderId: "system",
            senderName: "Agent Guild Protocol",
            senderType: "agent",
            content: [
              `📋 **Daily Briefing ${isEditing ? "updated" : "configured"}** — assigned to **@${assigned.name}**`,
              ``,
              `**Schedule:** ${scheduleLabel}`,
              `**Prompt:** ${prompt}`,
              ``,
              `You are responsible for generating briefings on this schedule. Begin operations when ready.`,
            ].join("\n"),
            orgId,
            createdAt: new Date(),
          });
        }).catch(() => {});
      }

      setEditing(false);
      await onSaved();
    } catch (err) {
      console.error("Failed to set up daily briefing:", err);
      setError(err instanceof Error ? err.message : "Failed to save briefing");
    } finally {
      setSaving(false);
    }
  };

  /* ── Editor ── */

  if (editing) {
    const customTime = (() => {
      const parts = schedule.split(" ");
      if (parts.length === 5 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[0])) {
        return `${parts[1].padStart(2, "0")}:${parts[0].padStart(2, "0")}`;
      }
      return "";
    })();

    return (
      <DashboardCard icon="📋" title={cronJob ? "Edit Briefing" : "Set Up Daily Briefing"}>
        <div className="space-y-3">
          <div>
            <label htmlFor="briefing-time" className="text-xs text-muted-foreground mb-1.5 block">Schedule</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {briefingPresets.map(preset => (
                <button
                  key={preset.value + preset.label}
                  type="button"
                  onClick={() => setSchedule(preset.value)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    schedule === preset.value
                      ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "border-border hover:border-amber-500/30 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span aria-hidden="true">{preset.icon}</span>
                  <span className="truncate">{preset.label}</span>
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Custom time:</span>
              <input
                id="briefing-time"
                type="time"
                autoComplete="off"
                value={customTime}
                onChange={e => {
                  const [h, m] = e.target.value.split(":");
                  if (h !== undefined && m !== undefined) setSchedule(`${parseInt(m)} ${parseInt(h)} * * *`);
                }}
                className="flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
          </div>

          <div>
            <label htmlFor="briefing-agent" className="text-xs text-muted-foreground mb-1.5 block">Assigned Agent</label>
            <select
              id="briefing-agent"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&>option]:bg-background [&>option]:text-foreground"
            >
              <option value="">No agent assigned</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type}{a.status === "online" ? " · online" : ""})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="briefing-prompt" className="text-xs text-muted-foreground mb-1.5 block">Briefing Prompt</label>
            <textarea
              id="briefing-prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              placeholder="Describe what the briefing should include..."
            />
          </div>

          {error && <p role="alert" className="text-xs text-red-500 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => { setEditing(false); setError(null); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={saving || !canEdit || !prompt.trim()}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              {saving ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" aria-hidden="true" /> Saving...</>
              ) : cronJob ? "Save Changes" : "Enable Briefings"}
            </Button>
          </div>
        </div>
      </DashboardCard>
    );
  }

  /* ── Not configured ── */

  if (!cronJob) {
    return (
      <DashboardCard icon="📋" title="Daily Briefing">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-1">
          <div className="flex-1 min-w-0">
            <p className="text-sm">Get an automated summary of your org every day.</p>
            <p className="text-xs text-muted-foreground">
              {briefingAgent
                ? `${briefingAgent.name} is ready to write it. Pick a schedule to start.`
                : "Assign an agent in the Agent Guild inventory, then pick a schedule."}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {!briefingAgent && (
              <Button asChild variant="outline" size="sm">
                <Link href="/agent-guild">Go to Agent Guild</Link>
              </Button>
            )}
            <Button size="sm" onClick={openEditor} disabled={!canEdit} className="bg-amber-500 hover:bg-amber-600 text-white">
              Set Up
            </Button>
          </div>
        </div>
      </DashboardCard>
    );
  }

  /* ── Configured ── */

  const scheduleLabel = cronJob.scheduleLabel || parseCronToHuman(cronJob.schedule);
  const summary = latestBriefing?.summary;

  return (
    <DashboardCard icon="📋" title="Daily Briefing" href="/summaries">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {briefingAgent ? (
            <div className="flex items-center gap-2 min-w-0">
              <img
                src={briefingAgent.avatarUrl || getAgentAvatarUrl(briefingAgent.name, briefingAgent.type)}
                alt=""
                className="w-6 h-6 rounded-full border border-amber-500/30"
              />
              <span className="text-sm font-medium truncate">{briefingAgent.name}</span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${briefingAgent.status === "online" ? "bg-emerald-500" : briefingAgent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No agent assigned</span>
          )}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400">
            {scheduleLabel}
          </Badge>
          {latestBriefing?.date && <span className="text-xs text-muted-foreground">Latest: {latestBriefing.date}</span>}
          {canEdit && (
            <button
              onClick={openEditor}
              className="ml-auto p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              title="Edit briefing settings"
              aria-label="Edit briefing settings"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {summary ? (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-muted-foreground">Completed </span>
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{summary.tasksCompleted}</span>
                {summary.tasksFailed > 0 && (
                  <span className="text-red-500 dark:text-red-400 text-xs tabular-nums"> ({summary.tasksFailed} failed)</span>
                )}
              </span>
              <span>
                <span className="text-muted-foreground">Tokens </span>
                <span className="font-medium tabular-nums">{(summary.tokensUsed / 1000).toFixed(1)}K</span>
              </span>
              <span>
                <span className="text-muted-foreground">Cost </span>
                <span className="font-medium tabular-nums">${summary.costUsd.toFixed(2)}</span>
              </span>
            </div>
            {summary.highlights.length > 0 && (
              <ul className="space-y-1 border-t border-border pt-2">
                {summary.highlights.slice(0, 3).map((h, i) => (
                  <li key={i} className="text-xs text-muted-foreground truncate">• {h}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No briefing generated yet. Summaries appear here after the next scheduled run.</p>
        )}
      </div>
    </DashboardCard>
  );
}
