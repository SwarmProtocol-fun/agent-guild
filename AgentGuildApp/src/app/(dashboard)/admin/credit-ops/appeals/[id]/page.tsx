"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert, Loader2, ArrowLeft, CheckCircle, XCircle, Clock, Play,
  AlertTriangle, MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface AppealDetail {
  id: string;
  appellantType: string;
  appellantId: string;
  agentId: string;
  asn: string;
  orgId: string;
  appealType: string;
  subject: string;
  description: string;
  evidence?: string[];
  scoreAtTimeOfEvent: { credit: number; trust: number };
  currentScore: { credit: number; trust: number };
  requestedOutcome?: string;
  status: string;
  priority: string;
  assignedTo?: string;
  reviewHistory: Array<{ action: string; performedBy: string; performedAt: string; comment?: string }>;
  resolution?: { outcome: string; comment: string; resolvedBy: string };
}

export default function AppealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [item, setItem] = useState<AppealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [resolutionOutcome, setResolutionOutcome] = useState("granted");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/appeals/${id}`);
      if (res.ok) { const d = await res.json(); setItem(d.item); }
    } catch { /* silent */ } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (isAdmin && id) fetchDetail(); }, [isAdmin, id, fetchDetail]);

  async function performAction(action: string) {
    setActionLoading(true);
    try {
      const body: Record<string, unknown> = { action, comment: comment || undefined };
      if (action === "resolve") {
        body.resolution = { outcome: resolutionOutcome, comment: comment || "Resolved", resolvedBy: "platform-admin" };
      }
      const res = await fetch(`/api/admin/credit-ops/appeals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) { const d = await res.json(); setItem(d.item); setComment(""); }
    } finally { setActionLoading(false); }
  }

  if (!authenticated || !isAdmin) {
    return (<div className="flex flex-col items-center justify-center h-[60vh] gap-3"><ShieldAlert className="h-12 w-12 text-red-400" /></div>);
  }

  if (loading) return (<div className="flex items-center justify-center h-[60vh]"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>);
  if (!item) return (<div className="flex flex-col items-center justify-center h-[60vh] gap-3"><p className="text-muted-foreground">Not found.</p></div>);

  const isActive = !["resolved", "rejected"].includes(item.status);

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/admin/credit-ops/appeals"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">{item.subject}</h1>
          <p className="text-sm text-muted-foreground">{item.appealType.replace(/_/g, " ")} appeal by {item.asn || item.agentId}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Description */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-2">
            <h3 className="text-sm font-medium">Appeal Description</h3>
            <p className="text-sm whitespace-pre-wrap">{item.description}</p>
            {item.requestedOutcome && (
              <div className="mt-2"><span className="text-xs text-muted-foreground">Requested outcome: </span><span className="text-sm">{item.requestedOutcome}</span></div>
            )}
          </div>

          {/* Score context */}
          <div className="rounded-xl border border-border bg-card/50 p-4">
            <h3 className="text-sm font-medium mb-3">Score Context</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-muted-foreground">At Time of Event</span>
                <p className="font-mono">C:{item.scoreAtTimeOfEvent.credit} T:{item.scoreAtTimeOfEvent.trust}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Current</span>
                <p className="font-mono">C:{item.currentScore.credit} T:{item.currentScore.trust}</p>
              </div>
            </div>
          </div>

          {/* Resolution */}
          {item.resolution && (
            <div className={`rounded-xl border p-4 space-y-2 ${
              item.resolution.outcome === "granted" ? "border-emerald-500/30 bg-emerald-500/5" :
              item.resolution.outcome === "denied" ? "border-red-500/30 bg-red-500/5" :
              "border-amber-500/30 bg-amber-500/5"
            }`}>
              <h3 className="text-sm font-medium">{item.resolution.outcome.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</h3>
              <p className="text-sm">{item.resolution.comment}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Actions */}
          {isActive && (
            <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <h3 className="text-sm font-medium">Actions</h3>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="Comment..." className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none h-20" />

              {item.status === "submitted" && (
                <Button className="w-full" variant="outline" onClick={() => performAction("start_review")} disabled={actionLoading}>
                  <Play className="h-4 w-4 mr-2" /> Start Review
                </Button>
              )}

              <select value={resolutionOutcome} onChange={(e) => setResolutionOutcome(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm">
                <option value="granted">Granted</option>
                <option value="partially_granted">Partially Granted</option>
                <option value="denied">Denied</option>
              </select>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => performAction("resolve")} disabled={actionLoading}>
                  <CheckCircle className="h-4 w-4 mr-1" /> Resolve
                </Button>
                <Button variant="destructive" onClick={() => performAction("reject")} disabled={actionLoading}>
                  <XCircle className="h-4 w-4 mr-1" /> Reject
                </Button>
              </div>

              <Button variant="outline" className="w-full" onClick={() => performAction("request_info")} disabled={actionLoading}>
                <MessageSquare className="h-4 w-4 mr-2" /> Request Info
              </Button>
            </div>
          )}

          {/* Timeline */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2"><Clock className="h-4 w-4" /> Timeline</h3>
            {item.reviewHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity yet</p>
            ) : (
              <div className="space-y-2">
                {item.reviewHistory.map((entry, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <div className="w-1 bg-border rounded-full shrink-0" />
                    <div>
                      <p className="font-medium">{entry.action.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</p>
                      <p className="text-muted-foreground">by {entry.performedBy} &middot; {new Date(entry.performedAt).toLocaleString()}</p>
                      {entry.comment && <p className="text-muted-foreground italic mt-0.5">{entry.comment}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
