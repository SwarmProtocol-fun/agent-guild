"use client";

import { useState, useEffect } from "react";
import { collection, query, where, orderBy, limit, onSnapshot, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { acceptAssignment, rejectAssignment, type TaskAssignment } from "@/lib/assignments";
import { CheckCircle, XCircle, Clock, AlertTriangle, Loader } from "lucide-react";

interface AssignmentInboxWidgetProps {
  agentId: string;
  onAssignmentAction?: (assignmentId: string, action: "accepted" | "rejected") => void;
}

export function AssignmentInboxWidget({ agentId, onAssignmentAction }: AssignmentInboxWidgetProps) {
  const [assignments, setAssignments] = useState<TaskAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [showRejectForm, setShowRejectForm] = useState<Record<string, boolean>>({});

  // Real-time listener for pending assignments
  useEffect(() => {
    const q = query(
      collection(db, "taskAssignments"),
      where("toAgentId", "==", agentId),
      where("status", "in", ["pending", "overdue"]),
      orderBy("createdAt", "desc"),
      limit(10)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const assignmentsList = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as TaskAssignment[];

      setAssignments(assignmentsList);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [agentId]);

  const handleAccept = async (assignmentId: string) => {
    setActionLoading((prev) => ({ ...prev, [assignmentId]: true }));
    try {
      await acceptAssignment(assignmentId, agentId);
      onAssignmentAction?.(assignmentId, "accepted");
    } catch (err) {
      console.error("Failed to accept assignment:", err);
      alert(err instanceof Error ? err.message : "Failed to accept assignment");
    } finally {
      setActionLoading((prev) => ({ ...prev, [assignmentId]: false }));
    }
  };

  const handleReject = async (assignmentId: string) => {
    const reason = rejectReason[assignmentId];
    if (!reason || reason.trim().length === 0) {
      alert("Please provide a rejection reason");
      return;
    }

    setActionLoading((prev) => ({ ...prev, [assignmentId]: true }));
    try {
      await rejectAssignment(assignmentId, agentId, reason);
      onAssignmentAction?.(assignmentId, "rejected");
      setRejectReason((prev) => ({ ...prev, [assignmentId]: "" }));
      setShowRejectForm((prev) => ({ ...prev, [assignmentId]: false }));
    } catch (err) {
      console.error("Failed to reject assignment:", err);
      alert(err instanceof Error ? err.message : "Failed to reject assignment");
    } finally {
      setActionLoading((prev) => ({ ...prev, [assignmentId]: false }));
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "urgent":
        return "border-red-500/40 bg-red-500/10";
      case "high":
        return "border-orange-500/40 bg-orange-500/10";
      case "medium":
        return "border-yellow-500/40 bg-yellow-500/10";
      case "low":
        return "border-green-500/40 bg-green-500/10";
      default:
        return "border-gray-500/40 bg-gray-500/10";
    }
  };

  const getPriorityIcon = (priority: string, isOverdue: boolean) => {
    if (isOverdue) {
      return <AlertTriangle className="w-5 h-5 text-red-400" />;
    }
    switch (priority) {
      case "urgent":
        return <AlertTriangle className="w-5 h-5 text-red-400" />;
      case "high":
        return <AlertTriangle className="w-5 h-5 text-orange-400" />;
      case "medium":
        return <Clock className="w-5 h-5 text-yellow-400" />;
      case "low":
        return <Clock className="w-5 h-5 text-green-400" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const formatDeadline = (deadline?: Timestamp) => {
    if (!deadline) return "No deadline";
    const date = deadline.toDate();
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMs < 0) return "OVERDUE";
    if (diffHours < 1) return `${Math.floor(diffMs / 60000)}m remaining`;
    if (diffHours < 24) return `${diffHours}h remaining`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d remaining`;
  };

  if (loading) {
    return (
      <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
        <div className="flex items-center justify-center">
          <Loader className="w-6 h-6 animate-spin text-blue-400" />
          <span className="ml-2 text-gray-400">Loading assignments...</span>
        </div>
      </div>
    );
  }

  if (assignments.length === 0) {
    return (
      <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
        <div className="text-center text-gray-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-400/50" />
          <p>No pending assignments</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Assignment Inbox</h3>
        <span className="px-2 py-1 bg-blue-600 text-white text-xs rounded">
          {assignments.length} pending
        </span>
      </div>

      <div className="space-y-3">
        {assignments.map((assignment) => {
          const isOverdue = assignment.status === "overdue";
          const deadlineStr = formatDeadline(assignment.deadline);

          return (
            <div
              key={assignment.id}
              className={`border rounded-lg p-4 ${getPriorityColor(assignment.priority)}`}
            >
              <div className="flex items-start space-x-3">
                {getPriorityIcon(assignment.priority, isOverdue)}
                <div className="flex-1">
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <h4 className="font-medium text-white">{assignment.title}</h4>
                      <p className="text-xs text-gray-400">
                        From: {assignment.fromAgentName || assignment.fromHumanName}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs text-gray-400 capitalize">{assignment.priority}</span>
                      <span
                        className={`text-xs ${isOverdue ? "text-red-400 font-bold" : "text-gray-400"}`}
                      >
                        {deadlineStr}
                      </span>
                    </div>
                  </div>

                  <p className="text-sm text-gray-300 mb-3">{assignment.description}</p>

                  {showRejectForm[assignment.id] ? (
                    <div className="space-y-2">
                      <textarea
                        value={rejectReason[assignment.id] || ""}
                        onChange={(e) =>
                          setRejectReason((prev) => ({
                            ...prev,
                            [assignment.id]: e.target.value,
                          }))
                        }
                        placeholder="Reason for rejection..."
                        className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        rows={2}
                      />
                      <div className="flex space-x-2">
                        <button
                          onClick={() => handleReject(assignment.id)}
                          disabled={actionLoading[assignment.id]}
                          className="flex items-center space-x-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition"
                        >
                          {actionLoading[assignment.id] ? (
                            <>
                              <Loader className="w-3 h-3 animate-spin" />
                              <span>Rejecting...</span>
                            </>
                          ) : (
                            <>
                              <XCircle className="w-3 h-3" />
                              <span>Confirm Reject</span>
                            </>
                          )}
                        </button>
                        <button
                          onClick={() =>
                            setShowRejectForm((prev) => ({ ...prev, [assignment.id]: false }))
                          }
                          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex space-x-2">
                      <button
                        onClick={() => handleAccept(assignment.id)}
                        disabled={actionLoading[assignment.id]}
                        className="flex items-center space-x-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition"
                      >
                        {actionLoading[assignment.id] ? (
                          <>
                            <Loader className="w-3 h-3 animate-spin" />
                            <span>Accepting...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-3 h-3" />
                            <span>Accept</span>
                          </>
                        )}
                      </button>
                      <button
                        onClick={() =>
                          setShowRejectForm((prev) => ({ ...prev, [assignment.id]: true }))
                        }
                        disabled={actionLoading[assignment.id]}
                        className="flex items-center space-x-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition"
                      >
                        <XCircle className="w-3 h-3" />
                        <span>Reject</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
