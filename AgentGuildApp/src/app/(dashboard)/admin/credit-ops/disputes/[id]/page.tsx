"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ShieldAlert, Loader2, ArrowLeft, Clock, Search, Scale, Gavel, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface DisputeDetail {
  id: string;
  initiatorType: string; initiatorId: string;
  respondentType: string; respondentId: string;
  disputeType: string; subject: string; description: string;
  evidence?: string[];
  relatedAgentIds: string[]; relatedEventIds: string[];
  status: string; priority: string; assignedTo?: string;
  adjudication?: { decision: string; rationale: string; actions: Array<{ type: string; details: Record<string, unknown> }> };
  reviewHistory: Array<{ action: string; performedBy: string; performedAt: string; comment?: string }>;
  filedAt?: { seconds: number };
}

export default function DisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [item, setItem] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/disputes/${id}`);
      if (res.ok) { const d = await res.json(); setItem(d.item); }
    } catch { /* silent */ } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (isAdmin && id) fetchDetail(); }, [isAdmin, id, fetchDetail]);

  async function performAction(action: string) {
    setActionLoading(true);
    try {
      const body: Record<string, unknown> = { action, comment: comment || undefined };
      if (action === "adjudicate") {
        body.adjudication = {
          decision, rationale,
          actions: [],
          adjudicatedBy: "platform-admin",
          adjudicatedAt: new Date().toISOString(),
        };
      }
      const res = await fetch(`/api/admin/credit-ops/disputes/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) { const d = await res.json(); setItem(d.item); setComment(""); }
    } finally { setActionLoading(false); }
  }

  if (!authenticated || !isAdmin) return (<div className="flex items-center justify-center h-[60vh]"><ShieldAlert className="h-12 w-12 text-red-400" /></div>);
  if (loading) return (<div className="flex items-center justify-center h-[60vh]"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>);
  if (!item) return (<div className="flex items-center justify-center h-[60vh]"><p className="text-muted-foreground">Not found.</p></div>);

  const isActive = !["adjudicated", "closed"].includes(item.status);

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/admin/credit-ops/disputes"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">{item.subject}</h1>
          <p className="text-sm text-muted-foreground">{item.disputeType.replace(/_/g, " ")} — {item.status}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Parties */}
          <div className="rounded-xl border border-border bg-card/50 p-4 grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-muted-foreground">Initiator ({item.initiatorType})</span>
              <p className="font-mono text-sm truncate">{item.initiatorId}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Respondent ({item.respondentType})</span>
              <p className="font-mono text-sm truncate">{item.respondentId}</p>
            </div>
          </div>

          {/* Description */}
          <div className="rounded-xl border border-border bg-card/50 p-4">
            <h3 className="text-sm font-medium mb-2">Description</h3>
            <p className="text-sm whitespace-pre-wrap">{item.description}</p>
          </div>

          {/* Adjudication result */}
          {item.adjudication && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
              <h3 className="text-sm font-medium flex items-center gap-2"><Gavel className="h-4 w-4" /> Adjudication</h3>
              <p className="text-sm font-medium">{item.adjudication.decision}</p>
              <p className="text-sm text-muted-foreground">{item.adjudication.rationale}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {isActive && (
            <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <h3 className="text-sm font-medium">Actions</h3>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="Comment..." className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none h-16" />

              <div className="flex flex-col gap-2">
                <Button variant="outline" size="sm" onClick={() => performAction("investigate")} disabled={actionLoading}>
                  <Search className="h-3 w-3 mr-1" /> Investigate
                </Button>
                <Button variant="outline" size="sm" onClick={() => performAction("mediate")} disabled={actionLoading}>
                  <Scale className="h-3 w-3 mr-1" /> Mediate
                </Button>
              </div>

              <div className="border-t border-border pt-3 space-y-2">
                <h4 className="text-xs text-muted-foreground">Adjudicate</h4>
                <input value={decision} onChange={(e) => setDecision(e.target.value)}
                  placeholder="Decision..." className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" />
                <textarea value={rationale} onChange={(e) => setRationale(e.target.value)}
                  placeholder="Rationale..." className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none h-16" />
                <Button className="w-full" onClick={() => performAction("adjudicate")} disabled={actionLoading || !decision.trim()}>
                  <Gavel className="h-4 w-4 mr-2" /> Adjudicate
                </Button>
              </div>

              <Button variant="outline" className="w-full" onClick={() => performAction("close")} disabled={actionLoading}>
                <XCircle className="h-4 w-4 mr-2" /> Close
              </Button>
            </div>
          )}

          {/* Timeline */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2"><Clock className="h-4 w-4" /> Timeline</h3>
            {item.reviewHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity</p>
            ) : (
              <div className="space-y-2">
                {item.reviewHistory.map((entry, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <div className="w-1 bg-border rounded-full shrink-0" />
                    <div>
                      <p className="font-medium">{entry.action.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</p>
                      <p className="text-muted-foreground">{new Date(entry.performedAt).toLocaleString()}</p>
                      {entry.comment && <p className="text-muted-foreground italic">{entry.comment}</p>}
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
