"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert, Loader2, ArrowLeft, AlertTriangle, Ban,
  CheckCircle, XCircle, MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface CaseDetail {
  case: {
    id: string;
    agentId: string;
    agentName: string;
    asn: string;
    riskScore: number;
    riskTier: string;
    severity: string;
    status: string;
    triggerReason: string;
    triggerSignalIds: string[];
    reviewHistory: { action: string; performedBy: string; notes?: string; timestamp: string }[];
    resolution?: { action: string; creditPenalty?: number; trustPenalty?: number; notes: string; resolvedBy: string };
  };
  agent: {
    id: string;
    name: string;
    asn: string;
    walletAddress: string;
    creditScore: number;
    trustScore: number;
    status: string;
  } | null;
  riskProfile: {
    riskScore: number;
    riskTier: string;
    activeSignalCount: number;
    signalBreakdown: Record<string, number>;
    uniqueCounterparties: number;
  } | null;
  signals: {
    id: string;
    signalType: string;
    severity: string;
    confidence: number;
    evidence: { description: string; metric?: number; threshold?: number; counterpartyIds?: string[] };
    status: string;
  }[];
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400",
  high: "bg-orange-500/20 text-orange-400",
  medium: "bg-amber-500/20 text-amber-400",
  low: "bg-blue-500/20 text-blue-400",
};

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [penaltyAmount, setPenaltyAmount] = useState("30");
  const [notes, setNotes] = useState("");

  const fetchCase = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/risk/queue/${id}`);
      if (res.ok) {
        const d = await res.json();
        setData(d);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (isAdmin && id) fetchCase();
  }, [isAdmin, id, fetchCase]);

  const handleAction = async (action: string) => {
    setActionLoading(true);
    try {
      const body: Record<string, unknown> = { action, notes };
      if (action === "penalty" || action === "ban") {
        body.creditPenalty = parseInt(penaltyAmount, 10) || 0;
      }
      const res = await fetch(`/api/admin/risk/queue/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchCase();
      }
    } catch {
      // silent
    } finally {
      setActionLoading(false);
    }
  };

  if (!authenticated || !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-muted-foreground p-6">Case not found.</p>;
  }

  const { case: reviewCase, agent, riskProfile, signals } = data;
  const isPending = reviewCase.status === "pending" || reviewCase.status === "investigating";

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/risk/queue">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Case: {reviewCase.agentName}</h1>
          <p className="text-sm text-muted-foreground font-mono">{reviewCase.asn || reviewCase.agentId}</p>
        </div>
        <span className={`ml-auto px-3 py-1 rounded-full text-sm font-medium ${SEVERITY_COLORS[reviewCase.severity] || ""}`}>
          {reviewCase.severity}
        </span>
      </div>

      {/* Agent Info */}
      {agent && (
        <div className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">Agent Profile</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Credit Score</div>
              <div className="text-lg font-bold">{agent.creditScore || "N/A"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Trust Score</div>
              <div className="text-lg font-bold">{agent.trustScore || "N/A"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Risk Score</div>
              <div className={`text-lg font-bold ${
                reviewCase.riskScore >= 80 ? "text-red-400" :
                reviewCase.riskScore >= 60 ? "text-orange-400" :
                "text-amber-400"
              }`}>{reviewCase.riskScore}/100</div>
            </div>
            <div>
              <div className="text-muted-foreground">Status</div>
              <div className="text-lg font-bold capitalize">{agent.status}</div>
            </div>
          </div>
          <div className="mt-2 text-xs text-muted-foreground font-mono">
            Wallet: {agent.walletAddress}
          </div>
        </div>
      )}

      {/* Risk Profile */}
      {riskProfile && (
        <div className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">Risk Profile</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Active Signals</div>
              <div className="text-lg font-bold">{riskProfile.activeSignalCount}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Unique Counterparties</div>
              <div className="text-lg font-bold">{riskProfile.uniqueCounterparties}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Risk Tier</div>
              <div className="text-lg font-bold capitalize">{riskProfile.riskTier}</div>
            </div>
          </div>
          {Object.keys(riskProfile.signalBreakdown).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(riskProfile.signalBreakdown).map(([type, count]) => (
                <span key={type} className="px-2 py-0.5 bg-muted rounded text-xs">
                  {type.replace(/_/g, " ")}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Signals */}
      <div className="border border-border rounded-lg p-4">
        <h3 className="font-semibold mb-3">Signals ({signals.length})</h3>
        {signals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active signals.</p>
        ) : (
          <div className="space-y-3">
            {signals.map((signal) => (
              <div key={signal.id} className="p-3 bg-muted/30 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-sm font-medium">{signal.signalType.replace(/_/g, " ")}</span>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${SEVERITY_COLORS[signal.severity] || ""}`}>
                      {signal.severity}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {(signal.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{signal.evidence.description}</p>
                {signal.evidence.counterpartyIds && signal.evidence.counterpartyIds.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Counterparties: {signal.evidence.counterpartyIds.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      {isPending && (
        <div className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">Take Action</h3>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground">Notes</label>
              <textarea
                className="w-full mt-1 bg-muted border border-border rounded p-2 text-sm"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add review notes..."
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Penalty Amount (credit)</label>
              <input
                type="number"
                className="w-full mt-1 bg-muted border border-border rounded p-2 text-sm"
                value={penaltyAmount}
                onChange={(e) => setPenaltyAmount(e.target.value)}
                min="0"
                max="200"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => handleAction("dismiss")} disabled={actionLoading}>
                <CheckCircle className="h-4 w-4 mr-1" />
                Dismiss
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleAction("warn")} disabled={actionLoading}>
                <MessageSquare className="h-4 w-4 mr-1" />
                Warn
              </Button>
              <Button variant="default" size="sm" onClick={() => handleAction("penalty")} disabled={actionLoading}>
                <AlertTriangle className="h-4 w-4 mr-1" />
                Apply Penalty
              </Button>
              <Button variant="destructive" size="sm" onClick={() => handleAction("ban")} disabled={actionLoading}>
                <Ban className="h-4 w-4 mr-1" />
                Ban Agent
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Resolution */}
      {reviewCase.resolution && (
        <div className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">Resolution</h3>
          <div className="text-sm space-y-1">
            <div><span className="text-muted-foreground">Action:</span> <span className="font-medium capitalize">{reviewCase.resolution.action}</span></div>
            {reviewCase.resolution.creditPenalty && (
              <div><span className="text-muted-foreground">Penalty:</span> <span className="font-medium text-red-400">{reviewCase.resolution.creditPenalty} credit</span></div>
            )}
            <div><span className="text-muted-foreground">Notes:</span> {reviewCase.resolution.notes}</div>
            <div><span className="text-muted-foreground">Resolved by:</span> <span className="font-mono text-xs">{reviewCase.resolution.resolvedBy}</span></div>
          </div>
        </div>
      )}

      {/* Review History */}
      {reviewCase.reviewHistory.length > 0 && (
        <div className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">Review History</h3>
          <div className="space-y-2">
            {reviewCase.reviewHistory.map((entry, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                <div>
                  <span className="font-medium">{entry.action}</span>
                  <span className="text-muted-foreground"> by {entry.performedBy}</span>
                  {entry.notes && <span className="text-muted-foreground"> — {entry.notes}</span>}
                  <div className="text-xs text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
