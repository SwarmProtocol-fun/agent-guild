/**
 * Job audit trail — the job's jobEvents log, oldest first, with who did
 * each step. Jobs created before the log existed have no events; for those
 * it falls back to what the job's own timestamps can tell.
 */
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import { getJobAuditTrail } from "@/lib/jobs-client";
import type { Job } from "@/lib/firestore";
import type { JobEvent, JobEventType } from "@/lib/job-lifecycle";

const LABELS: Record<JobEventType, { icon: string; text: string }> = {
  created: { icon: "📢", text: "Posted" },
  edited: { icon: "✏️", text: "Edited" },
  applied: { icon: "📝", text: "Application submitted" },
  application_revised: { icon: "🔁", text: "Application revised" },
  claimed: { icon: "🤖", text: "Claimed" },
  hired: { icon: "🤝", text: "Assigned" },
  delivered: { icon: "📦", text: "Delivered" },
  approved: { icon: "✅", text: "Approved" },
  revision_requested: { icon: "↩️", text: "Sent back for revisions" },
  cancelled: { icon: "🚫", text: "Cancelled" },
  disputed: { icon: "⚠️", text: "Dispute filed" },
  escrow_claimed: { icon: "🔗", text: "Escrow claimed on-chain" },
  escrow_delivered: { icon: "🔗", text: "Delivery recorded on-chain" },
  escrow_released: { icon: "💸", text: "Escrow released" },
  escrow_resolved: { icon: "⚖️", text: "Escrow dispute resolved" },
  unassigned: { icon: "🔄", text: "Reopened" },
};

const toDate = (t: unknown): Date | null => {
  if (!t) return null;
  if (typeof t === "object" && t !== null && "seconds" in t) return new Date((t as { seconds: number }).seconds * 1000);
  const d = new Date(t as string | number);
  return isNaN(d.getTime()) ? null : d;
};
const fmt = (t: unknown) => toDate(t)?.toLocaleString() ?? "Unknown";
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

function actorLabel(e: JobEvent): string {
  if (e.actor.type === "agent") return `🤖 ${e.actor.name || shortId(e.actor.id)}`;
  if (e.actor.type === "system") return "system";
  return shortId(e.actor.id);
}

function detailLine(e: JobEvent): string | null {
  const d = e.details ?? {};
  switch (e.type) {
    case "claimed":
    case "hired":
      return d.agentName ? `to ${d.agentName}${d.role === "collaborator" ? " (collaborator)" : ""}` : null;
    case "escrow_resolved":
      return typeof d.agentBps === "number" ? `${d.agentBps / 100}% to the agent` : null;
    case "unassigned":
      return (d.reason as string | null) ?? null;
    case "applied":
      return [d.agentName, d.quote ? `quote $${d.quote}` : null].filter(Boolean).join(" · ") || null;
    case "delivered":
      return `revision ${d.revision ?? 1}${d.fileCount ? ` · ${d.fileCount} file${d.fileCount === 1 ? "" : "s"}` : ""}`;
    case "approved":
    case "revision_requested":
      return (d.notes as string | undefined) ?? null;
    case "edited":
      return d.changes ? `changed ${Object.keys(d.changes as object).join(", ")}` : null;
    case "cancelled":
      return (d.reason as string | null) ?? null;
    default:
      return null;
  }
}

/** Pre-audit-log jobs: rebuild what we can from the job's own fields. */
function legacyEvents(job: Job): { icon: string; text: string; at: unknown }[] {
  const out: { icon: string; text: string; at: unknown }[] = [{ icon: "📢", text: "Posted", at: job.createdAt }];
  if (job.claimedAt || job.takenByAgentId) out.push({ icon: "🤖", text: `Claimed by ${job.claimedByAgentName || job.takenByAgentId}`, at: job.claimedAt });
  for (const [i, d] of (job.deliveryHistory ?? []).entries()) {
    out.push({ icon: "📦", text: `Delivered (revision ${i + 1})${job.completedByAgentName ? ` by ${job.completedByAgentName}` : ""}`, at: d.at });
  }
  for (const r of job.reviewHistory ?? []) {
    out.push({ icon: r.status === "approved" ? "✅" : "↩️", text: `${r.status === "approved" ? "Approved" : "Sent back for revisions"} by ${shortId(r.by)}`, at: r.at });
  }
  return out.sort((a, b) => (toDate(a.at)?.getTime() ?? 0) - (toDate(b.at)?.getTime() ?? 0));
}

export function JobAuditTrail({ job, refreshKey }: { job: Job; refreshKey?: unknown }) {
  const [events, setEvents] = useState<JobEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJobAuditTrail(job.id)
      .then((e) => { if (!cancelled) { setEvents(e); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load audit trail"); });
    return () => { cancelled = true; };
  }, [job.id, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Audit trail</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-xs text-destructive mb-3">{error}</p>}
        {events === null && !error ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : events && events.length > 0 ? (
          <ol className="space-y-3 text-sm">
            {events.map((e) => {
              const label = LABELS[e.type] ?? { icon: "•", text: e.type };
              const detail = detailLine(e);
              return (
                <li key={e.id} className="flex gap-2">
                  <span className="shrink-0" aria-hidden>{label.icon}</span>
                  <div className="min-w-0">
                    <div>{label.text} <span className="text-muted-foreground">by {actorLabel(e)}</span></div>
                    {detail && <div className="text-xs text-muted-foreground break-words line-clamp-3">{detail}</div>}
                    <div className="text-xs text-muted-foreground">{fmt(e.at)}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <>
            <ol className="space-y-3 text-sm">
              {legacyEvents(job).map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0" aria-hidden>{e.icon}</span>
                  <div>
                    <div>{e.text}</div>
                    <div className="text-xs text-muted-foreground">{fmt(e.at)}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-[11px] text-muted-foreground mt-3">Reconstructed from the job record. This job predates the audit log.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
