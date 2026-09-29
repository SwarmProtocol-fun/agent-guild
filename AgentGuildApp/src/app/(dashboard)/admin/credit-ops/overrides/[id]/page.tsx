"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, ArrowLeft, CheckCircle,
  Undo2, ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface OverrideDetail {
  id: string;
  agentId: string;
  asn: string;
  overrideType: string;
  previousCreditScore: number;
  previousTrustScore: number;
  newCreditScore: number;
  newTrustScore: number;
  creditDelta: number;
  trustDelta: number;
  reason: string;
  approvalStatus: string;
  requestedBy: string;
  approvedBy: string[];
  rolledBack: boolean;
  rollbackBy?: string;
  rollbackReason?: string;
  expired: boolean;
  reviewQueueItemId?: string;
  appealId?: string;
  hcsTxId?: string;
  createdAt?: { seconds: number };
  appliedAt?: { seconds: number };
  rollbackAt?: { seconds: number };
}

export default function OverrideDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [item, setItem] = useState<OverrideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("");

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/overrides/${id}`);
      if (res.ok) {
        const d = await res.json();
        setItem(d.item);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (isAdmin && id) fetchDetail();
  }, [isAdmin, id, fetchDetail]);

  async function performAction(action: "approve" | "rollback") {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/credit-ops/overrides/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          reason: action === "rollback" ? rollbackReason : undefined,
        }),
      });
      if (res.ok) {
        await fetchDetail();
        setRollbackReason("");
      }
    } finally {
      setActionLoading(false);
    }
  }

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
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <p className="text-muted-foreground">Override not found.</p>
        <Link href="/admin/credit-ops/overrides">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/admin/credit-ops/overrides">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Override: {item.asn || item.agentId}</h1>
          <p className="text-sm text-muted-foreground">{item.reason}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Score Change */}
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
          <h3 className="text-sm font-medium">Score Change</h3>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <span className="text-xs text-muted-foreground">Before</span>
              <p className="text-xl font-bold">{item.previousCreditScore}</p>
              <p className="text-xs text-muted-foreground">credit</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="text-center">
              <span className="text-xs text-muted-foreground">After</span>
              <p className="text-xl font-bold">{item.newCreditScore}</p>
              <p className="text-xs text-muted-foreground">credit</p>
            </div>
            <div className={`text-center px-3 py-1 rounded-lg ${
              item.creditDelta >= 0 ? "bg-emerald-500/10" : "bg-red-500/10"
            }`}>
              <p className={`text-lg font-bold ${item.creditDelta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {item.creditDelta >= 0 ? "+" : ""}{item.creditDelta}
              </p>
              <p className="text-xs text-muted-foreground">delta</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <span className="text-xs text-muted-foreground">Before</span>
              <p className="text-xl font-bold">{item.previousTrustScore}</p>
              <p className="text-xs text-muted-foreground">trust</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="text-center">
              <span className="text-xs text-muted-foreground">After</span>
              <p className="text-xl font-bold">{item.newTrustScore}</p>
              <p className="text-xs text-muted-foreground">trust</p>
            </div>
            <div className={`text-center px-3 py-1 rounded-lg ${
              item.trustDelta >= 0 ? "bg-emerald-500/10" : "bg-red-500/10"
            }`}>
              <p className={`text-lg font-bold ${item.trustDelta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {item.trustDelta >= 0 ? "+" : ""}{item.trustDelta}
              </p>
              <p className="text-xs text-muted-foreground">delta</p>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <h3 className="text-sm font-medium">Details</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <span>{item.overrideType}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={
                item.rolledBack ? "text-red-400" :
                item.approvalStatus === "approved" ? "text-emerald-400" :
                item.approvalStatus === "pending" ? "text-amber-400" : ""
              }>
                {item.rolledBack ? "Rolled Back" : item.approvalStatus}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Requested By</span>
              <span className="font-mono text-xs">{item.requestedBy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Approved By</span>
              <span className="font-mono text-xs">
                {item.approvedBy?.length ? item.approvedBy.join(", ") : "—"}
              </span>
            </div>
            {item.createdAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{new Date(item.createdAt.seconds * 1000).toLocaleString()}</span>
              </div>
            )}
            {item.appliedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Applied</span>
                <span>{new Date(item.appliedAt.seconds * 1000).toLocaleString()}</span>
              </div>
            )}
            {item.reviewQueueItemId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Review Item</span>
                <Link href={`/admin/credit-ops/queue/${item.reviewQueueItemId}`} className="text-cyan-400 text-xs">
                  View
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rollback info */}
      {item.rolledBack && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 space-y-2">
          <h3 className="text-sm font-medium text-red-400 flex items-center gap-2">
            <Undo2 className="h-4 w-4" /> Rolled Back
          </h3>
          <p className="text-sm">{item.rollbackReason}</p>
          <p className="text-xs text-muted-foreground">
            by {item.rollbackBy}
            {item.rollbackAt && ` on ${new Date(item.rollbackAt.seconds * 1000).toLocaleString()}`}
          </p>
        </div>
      )}

      {/* Actions */}
      {!item.rolledBack && item.approvalStatus === "pending" && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <h3 className="text-sm font-medium">Pending Approval</h3>
          <p className="text-sm text-muted-foreground">
            This override requires additional admin approval (delta &gt; 50).
          </p>
          <Button onClick={() => performAction("approve")} disabled={actionLoading}>
            <CheckCircle className="h-4 w-4 mr-2" /> Approve Override
          </Button>
        </div>
      )}

      {!item.rolledBack && item.approvalStatus === "approved" && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <h3 className="text-sm font-medium">Rollback</h3>
          <textarea
            value={rollbackReason}
            onChange={(e) => setRollbackReason(e.target.value)}
            placeholder="Reason for rollback..."
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none h-20"
          />
          <Button
            variant="destructive"
            onClick={() => performAction("rollback")}
            disabled={actionLoading || !rollbackReason.trim()}
          >
            <Undo2 className="h-4 w-4 mr-2" /> Rollback Override
          </Button>
        </div>
      )}
    </div>
  );
}
