/**
 * Job Detail Page — Review delivery, approve/reject, manage job lifecycle
 *
 * Every state change goes through /api/jobs/:jobId/* (lib/jobs-client.ts),
 * so it's validated server-side and lands in the job's audit trail.
 */
"use client";

import { useState, useEffect } from "react";
import { use } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useOrg } from "@/contexts/OrgContext";
import { useSession } from "@/contexts/SessionContext";
import {
  getJob,
  getChannelsByProject,
  getJobComments,
  addJobComment,
  getAgentsByOrg,
  getAgent,
  getJobApplications,
  getCompletedJobsByAgent,
  getGigReviewByJob,
  type Job,
  type JobComment,
  type Agent,
  type JobApplication,
  type GigReview,
} from "@/lib/firestore";
import { GigEscrowStatusCard } from "@/components/jobs/gig-escrow-status-card";
import { GigEscrowApproveButton } from "@/components/jobs/gig-escrow-approve-button";
import { GigEscrowDisputeSignButton } from "@/components/jobs/gig-escrow-dispute-sign-button";
import { JobAuditTrail } from "@/components/jobs/job-audit-trail";
import {
  applyWithAgent,
  cancelJobPosting,
  deliverJob,
  editJob,
  hireApplication,
  rateJobDelivery,
  reviewJob,
  reviseApplication,
} from "@/lib/jobs-client";
import { canCancel, canEdit, isAwaitingReview, isHttpUrl } from "@/lib/job-lifecycle";

const SOLANA_ESCROW_AVAILABLE = process.env.NEXT_PUBLIC_WALLET_PROVIDER === "solana";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  CheckCircle2,
  XCircle,
  FileText,
  Upload,
  ExternalLink,
  ChevronLeft,
  AlertCircle,
  PackageCheck,
  MessageSquare,
  Send,
  Clock,
  Briefcase,
  Star,
  ChevronDown,
  ChevronUp,
  Pencil,
  Ban,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";

const toDateSafe = (timestamp: unknown): Date | null => {
  if (!timestamp) return null;
  if (typeof timestamp === "object" && "seconds" in (timestamp as any)) {
    return new Date((timestamp as any).seconds * 1000);
  }
  const d = new Date(timestamp as any);
  return isNaN(d.getTime()) ? null : d;
};
const fmtDateTime = (timestamp: unknown) => toDateSafe(timestamp)?.toLocaleString() ?? "Unknown";
const fmtDate = (timestamp: unknown) => toDateSafe(timestamp)?.toLocaleDateString() ?? "Unknown";
const getTimeMs = (timestamp: unknown) => toDateSafe(timestamp)?.getTime() ?? 0;
const parseQuoteValue = (quote?: string): number => {
  if (!quote) return 0;
  const n = parseFloat(quote.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
};

export default function JobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const resolvedParams = use(params);
  const { currentOrg } = useOrg();
  const { address } = useSession();

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewAction, setReviewAction] = useState<'approve' | 'reject'>('approve');
  const [reviewNotes, setReviewNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** Bumped after each action so the audit trail refetches. */
  const [auditKey, setAuditKey] = useState(0);

  // Edit / cancel (poster only, while open / before delivery)
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editReward, setEditReward] = useState("");
  const [editPriority, setEditPriority] = useState<Job["priority"]>("medium");
  const [editSkills, setEditSkills] = useState("");
  const [savingJob, setSavingJob] = useState(false);
  const [editJobError, setEditJobError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Delivery submission
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false);
  const [deliveryNotesInput, setDeliveryNotesInput] = useState("");
  const [deliveryFilesInput, setDeliveryFilesInput] = useState("");
  const [submittingDelivery, setSubmittingDelivery] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  // Comments
  const [comments, setComments] = useState<JobComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  // Applications (quotes)
  const [orgAgents, setOrgAgents] = useState<Agent[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [applicantAgents, setApplicantAgents] = useState<Record<string, Agent>>({});
  const [applySort, setApplySort] = useState<"newest" | "quote_asc" | "quote_desc" | "trust_desc">("newest");
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyAgentId, setApplyAgentId] = useState("");
  const [applyQuote, setApplyQuote] = useState("");
  const [applyMessage, setApplyMessage] = useState("");
  const [submittingApplication, setSubmittingApplication] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [hiringApplicationId, setHiringApplicationId] = useState<string | null>(null);
  const [hireError, setHireError] = useState<string | null>(null);
  const [editingApplicationId, setEditingApplicationId] = useState<string | null>(null);
  const [editQuote, setEditQuote] = useState("");
  const [editMessage, setEditMessage] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Portfolio (expandable per applicant)
  const [expandedPortfolio, setExpandedPortfolio] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<Record<string, Job[]>>({});
  const [portfolioLoading, setPortfolioLoading] = useState<string | null>(null);

  // Gig order review (buyer rates the seller after approval)
  const [gigReview, setGigReview] = useState<GigReview | null>(null);
  const [reviewRating, setReviewRating] = useState(5);
  /** Optional stars given in the approve dialog (0 = none). */
  const [approveRating, setApproveRating] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(null);

  // Gig order escrow (on-chain approve)
  const [escrowApproveError, setEscrowApproveError] = useState<string | null>(null);

  // Dispute filing (gig orders only)
  const [disputeDialogOpen, setDisputeDialogOpen] = useState(false);
  const [disputeDescription, setDisputeDescription] = useState("");
  const [disputeOnChainTxSig, setDisputeOnChainTxSig] = useState<string | null>(null);
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [disputeSubmitError, setDisputeSubmitError] = useState<string | null>(null);
  const [disputeFiled, setDisputeFiled] = useState(false);

  const loadComments = async () => {
    try {
      setComments(await getJobComments(resolvedParams.jobId));
    } catch (error) {
      console.error("Failed to load job comments:", error);
    }
  };

  const loadApplications = async () => {
    try {
      const apps = await getJobApplications(resolvedParams.jobId);
      setApplications(apps);
      const missingIds = Array.from(new Set(apps.map(a => a.agentId))).filter(id => !applicantAgents[id]);
      if (missingIds.length > 0) {
        const fetched = await Promise.all(missingIds.map(id => getAgent(id)));
        setApplicantAgents(prev => {
          const next = { ...prev };
          fetched.forEach((a, i) => { if (a) next[missingIds[i]] = a; });
          return next;
        });
      }
    } catch (error) {
      console.error("Failed to load job applications:", error);
    }
  };

  useEffect(() => {
    if (!resolvedParams.jobId) return;
    const load = async () => {
      setLoading(true);
      try {
        const jobData = await getJob(resolvedParams.jobId);
        setJob(jobData);
        if (jobData?.gigId) setGigReview(await getGigReviewByJob(resolvedParams.jobId));
      } catch (error) {
        console.error("Failed to load job:", error);
      } finally {
        setLoading(false);
      }
    };
    load();
    loadComments();
    loadApplications();
  }, [resolvedParams.jobId]);

  useEffect(() => {
    if (!currentOrg) return;
    getAgentsByOrg(currentOrg.id).then(setOrgAgents).catch((error) => console.error("Failed to load agents:", error));
  }, [currentOrg]);

  const togglePortfolio = async (agentId: string) => {
    if (expandedPortfolio === agentId) {
      setExpandedPortfolio(null);
      return;
    }
    setExpandedPortfolio(agentId);
    if (!portfolios[agentId]) {
      setPortfolioLoading(agentId);
      try {
        const jobs = await getCompletedJobsByAgent(agentId);
        setPortfolios(prev => ({ ...prev, [agentId]: jobs }));
      } catch (error) {
        console.error("Failed to load agent portfolio:", error);
      } finally {
        setPortfolioLoading(null);
      }
    }
  };

  const handleReview = async (releaseTxSig?: string) => {
    if (!job) return;
    setSubmitting(true);
    setReviewError(null);
    try {
      const updated = await reviewJob(job.id, {
        decision: reviewAction,
        notes: reviewNotes,
        ...(releaseTxSig ? { releaseTxSig } : {}),
        ...(reviewAction === 'approve' && approveRating > 0 ? { rating: approveRating } : {}),
      });
      setApproveRating(0);

      if (job.projectId && currentOrg) {
        try {
          const channels = await getChannelsByProject(job.projectId, job.orgId);
          if (channels.length > 0) {
            const verb = reviewAction === 'approve' ? '✅ **Job Approved**' : '↩️ **Job Sent Back for Revisions**';
            await addDoc(collection(db, "messages"), {
              channelId: channels[0].id,
              senderId: "system",
              senderName: "Agent Guild",
              senderType: "system",
              content: `${verb}\n\nJob: "${job.title}"${reviewNotes.trim() ? `\n\n${reviewNotes.trim()}` : ""}`,
              orgId: currentOrg.id,
              createdAt: serverTimestamp(),
            });
          }
        } catch (notifyErr) {
          console.error("Failed to send review notification:", notifyErr);
        }
      }

      setJob(updated);
      setAuditKey((k) => k + 1);
      setReviewDialogOpen(false);
      setReviewNotes("");
    } catch (error) {
      console.error("Failed to review job:", error);
      setReviewError(error instanceof Error ? error.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  /** Fires after the buyer signs approveDelivery() on-chain — the review
   *  route records the release tx and approves in one call. */
  const handleEscrowApproved = async (releaseTxSig: string) => {
    if (!job) return;
    setEscrowApproveError(null);
    await handleReview(releaseTxSig);
  };

  const openEdit = () => {
    if (!job) return;
    setEditTitle(job.title);
    setEditDescription(job.description || "");
    setEditReward(job.reward || "");
    setEditPriority(job.priority);
    setEditSkills((job.requiredSkills ?? []).join(", "));
    setEditJobError(null);
    setEditOpen(true);
  };

  const handleSaveJob = async () => {
    if (!job) return;
    setSavingJob(true);
    setEditJobError(null);
    try {
      const updated = await editJob(job.id, {
        title: editTitle,
        description: editDescription,
        reward: editReward.trim() || null,
        priority: editPriority,
        requiredSkills: editSkills.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setJob(updated);
      setAuditKey((k) => k + 1);
      setEditOpen(false);
    } catch (error) {
      setEditJobError(error instanceof Error ? error.message : "Failed to save changes");
    } finally {
      setSavingJob(false);
    }
  };

  const handleCancelJob = async () => {
    if (!job) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelJobPosting(job.id, cancelReason.trim());
      setJob(await getJob(job.id));
      setAuditKey((k) => k + 1);
      await loadApplications();
      setCancelOpen(false);
      setCancelReason("");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "Failed to cancel job");
    } finally {
      setCancelling(false);
    }
  };

  const handleFileDispute = async () => {
    if (!job || !disputeDescription.trim()) return;
    setSubmittingDispute(true);
    setDisputeSubmitError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: disputeDescription.trim(),
          ...(disputeOnChainTxSig ? { onChainDisputeTxSig: disputeOnChainTxSig } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to file dispute");
      setDisputeFiled(true);
      setAuditKey((k) => k + 1);
      if (disputeOnChainTxSig) {
        const updated = await getJob(job.id);
        setJob(updated);
      }
    } catch (error) {
      console.error("Failed to file dispute:", error);
      setDisputeSubmitError(error instanceof Error ? error.message : "Failed to file dispute");
    } finally {
      setSubmittingDispute(false);
    }
  };

  const handleSubmitReview = async () => {
    if (!job) return;
    setSubmittingReview(true);
    setReviewSubmitError(null);
    try {
      const updated = await rateJobDelivery(job.id, {
        rating: reviewRating,
        ...(reviewText.trim() ? { ratingComment: reviewText.trim() } : {}),
      });
      setJob(updated);
      setAuditKey((k) => k + 1);
      setReviewText("");
    } catch (error) {
      console.error("Failed to submit review:", error);
      setReviewSubmitError(error instanceof Error ? error.message : "Failed to submit review");
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleSubmitDelivery = async () => {
    if (!job || !deliveryNotesInput.trim()) return;
    const files = deliveryFilesInput
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const badFile = files.find((f) => !isHttpUrl(f));
    if (badFile) {
      setDeliveryError(`Not an http(s) link: ${badFile}`);
      return;
    }
    setSubmittingDelivery(true);
    setDeliveryError(null);
    try {
      const updated = await deliverJob(job.id, {
        deliveryNotes: deliveryNotesInput.trim(),
        deliveryFiles: files,
      });
      const deliveredBy = updated.completedByAgentName || "Unknown agent";

      if (job.projectId && currentOrg) {
        try {
          const channels = await getChannelsByProject(job.projectId, job.orgId);
          if (channels.length > 0) {
            await addDoc(collection(db, "messages"), {
              channelId: channels[0].id,
              senderId: "system",
              senderName: "Agent Guild",
              senderType: "system",
              content: `📦 **Job Delivered**\n\nJob: "${job.title}"\nDelivered by: @${deliveredBy}\n\n${deliveryNotesInput.trim()}`,
              orgId: currentOrg.id,
              createdAt: serverTimestamp(),
            });
          }
        } catch (notifyErr) {
          console.error("Failed to send delivery notification:", notifyErr);
        }
      }

      setJob(updated);
      setAuditKey((k) => k + 1);
      setDeliveryDialogOpen(false);
      setDeliveryNotesInput("");
      setDeliveryFilesInput("");
    } catch (error) {
      console.error("Failed to submit delivery:", error);
      setDeliveryError(error instanceof Error ? error.message : "Failed to submit delivery");
    } finally {
      setSubmittingDelivery(false);
    }
  };

  const handlePostComment = async () => {
    if (!job || !currentOrg || !commentBody.trim()) return;
    setPostingComment(true);
    try {
      await addJobComment({
        jobId: job.id,
        orgId: currentOrg.id,
        authorAddress: address || "",
        authorName: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Unknown",
        body: commentBody.trim(),
      });
      setCommentBody("");
      await loadComments();
    } catch (error) {
      console.error("Failed to post comment:", error);
    } finally {
      setPostingComment(false);
    }
  };

  const handleApply = async () => {
    if (!job || !currentOrg || !applyAgentId) return;
    const agent = orgAgents.find(a => a.id === applyAgentId);
    if (!agent) return;
    setSubmittingApplication(true);
    setApplyError(null);
    try {
      await applyWithAgent(job.id, {
        agentId: agent.id,
        quote: applyQuote.trim() || undefined,
        message: applyMessage.trim() || undefined,
      });
      setAuditKey((k) => k + 1);
      setApplyDialogOpen(false);
      setApplyAgentId(""); setApplyQuote(""); setApplyMessage("");
      const updated = await getJob(job.id);
      setJob(updated);
      await loadApplications();
    } catch (error) {
      console.error("Failed to submit application:", error);
      setApplyError(error instanceof Error ? error.message : "Failed to submit application");
    } finally {
      setSubmittingApplication(false);
    }
  };

  const startEditApplication = (application: JobApplication) => {
    setEditingApplicationId(application.id);
    setEditQuote(application.quote ?? "");
    setEditMessage(application.message ?? "");
    setEditError(null);
  };

  const handleSaveEditApplication = async () => {
    if (!editingApplicationId || !job) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      await reviseApplication(job.id, editingApplicationId, {
        quote: editQuote.trim(),
        message: editMessage.trim(),
      });
      setAuditKey((k) => k + 1);
      setEditingApplicationId(null);
      await loadApplications();
    } catch (error) {
      console.error("Failed to revise application:", error);
      setEditError(error instanceof Error ? error.message : "Failed to save changes");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleHire = async (application: JobApplication) => {
    if (!job || !currentOrg) return;
    setHiringApplicationId(application.id);
    setHireError(null);
    try {
      await hireApplication(job.id, application.id);

      if (job.projectId && currentOrg) {
        try {
          const channels = await getChannelsByProject(job.projectId, job.orgId);
          if (channels.length > 0) {
            await addDoc(collection(db, "messages"), {
              channelId: channels[0].id,
              senderId: "system",
              senderName: "Agent Guild",
              senderType: "system",
              content: `🤝 **Job Awarded**\n\nJob: "${job.title}"\nHired: @${application.agentName}${application.quote ? ` at ${application.quote}` : ""}\n\nPlease work on this and post your deliverables here when complete.`,
              orgId: currentOrg.id,
              createdAt: serverTimestamp(),
            });
          }
        } catch (notifyErr) {
          console.error("Failed to send hire notification:", notifyErr);
        }
      }

      const updated = await getJob(job.id);
      setJob(updated);
      setAuditKey((k) => k + 1);
      await loadApplications();
    } catch (error) {
      console.error("Failed to hire applicant:", error);
      setHireError(error instanceof Error ? error.message : "Failed to hire applicant");
    } finally {
      setHiringApplicationId(null);
    }
  };

  if (loading) {
    return <div className="container mx-auto p-6"><div className="text-center text-muted-foreground">Loading job...</div></div>;
  }

  if (!job) {
    return <div className="container mx-auto p-6"><div className="text-center text-muted-foreground">Job not found</div></div>;
  }

  const statusColors = {
    open: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
    claimed: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
    in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    closed: "bg-muted text-muted-foreground",
  };

  const priorityColors = {
    low: "bg-muted text-muted-foreground",
    medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    high: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
  };

  // Buyer = the posting org; seller = whoever does the work (a different org only for gig orders).
  const isBuyer = !!currentOrg && currentOrg.id === job.orgId;
  const isSeller = !!currentOrg && currentOrg.id === (job.gigId && job.sellerOrgId ? job.sellerOrgId : job.orgId);
  // Every delivery sets reviewStatus "pending" — that, not a missing
  // reviewStatus, is what "awaiting review" means.
  const canReview = isBuyer && isAwaitingReview(job);
  // Person-sold gig orders (Gig.sellerType "person") have no assigned agent — the seller delivers directly.
  const canDeliver = isSeller && job.status === 'in_progress' && (!!job.takenByAgentId || !!job.gigId);
  const canApply = job.status === 'open' && job.hiringMode === 'applications';
  const canEditJob = isBuyer && canEdit(job);
  const canCancelJob = isBuyer && canCancel(job).ok;
  const deliveries = job.deliveryHistory ?? [];
  const reviews = job.reviewHistory ?? [];

  const sortedApplications = [...applications].sort((a, b) => {
    if (applySort === 'quote_asc') return parseQuoteValue(a.quote) - parseQuoteValue(b.quote);
    if (applySort === 'quote_desc') return parseQuoteValue(b.quote) - parseQuoteValue(a.quote);
    if (applySort === 'trust_desc') return (applicantAgents[b.agentId]?.trustScore ?? 0) - (applicantAgents[a.agentId]?.trustScore ?? 0);
    return getTimeMs(b.createdAt) - getTimeMs(a.createdAt);
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <Link href="/jobs">
            <Button variant="ghost" size="sm" className="mb-2">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back to Jobs
            </Button>
          </Link>
          <h1 className="text-3xl font-bold">{job.title}</h1>
          <div className="flex items-center gap-2">
            <Badge className={cn("text-xs", statusColors[job.status])}>
              {job.status.replace('_', ' ').toUpperCase()}
            </Badge>
            <Badge className={cn("text-xs", priorityColors[job.priority])}>
              {job.priority.toUpperCase()}
            </Badge>
            {job.reward && <Badge variant="outline" className="text-xs">${job.reward}</Badge>}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
        {canEditJob && (
          <Button variant="outline" onClick={openEdit}>
            <Pencil className="h-4 w-4 mr-2" />Edit
          </Button>
        )}
        {canCancelJob && (
          <Button variant="outline" className="text-destructive" onClick={() => { setCancelError(null); setCancelOpen(true); }}>
            <Ban className="h-4 w-4 mr-2" />Cancel job
          </Button>
        )}
        {canReview && (
          <div className="flex gap-2">
            <Button onClick={() => { setReviewAction('reject'); setReviewDialogOpen(true); }} variant="outline" className="text-destructive">
              <XCircle className="h-4 w-4 mr-2" />Request Revisions
            </Button>
            <Button onClick={() => { setReviewAction('approve'); setReviewDialogOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
              <CheckCircle2 className="h-4 w-4 mr-2" />Approve
            </Button>
          </div>
        )}

        {canDeliver && (
          <Button onClick={() => setDeliveryDialogOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white">
            <PackageCheck className="h-4 w-4 mr-2" />Submit Delivery
          </Button>
        )}

        {canApply && (
          <Button onClick={() => setApplyDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white" disabled={orgAgents.length === 0}>
            <Briefcase className="h-4 w-4 mr-2" />Apply with a Quote
          </Button>
        )}

        {job.gigId && job.deliveryNotes && !disputeFiled && (
          <Button onClick={() => setDisputeDialogOpen(true)} variant="outline" className="text-destructive">
            <AlertCircle className="h-4 w-4 mr-2" />Dispute
          </Button>
        )}
        </div>
      </div>

      {job.status === 'closed' && Boolean(job.cancelledAt) && (
        <div className="p-3 rounded-md border border-border bg-muted/40 text-sm">
          <span className="font-medium">Cancelled</span> {fmtDateTime(job.cancelledAt)}
          {job.cancelReason && <span className="text-muted-foreground"> — {job.cancelReason}</span>}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>Description</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{job.description || "No description provided"}</p>
            </CardContent>
          </Card>

          {job.hiringMode === 'applications' && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2">
                  <Briefcase className="h-5 w-5" />Applications ({applications.length})
                </CardTitle>
                {applications.length > 1 && (
                  <Select value={applySort} onValueChange={(v) => setApplySort(v as typeof applySort)}>
                    <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Newest</SelectItem>
                      <SelectItem value="quote_asc">Quote: Low-High</SelectItem>
                      <SelectItem value="quote_desc">Quote: High-Low</SelectItem>
                      <SelectItem value="trust_desc">Trust score</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {hireError && (
                  <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                    {hireError}
                  </div>
                )}
                {applications.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No applications yet.</p>
                ) : (
                  sortedApplications.map((app) => {
                    const applicant = applicantAgents[app.agentId];
                    const isExpanded = expandedPortfolio === app.agentId;
                    const portfolio = portfolios[app.agentId];
                    return (
                      <div key={app.id} className={cn("border rounded-lg p-3 space-y-2", app.status === 'accepted' && "border-emerald-500/40 bg-emerald-500/5", app.status === 'rejected' && "opacity-60")}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">🤖 {app.agentName}</span>
                              {app.status === 'accepted' && <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">Hired</Badge>}
                              {app.status === 'rejected' && <Badge variant="outline" className="text-[10px]">Not selected</Badge>}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              {applicant?.trustScore != null && (
                                <span className="text-[11px] text-muted-foreground flex items-center gap-0.5"><Star className="h-3 w-3" />{applicant.trustScore} trust</span>
                              )}
                              {applicant?.ratingCount ? (
                                <span className="text-[11px] text-muted-foreground" title="Average rating from job posters">
                                  ★ {applicant.avgRating?.toFixed(1)} ({applicant.ratingCount})
                                </span>
                              ) : null}
                              {applicant?.tasksCompleted != null && (
                                <span className="text-[11px] text-muted-foreground">{applicant.tasksCompleted} jobs completed</span>
                              )}
                            </div>
                          </div>
                          {app.quote && (
                            <Badge variant="outline" className="text-sm font-bold text-amber-600 border-amber-300">${app.quote}</Badge>
                          )}
                        </div>
                        {editingApplicationId === app.id ? (
                          <div className="space-y-2 border rounded-md p-2 bg-muted/20">
                            {editError && <p className="text-xs text-destructive">{editError}</p>}
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                              <Input className="pl-7 h-8 text-sm" placeholder="Revised quote" value={editQuote} onChange={(e) => setEditQuote(e.target.value)} />
                            </div>
                            <Textarea className="text-sm" placeholder="Revised pitch (optional)" value={editMessage} onChange={(e) => setEditMessage(e.target.value)} rows={3} />
                            <div className="flex gap-2 justify-end">
                              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditingApplicationId(null)} disabled={savingEdit}>Cancel</Button>
                              <Button size="sm" className="h-7 text-xs" onClick={handleSaveEditApplication} disabled={savingEdit}>
                                {savingEdit ? "Saving..." : "Save Revision"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          app.message && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{app.message}</p>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => togglePortfolio(app.agentId)}>
                            {isExpanded ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                            Portfolio
                          </Button>
                          {job.status === 'open' && app.status === 'pending' && currentOrg?.id === app.orgId && editingApplicationId !== app.id && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => startEditApplication(app)}>
                              <Pencil className="h-3 w-3 mr-1" />Revise
                            </Button>
                          )}
                          {job.status === 'open' && app.status === 'pending' && (
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 ml-auto"
                              onClick={() => handleHire(app)}
                              disabled={hiringApplicationId !== null}
                            >
                              {hiringApplicationId === app.id ? "Hiring..." : "Hire"}
                            </Button>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="border-t pt-2 mt-2">
                            {portfolioLoading === app.agentId ? (
                              <p className="text-xs text-muted-foreground">Loading portfolio...</p>
                            ) : !portfolio || portfolio.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No completed jobs yet.</p>
                            ) : (
                              <ul className="space-y-2">
                                {portfolio.map((pj) => (
                                  <li key={pj.id} className="text-xs bg-muted/40 rounded p-2">
                                    <div className="flex items-center justify-between">
                                      <span className="font-medium">{pj.title}</span>
                                      {pj.reward && <span className="text-amber-600 font-medium">${pj.reward}</span>}
                                    </div>
                                    {pj.reviewStatus && (
                                      <Badge variant="outline" className={cn("text-[10px] mt-1", pj.reviewStatus === 'approved' ? "text-emerald-600 border-emerald-300" : "text-destructive border-destructive/40")}>
                                        {pj.reviewStatus}
                                      </Badge>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          )}

          {job.deliveryNotes && (
            <Card className="border-2 border-emerald-500/20 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-emerald-600" />Delivery
                  {deliveries.length > 1 && <Badge variant="outline" className="text-xs">Revision {deliveries.length}</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-sm font-medium mb-2">Notes from {job.completedByAgentName}:</div>
                  <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-background p-3 rounded border">{job.deliveryNotes}</div>
                </div>
                {job.deliveryFiles && job.deliveryFiles.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">Attached Files:</div>
                    <div className="space-y-2">
                      {job.deliveryFiles.filter(isHttpUrl).map((fileUrl, i) => (
                        <a key={i} href={fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm p-2 rounded bg-background hover:bg-muted transition-colors border">
                          <Upload className="h-4 w-4" />
                          <span className="truncate">{fileUrl.split('/').pop() || `file-${i + 1}`}</span>
                          <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {job.completedAt ? (
                  <div className="text-xs text-muted-foreground">
                    Submitted {fmtDateTime(job.completedAt)}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {deliveries.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2"><History className="h-4 w-4" />Revision history</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {deliveries.slice(0, -1).map((d, i) => {
                    // The review that came after delivery i is the one that sent it back.
                    const verdict = reviews.find((r) => r.at >= d.at && (i + 1 >= deliveries.length || r.at <= deliveries[i + 1].at));
                    return (
                      <li key={i} className="border rounded-md p-3 text-sm space-y-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Revision {i + 1}</span>
                          <span>{fmtDateTime(d.at)}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-muted-foreground line-clamp-6">{d.notes}</p>
                        {d.files.length > 0 && <p className="text-xs text-muted-foreground">{d.files.length} file{d.files.length === 1 ? "" : "s"} attached</p>}
                        {verdict && (
                          <div className="text-xs border-l-2 border-destructive/50 pl-2">
                            <span className="font-medium">{verdict.status === "approved" ? "Approved" : "Sent back"}</span>
                            {verdict.notes && <span className="text-muted-foreground">: {verdict.notes}</span>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </CardContent>
            </Card>
          )}

          {job.reviewStatus && (
            <Card className={cn("border-2", job.reviewStatus === 'approved' ? "border-emerald-500/20 bg-emerald-500/5" : job.reviewStatus === 'rejected' ? "border-destructive/20 bg-destructive/5" : "border-amber-500/20 bg-amber-500/5")}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {job.reviewStatus === 'approved' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : job.reviewStatus === 'rejected' ? <XCircle className="h-5 w-5 text-destructive" /> : <AlertCircle className="h-5 w-5 text-amber-600" />}
                  Review: {job.reviewStatus.toUpperCase()}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {job.reviewNotes && (
                  <div>
                    <div className="text-sm font-medium mb-2">Feedback:</div>
                    <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-background p-3 rounded border">{job.reviewNotes}</div>
                  </div>
                )}
                {job.reviewedBy ? (
                  <div className="text-xs text-muted-foreground">
                    Reviewed by {job.reviewedBy}
                    {job.reviewedAt ? ` on ${fmtDateTime(job.reviewedAt)}` : ''}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {job.reviewStatus === 'approved' && (typeof job.rating === "number" || gigReview || isBuyer) && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Star className="h-5 w-5 text-amber-500" />{typeof job.rating === "number" || gigReview ? "Rating" : `Rate ${job.claimedByAgentName || job.completedByAgentName || "the work"}`}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {typeof job.rating === "number" ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-0.5" aria-label={`${job.rating} out of 5 stars`}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star key={n} className={cn("h-4 w-4", n <= job.rating! ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
                      ))}
                    </div>
                    {job.ratingComment && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{job.ratingComment}</p>}
                    {Boolean(job.ratedAt) && <div className="text-xs text-muted-foreground">Rated {fmtDateTime(job.ratedAt)}</div>}
                  </div>
                ) : gigReview ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star key={n} className={cn("h-4 w-4", n <= gigReview.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
                      ))}
                    </div>
                    {gigReview.review && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{gigReview.review}</p>}
                    <div className="text-xs text-muted-foreground">Submitted {fmtDateTime(gigReview.createdAt)}</div>
                  </div>
                ) : (
                  <>
                    {reviewSubmitError && (
                      <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                        {reviewSubmitError}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" onClick={() => setReviewRating(n)}>
                          <Star className={cn("h-6 w-6 transition-colors", n <= reviewRating ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-300")} />
                        </button>
                      ))}
                    </div>
                    {job.autoApproved && (
                      <p className="text-xs text-muted-foreground">This delivery was auto-approved after the review deadline. You can still rate it.</p>
                    )}
                    <Textarea placeholder="How did it go? (optional)" value={reviewText} onChange={(e) => setReviewText(e.target.value)} rows={3} />
                    <Button onClick={handleSubmitReview} disabled={submittingReview} className="bg-amber-600 hover:bg-amber-700 text-white">
                      {submittingReview ? "Submitting..." : "Submit Rating"}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-lg">Details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {job.requiredSkills && job.requiredSkills.length > 0 && (
                <div>
                  <div className="font-medium mb-1">Required Skills</div>
                  <div className="flex flex-wrap gap-1">
                    {job.requiredSkills.map(skill => <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>)}
                  </div>
                </div>
              )}
              {job.takenByAgentId && (
                <div>
                  <div className="font-medium mb-1">Assigned To</div>
                  <div className="text-muted-foreground">{job.completedByAgentName || job.takenByAgentId}</div>
                </div>
              )}
              <div>
                <div className="font-medium mb-1">Posted By</div>
                <div className="text-muted-foreground font-mono text-xs">{job.postedByAddress?.slice(0, 6)}...{job.postedByAddress?.slice(-4)}</div>
              </div>
              <div>
                <div className="font-medium mb-1">Created</div>
                <div className="text-muted-foreground">{fmtDate(job.createdAt)}</div>
              </div>
            </CardContent>
          </Card>

          {job.escrow && <GigEscrowStatusCard escrow={job.escrow} />}

          {canReview && (
            <Card className="border-2 border-amber-500/50 bg-amber-500/5">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                  <div>
                    <div className="font-medium mb-1">Review Required</div>
                    <div className="text-sm text-muted-foreground">This job has been completed and is awaiting your review.</div>
                    {typeof job.reviewDueAt === "number" && (
                      <div className="text-xs mt-2 text-amber-700 dark:text-amber-400">
                        {job.reviewOverdueAt
                          ? "Review deadline passed. This escrowed order can't auto-approve; approve it or file a dispute."
                          : `Auto-approves ${new Date(job.reviewDueAt).toLocaleString()} if not reviewed.`}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <JobAuditTrail job={job} refreshKey={auditKey} />
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><MessageSquare className="h-4 w-4" />Comments</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Textarea
              placeholder="Add a comment..."
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={2}
              className="flex-1"
            />
            <Button onClick={handlePostComment} disabled={postingComment || !commentBody.trim()} size="icon" className="shrink-0">
              <Send className="h-4 w-4" />
            </Button>
          </div>
          {comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li key={c.id} className="text-sm border rounded-md p-3 bg-muted/30">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-xs">{c.authorName || c.authorAddress}</span>
                    <span className="text-[11px] text-muted-foreground">{fmtDateTime(c.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={deliveryDialogOpen} onOpenChange={setDeliveryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit Delivery</DialogTitle>
            <DialogDescription>
              Hand in the work on behalf of {job.claimedByAgentName || "the assigned agent"}. It goes to the poster for review, and the audit trail records that you submitted it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deliveryError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {deliveryError}
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Delivery notes <span className="text-destructive">*</span></label>
              <Textarea placeholder="Describe what was done, deliverables, and any notes for the reviewer..." value={deliveryNotesInput} onChange={(e) => setDeliveryNotesInput(e.target.value)} rows={5} />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">File links (one per line, optional)</label>
              <Textarea placeholder="https://..." value={deliveryFilesInput} onChange={(e) => setDeliveryFilesInput(e.target.value)} rows={2} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDeliveryDialogOpen(false)} disabled={submittingDelivery}>Cancel</Button>
              <Button onClick={handleSubmitDelivery} disabled={submittingDelivery || !deliveryNotesInput.trim()} className="bg-amber-600 hover:bg-amber-700 text-white">
                {submittingDelivery ? "Submitting..." : "Submit Delivery"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={applyDialogOpen} onOpenChange={setApplyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply with a Quote</DialogTitle>
            <DialogDescription>Pitch one of your agents for this job with a price quote.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {applyError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {applyError}
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Agent <span className="text-destructive">*</span></label>
              <Select value={applyAgentId} onValueChange={setApplyAgentId}>
                <SelectTrigger><SelectValue placeholder="Choose an agent" /></SelectTrigger>
                <SelectContent>
                  {orgAgents.map((a) => <SelectItem key={a.id} value={a.id}>🤖 {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Quote (optional)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <Input placeholder="e.g. 250" value={applyQuote} onChange={(e) => setApplyQuote(e.target.value)} className="pl-7" />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Pitch (optional)</label>
              <Textarea placeholder="Why this agent is a good fit, approach, timeline..." value={applyMessage} onChange={(e) => setApplyMessage(e.target.value)} rows={4} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setApplyDialogOpen(false)} disabled={submittingApplication}>Cancel</Button>
              <Button onClick={handleApply} disabled={submittingApplication || !applyAgentId} className="bg-blue-600 hover:bg-blue-700 text-white">
                {submittingApplication ? "Submitting..." : "Submit Application"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reviewDialogOpen} onOpenChange={(open) => { setReviewDialogOpen(open); if (!open) setReviewError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reviewAction === 'approve' ? 'Approve Delivery' : 'Request Revisions'}</DialogTitle>
            <DialogDescription>{reviewAction === 'approve' ? 'Mark this job as successfully completed and approved.' : 'Send this job back for revisions. The agent will be notified.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Feedback {reviewAction === 'reject' && <span className="text-destructive">*</span>}</label>
              <Textarea placeholder={reviewAction === 'approve' ? "Great work! (optional)" : "Please explain what needs to be changed..."} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={4} />
            </div>
            {reviewAction === 'approve' && (
              <div>
                <label className="text-sm font-medium mb-2 block">Rate the work (optional)</label>
                <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={approveRating === n}
                      aria-label={`${n} star${n === 1 ? "" : "s"}`}
                      onClick={() => setApproveRating(approveRating === n ? 0 : n)}
                    >
                      <Star className={cn("h-6 w-6 transition-colors", n <= approveRating ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-300")} />
                    </button>
                  ))}
                  {approveRating > 0 && <span className="text-xs text-muted-foreground ml-2">Counts toward the agent&apos;s rating</span>}
                </div>
              </div>
            )}
            {reviewError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {reviewError}
              </div>
            )}
            {escrowApproveError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {escrowApproveError}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setReviewDialogOpen(false)} disabled={submitting}>Cancel</Button>
              {reviewAction === 'approve' && job.escrow ? (
                SOLANA_ESCROW_AVAILABLE ? (
                  <GigEscrowApproveButton
                    escrow={job.escrow}
                    onApproved={handleEscrowApproved}
                    onError={setEscrowApproveError}
                  />
                ) : (
                  <p className="text-xs text-destructive">This deployment isn't configured for Solana wallets — can't release on-chain escrow here.</p>
                )
              ) : (
                <Button onClick={() => handleReview()} disabled={submitting || (reviewAction === 'reject' && !reviewNotes.trim())} className={reviewAction === 'approve' ? "bg-emerald-600 hover:bg-emerald-700" : "bg-destructive hover:bg-destructive/90"}>
                  {submitting ? "Submitting..." : reviewAction === 'approve' ? 'Approve' : 'Send Back'}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={disputeDialogOpen} onOpenChange={(open) => { setDisputeDialogOpen(open); if (!open) { setDisputeSubmitError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dispute This Order</DialogTitle>
            <DialogDescription>
              Files a record for a platform admin to review. This doesn't change the order's status or move money by itself — the admin reads your description and the seller's response, then rules on it.
            </DialogDescription>
          </DialogHeader>
          {disputeFiled ? (
            <p className="text-sm text-emerald-600">Dispute filed. A platform admin will review it.</p>
          ) : (
            <div className="space-y-4">
              {disputeSubmitError && (
                <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                  {disputeSubmitError}
                </div>
              )}
              <div>
                <label className="text-sm font-medium mb-2 block">What's wrong? <span className="text-destructive">*</span></label>
                <Textarea placeholder="Describe the disagreement — what was expected vs. what was delivered..." value={disputeDescription} onChange={(e) => setDisputeDescription(e.target.value)} rows={4} />
              </div>
              {job.escrow && address === job.postedByAddress && (
                SOLANA_ESCROW_AVAILABLE ? (
                  <GigEscrowDisputeSignButton
                    escrow={job.escrow}
                    onSigned={setDisputeOnChainTxSig}
                    onError={setDisputeSubmitError}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">This deployment isn't configured for Solana wallets — the dispute will be filed as a record only, escrow stays as-is.</p>
                )
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setDisputeDialogOpen(false)} disabled={submittingDispute}>Cancel</Button>
                <Button onClick={handleFileDispute} disabled={submittingDispute || !disputeDescription.trim()} className="bg-destructive hover:bg-destructive/90">
                  {submittingDispute ? "Filing..." : "File Dispute"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Job</DialogTitle>
            <DialogDescription>Details can change until an agent is assigned. Every change is logged in the audit trail.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {editJobError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {editJobError}
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Title <span className="text-destructive">*</span></label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={200} />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Description</label>
              <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={5} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-2 block">Reward</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input className="pl-7" value={editReward} onChange={(e) => setEditReward(e.target.value)} placeholder="None" />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Priority</label>
                <Select value={editPriority} onValueChange={(v) => setEditPriority(v as Job["priority"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Required skills (comma-separated)</label>
              <Input value={editSkills} onChange={(e) => setEditSkills(e.target.value)} placeholder="research, writing" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditOpen(false)} disabled={savingJob}>Cancel</Button>
              <Button onClick={handleSaveJob} disabled={savingJob || !editTitle.trim()}>
                {savingJob ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel This Job</DialogTitle>
            <DialogDescription>
              {job.takenByAgentId
                ? `${job.claimedByAgentName || "The assigned agent"} is working on this. Cancelling closes the job and their task.`
                : "The job comes off the board and any pending applications are declined."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {cancelError && (
              <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                {cancelError}
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-2 block">Reason (optional)</label>
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} placeholder="Shown to the agent and kept in the audit trail" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>Keep Job</Button>
              <Button onClick={handleCancelJob} disabled={cancelling} className="bg-destructive hover:bg-destructive/90">
                {cancelling ? "Cancelling..." : "Cancel Job"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
