"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert, Loader2, RefreshCw, CheckCircle, XCircle, ArrowRight,
  ArrowLeft, AlertTriangle, ExternalLink, Shield, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

const STAGE_ORDER = ["intake", "security_scan", "sandbox", "product_review", "decision"];
const STAGE_LABELS: Record<string, string> = {
  intake: "Intake",
  security_scan: "Security Scan",
  sandbox: "Sandbox",
  product_review: "Product Review",
  decision: "Decision",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  review: "bg-amber-500/20 text-amber-400",
  approved: "bg-green-500/20 text-green-400",
  rejected: "bg-red-500/20 text-red-400",
  suspended: "bg-red-500/20 text-red-400",
  changes_requested: "bg-blue-500/20 text-blue-400",
};

const TIER_NAMES: Record<number, string> = { 0: "New", 1: "Approved", 2: "Trusted", 3: "Strategic" };
const TIER_COLORS: Record<number, string> = {
  0: "bg-zinc-500/20 text-zinc-400",
  1: "bg-blue-500/20 text-blue-400",
  2: "bg-amber-500/20 text-amber-400",
  3: "bg-purple-500/20 text-purple-400",
};

const SEVERITY_COLORS: Record<string, string> = {
  none: "bg-green-500/20 text-green-400",
  low: "bg-blue-500/20 text-blue-400",
  medium: "bg-amber-500/20 text-amber-400",
  high: "bg-orange-500/20 text-orange-400",
  critical: "bg-red-500/20 text-red-400",
};

const PERMISSION_COLORS: Record<string, string> = {
  wallet_access: "bg-red-500/20 text-red-400",
  sensitive_data_access: "bg-red-500/20 text-red-400",
  external_api: "bg-orange-500/20 text-orange-400",
  cross_chain_message: "bg-orange-500/20 text-orange-400",
  webhook_access: "bg-amber-500/20 text-amber-400",
  execute: "bg-blue-500/20 text-blue-400",
  write: "bg-blue-500/20 text-blue-400",
  read: "bg-green-500/20 text-green-400",
};

interface ReviewEntry {
  stage: string;
  result: "passed" | "failed" | "skipped";
  reviewedBy: string;
  reviewedAt: string;
  comment?: string;
  findings?: string[];
  artifactCids?: string[];
}

interface DetailItem {
  id: string;
  source: string;
  name: string;
  description: string;
  longDescription?: string;
  type: string;
  category?: string;
  icon?: string;
  version?: string;
  tags?: string[];
  requiredKeys?: string[];
  status: string;
  stage: string;
  reviewHistory?: ReviewEntry[];
  permissionsRequired?: string[];
  repoUrl?: string;
  demoUrl?: string;
  screenshotUrls?: string[];
  submissionType?: string;
  submissionTrack?: string;
  submittedBy?: string;
  submittedAt?: { seconds: number };
  modManifest?: { tools?: string[]; workflows?: string[]; agentSkills?: string[] };
  skinConfig?: { colors?: Record<string, string>; features?: string[] };
  updateOf?: string;
  previousVersion?: string;
  appealComment?: string;
  appealedAt?: { seconds: number };
  publisher?: {
    wallet: string;
    displayName: string;
    tier: number;
    totalSubmissions: number;
    approvedCount: number;
    banned: boolean;
  };
  securityScan?: {
    passed: boolean;
    findings: string[];
    severity: string;
  };
}

export default function SubmissionDetailPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const itemId = params.id as string;
  const source = searchParams.get("source") || "community";

  const [item, setItem] = useState<DetailItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState("");

  const fetchItem = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/marketplace/queue/${itemId}?source=${source}`);
      if (res.ok) {
        const d = await res.json();
        setItem(d.item);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [itemId, source]);

  useEffect(() => {
    if (isAdmin && itemId) fetchItem();
  }, [isAdmin, itemId, fetchItem]);

  async function reviewAction(action: string) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/admin/marketplace/queue/${itemId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source, reviewComment }),
      });
      if (res.ok) {
        setReviewComment("");
        if (action === "approve" || action === "reject") {
          router.push("/admin/marketplace/queue");
        } else {
          await fetchItem();
        }
      }
    } finally {
      setActionLoading(null);
    }
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
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
        <p className="text-muted-foreground">Submission not found.</p>
        <Link href="/admin/marketplace/queue" className="text-sm text-blue-400 hover:underline">
          Back to queue
        </Link>
      </div>
    );
  }

  const history = item.reviewHistory || [];
  const currentStageIdx = STAGE_ORDER.indexOf(item.stage || "intake");

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Back + Header */}
      <div>
        <Link
          href="/admin/marketplace/queue"
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-3"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Queue
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            {item.icon && <span className="text-3xl">{item.icon}</span>}
            <h1 className="text-2xl font-bold">{item.name}</h1>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{item.type}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[item.status] || "bg-muted"}`}>
              {item.status}
            </span>
            {item.version && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted font-mono">v{item.version}</span>
            )}
            {item.publisher && (
              <span className={`text-xs px-1.5 py-0.5 rounded ${TIER_COLORS[item.publisher.tier] || TIER_COLORS[0]}`}>
                T{item.publisher.tier} {TIER_NAMES[item.publisher.tier]}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={fetchItem} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Overview */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Overview</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-2">
            <p className="text-sm">{item.description}</p>
            {item.longDescription && (
              <p className="text-sm text-muted-foreground">{item.longDescription}</p>
            )}
          </div>
          <div className="space-y-2 text-sm">
            {item.category && (
              <div>
                <span className="text-muted-foreground">Category: </span>
                <span>{item.category}</span>
              </div>
            )}
            {item.submittedBy && (
              <div>
                <span className="text-muted-foreground">Submitter: </span>
                <span className="font-mono text-xs">{item.submittedBy}</span>
              </div>
            )}
            {item.publisher && (
              <div>
                <span className="text-muted-foreground">Publisher: </span>
                <span>{item.publisher.displayName}</span>
                {item.publisher.banned && (
                  <span className="text-xs ml-1 px-1 py-0.5 rounded bg-red-500/20 text-red-400">BANNED</span>
                )}
                <span className="text-muted-foreground ml-2">|</span>
                <span className="text-xs ml-2 text-muted-foreground">
                  Approved: {item.publisher.approvedCount}/{item.publisher.totalSubmissions}
                </span>
              </div>
            )}
            {item.submittedAt && (
              <div>
                <span className="text-muted-foreground">Submitted: </span>
                <span>{new Date(item.submittedAt.seconds * 1000).toLocaleDateString()}</span>
              </div>
            )}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {item.tags.map((t) => (
                  <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-muted">{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pipeline Timeline */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-4">Review Pipeline</h3>
        <div className="flex items-center justify-between">
          {STAGE_ORDER.map((stage, idx) => {
            const historyEntry = history.find((h) => h.stage === stage);
            const isPast = idx < currentStageIdx;
            const isCurrent = idx === currentStageIdx;
            const isFuture = idx > currentStageIdx;
            const passed = historyEntry?.result === "passed";
            const failed = historyEntry?.result === "failed";

            return (
              <div key={stage} className="flex items-center flex-1 last:flex-none">
                {/* Stage node */}
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${
                      isPast && passed
                        ? "border-green-500 bg-green-500/20"
                        : isPast && failed
                          ? "border-red-500 bg-red-500/20"
                          : isCurrent
                            ? "border-amber-500 bg-amber-500/20 animate-pulse"
                            : "border-muted bg-muted/30"
                    }`}
                  >
                    {isPast && passed ? (
                      <CheckCircle className="h-4 w-4 text-green-400" />
                    ) : isPast && failed ? (
                      <XCircle className="h-4 w-4 text-red-400" />
                    ) : isCurrent ? (
                      <Clock className="h-4 w-4 text-amber-400" />
                    ) : (
                      <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                    )}
                  </div>
                  <span className={`text-[10px] text-center leading-tight ${
                    isCurrent ? "text-amber-400 font-medium" : "text-muted-foreground"
                  }`}>
                    {STAGE_LABELS[stage]}
                  </span>
                </div>

                {/* Connecting line */}
                {idx < STAGE_ORDER.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-1 mt-[-16px] ${
                    isPast ? "bg-green-500/50" : "bg-muted"
                  }`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Review History */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Review History</h3>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No review history yet</p>
        ) : (
          <div className="space-y-2">
            {history.map((entry, idx) => (
              <div key={idx} className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/30">
                <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                  entry.result === "passed" ? "bg-green-500/20" :
                  entry.result === "failed" ? "bg-red-500/20" : "bg-blue-500/20"
                }`}>
                  {entry.result === "passed" ? (
                    <CheckCircle className="h-3 w-3 text-green-400" />
                  ) : entry.result === "failed" ? (
                    <XCircle className="h-3 w-3 text-red-400" />
                  ) : (
                    <ArrowRight className="h-3 w-3 text-blue-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                      {STAGE_LABELS[entry.stage] || entry.stage}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      entry.result === "passed" ? "bg-green-500/20 text-green-400" :
                      entry.result === "failed" ? "bg-red-500/20 text-red-400" :
                      "bg-blue-500/20 text-blue-400"
                    }`}>
                      {entry.result}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      by {entry.reviewedBy}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.reviewedAt).toLocaleString()}
                    </span>
                  </div>
                  {entry.comment && (
                    <p className="text-sm text-muted-foreground mt-1">&quot;{entry.comment}&quot;</p>
                  )}
                  {entry.findings && entry.findings.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {entry.findings.map((f, fi) => (
                        <li key={fi} className="text-xs text-amber-400 flex items-start gap-1">
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.artifactCids && entry.artifactCids.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {entry.artifactCids.map((cid) => (
                        <a
                          key={cid}
                          href={`https://${cid}.ipfs.ipfs.io/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] px-2 py-1 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 flex items-center gap-1 font-mono"
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          {cid.slice(0, 8)}...{cid.slice(-4)}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Security Findings */}
      {item.securityScan && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">Security Scan</h3>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded ${SEVERITY_COLORS[item.securityScan.severity] || SEVERITY_COLORS.none}`}>
                {item.securityScan.severity}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded ${
                item.securityScan.passed ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
              }`}>
                {item.securityScan.passed ? "Passed" : "Failed"}
              </span>
            </div>
          </div>
          {item.securityScan.findings.length === 0 ? (
            <p className="text-sm text-green-400">No security findings</p>
          ) : (
            <ul className="space-y-1">
              {item.securityScan.findings.map((f, idx) => (
                <li key={idx} className="text-sm flex items-start gap-2 p-1.5 rounded hover:bg-muted/30">
                  <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Permissions */}
      {item.permissionsRequired && item.permissionsRequired.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Requested Permissions</h3>
          <div className="flex flex-wrap gap-2">
            {item.permissionsRequired.map((perm) => (
              <span
                key={perm}
                className={`text-xs px-2 py-1 rounded ${PERMISSION_COLORS[perm] || "bg-muted text-muted-foreground"}`}
              >
                {perm.replace(/_/g, " ")}
              </span>
            ))}
          </div>
          {/* Warn about high-risk combos */}
          {item.permissionsRequired.includes("wallet_access") &&
           item.permissionsRequired.includes("external_api") && (
            <div className="mt-3 flex items-center gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
              <span className="text-xs text-red-400">
                High-risk permission combo: wallet_access + external_api (potential exfiltration vector)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Metadata */}
      {/* Screenshots */}
      {item.screenshotUrls && item.screenshotUrls.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Screenshots ({item.screenshotUrls.length})</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {item.screenshotUrls.map((url, idx) => (
              <a key={idx} href={url} target="_blank" rel="noopener noreferrer" className="group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Screenshot ${idx + 1}`}
                  className="rounded-lg border border-border object-cover w-full h-32 group-hover:border-purple-500/40 transition-colors"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {(item.repoUrl || item.demoUrl || item.submissionType || item.requiredKeys?.length) && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-sm font-medium mb-3">Metadata</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {item.submissionType && (
              <div>
                <span className="text-muted-foreground">Submission Type: </span>
                <span>{item.submissionType}</span>
              </div>
            )}
            {item.submissionTrack && (
              <div>
                <span className="text-muted-foreground">Track: </span>
                <span>{item.submissionTrack.replace(/_/g, " ")}</span>
              </div>
            )}
            {item.repoUrl && (
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Repo: </span>
                <a href={item.repoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline flex items-center gap-1">
                  {item.repoUrl.replace(/^https?:\/\//, "").slice(0, 40)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {item.demoUrl && (
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Demo: </span>
                <a href={item.demoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline flex items-center gap-1">
                  {item.demoUrl.replace(/^https?:\/\//, "").slice(0, 40)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {item.requiredKeys && item.requiredKeys.length > 0 && (
              <div>
                <span className="text-muted-foreground">Required Keys: </span>
                <span>{item.requiredKeys.join(", ")}</span>
              </div>
            )}
            {item.updateOf && (
              <div>
                <span className="text-muted-foreground">Update of: </span>
                <span className="font-mono text-xs">{item.updateOf}</span>
                {item.previousVersion && (
                  <span className="text-muted-foreground"> (v{item.previousVersion})</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Appeal Section */}
      {item.appealComment && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-medium text-amber-400">Appeal Submitted</h3>
            {item.appealedAt && (
              <span className="text-xs text-muted-foreground">
                {new Date(item.appealedAt.seconds * 1000).toLocaleDateString()}
              </span>
            )}
          </div>
          <p className="text-sm mb-3">&quot;{item.appealComment}&quot;</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reviewAction("re_evaluate")}
            disabled={!!actionLoading}
          >
            {actionLoading === "re_evaluate" ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1" />
            )}
            Re-evaluate
          </Button>
        </div>
      )}

      {/* Review Actions */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">Review Actions</h3>
        <textarea
          value={reviewComment}
          onChange={(e) => setReviewComment(e.target.value)}
          placeholder="Review comment (optional)..."
          rows={3}
          className="w-full rounded-md border border-border bg-background p-3 text-sm mb-3 resize-none"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => reviewAction("advance")}
            disabled={!!actionLoading}
          >
            {actionLoading === "advance" ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <ArrowRight className="h-3 w-3 mr-1" />
            )}
            Advance Stage
          </Button>
          <Button
            size="sm"
            onClick={() => reviewAction("approve")}
            disabled={!!actionLoading}
          >
            {actionLoading === "approve" ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <CheckCircle className="h-3 w-3 mr-1" />
            )}
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => reviewAction("request_changes")}
            disabled={!!actionLoading}
          >
            {actionLoading === "request_changes" ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Shield className="h-3 w-3 mr-1" />
            )}
            Request Changes
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => reviewAction("reject")}
            disabled={!!actionLoading}
          >
            {actionLoading === "reject" ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <XCircle className="h-3 w-3 mr-1" />
            )}
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
