/**
 * Job Detail Page — Review delivery, approve/reject, manage job lifecycle
 */
"use client";

import { useState, useEffect } from "react";
import { use } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
  updateJob,
  type Job,
} from "@/lib/firestore";
import {
  CheckCircle2,
  XCircle,
  FileText,
  Upload,
  ExternalLink,
  ChevronLeft,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  useEffect(() => {
    if (!resolvedParams.jobId) return;
    const load = async () => {
      setLoading(true);
      try {
        const jobData = await getJob(resolvedParams.jobId);
        setJob(jobData);
      } catch (error) {
        console.error("Failed to load job:", error);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [resolvedParams.jobId]);

  const handleReview = async () => {
    if (!job) return;
    setSubmitting(true);
    try {
      await updateJob(job.id, {
        reviewStatus: reviewAction === 'approve' ? 'approved' : 'rejected',
        reviewNotes: reviewNotes.trim() || undefined,
        reviewedBy: address || "Unknown",
        reviewedAt: new Date(),
        status: reviewAction === 'approve' ? 'completed' : 'in_progress',
      });

      const updated = await getJob(job.id);
      setJob(updated);
      setReviewDialogOpen(false);
      setReviewNotes("");
    } catch (error) {
      console.error("Failed to review job:", error);
    } finally {
      setSubmitting(false);
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

  const canReview = job.status === 'completed' && job.deliveryNotes && !job.reviewStatus;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
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

        {canReview && (
          <div className="flex gap-2">
            <Button onClick={() => { setReviewAction('reject'); setReviewDialogOpen(true); }} variant="outline" className="text-destructive">
              <XCircle className="h-4 w-4 mr-2" />Reject
            </Button>
            <Button onClick={() => { setReviewAction('approve'); setReviewDialogOpen(true); }} className="bg-emerald-600 hover:bg-emerald-700">
              <CheckCircle2 className="h-4 w-4 mr-2" />Approve
            </Button>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle>Description</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{job.description || "No description provided"}</p>
            </CardContent>
          </Card>

          {job.deliveryNotes && (
            <Card className="border-2 border-emerald-500/20 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-emerald-600" />Delivery
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
                      {job.deliveryFiles.map((fileUrl, i) => (
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
                    Submitted {new Date(job.completedAt as any).toLocaleString()}
                  </div>
                ) : null}
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
                    {job.reviewedAt ? ` on ${new Date(job.reviewedAt as any).toLocaleString()}` : ''}
                  </div>
                ) : null}
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
                <div className="text-muted-foreground">{new Date(job.createdAt as any).toLocaleDateString()}</div>
              </div>
            </CardContent>
          </Card>

          {canReview && (
            <Card className="border-2 border-amber-500/50 bg-amber-500/5">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                  <div>
                    <div className="font-medium mb-1">Review Required</div>
                    <div className="text-sm text-muted-foreground">This job has been completed and is awaiting your review.</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reviewAction === 'approve' ? 'Approve Delivery' : 'Reject Delivery'}</DialogTitle>
            <DialogDescription>{reviewAction === 'approve' ? 'Mark this job as successfully completed and approved.' : 'Send this job back for revisions. The agent will be notified.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Feedback {reviewAction === 'reject' && <span className="text-destructive">*</span>}</label>
              <Textarea placeholder={reviewAction === 'approve' ? "Great work! (optional)" : "Please explain what needs to be changed..."} value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={4} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setReviewDialogOpen(false)} disabled={submitting}>Cancel</Button>
              <Button onClick={handleReview} disabled={submitting || (reviewAction === 'reject' && !reviewNotes.trim())} className={reviewAction === 'approve' ? "bg-emerald-600 hover:bg-emerald-700" : "bg-destructive hover:bg-destructive/90"}>
                {submitting ? "Submitting..." : reviewAction === 'approve' ? 'Approve' : 'Reject'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
