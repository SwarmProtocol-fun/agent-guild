/**
 * Activity Timeline — Types + Firestore Helpers
 *
 * Audit log of every system action: who did what, when.
 */

import {
    collection,
    addDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ActivityEventType =
    | "task.created"
    | "task.completed"
    | "task.failed"
    | "agent.connected"
    | "agent.disconnected"
    | "job.dispatched"
    | "job.completed"
    | "approval.requested"
    | "approval.approved"
    | "approval.rejected"
    | "skill.installed"
    | "skill.removed"
    | "cron.created"
    | "cron.triggered"
    | "config.changed"
    | "member.joined"
    | "member.left"
    | "agent_hierarchy_child_added"
    | "agent_hierarchy_child_removed"
    | "agent_hierarchy_task_delegated"
    | "storage.memory_written"
    | "storage.memory_restored"
    | "storage.artifact_uploaded"
    | "storage.pro_space_created"
    | "storage.pro_space_deleted"
    | "storage.pro_member_added"
    | "storage.pro_member_removed"
    | "storage.pro_retrieval"
    | "fraud.signal_detected"
    | "fraud.auto_penalty"
    | "fraud.case_created"
    | "fraud.case_resolved"
    | "fraud.scan_completed"
    | "fraud.agent_banned"
    | "creditops.appeal_submitted"
    | "creditops.appeal_resolved"
    | "creditops.override_applied"
    | "creditops.policy_activated"
    | "creditops.model_promoted"
    | "creditops.dispute_filed"
    | "creditops.dispute_adjudicated"
    | "creditops.agent_flagged"
    | "slot.policy_created"
    | "slot.policy_updated"
    | "slot.policy_deleted"
    | "slot.policy_enabled"
    | "slot.policy_disabled"
    | "slot.execution_started"
    | "slot.execution_succeeded"
    | "slot.execution_failed"
    | "slot.execution_retried"
    | "slot.test_run";

export type ActivityActor = "agent" | "user" | "system" | "cron";

export interface ActivityEvent {
    id: string;
    orgId: string;
    projectId?: string;
    /** What happened */
    eventType: ActivityEventType;
    /** Who initiated it */
    actorType: ActivityActor;
    actorId?: string;
    actorName?: string;
    /** What was affected */
    targetType?: string;
    targetId?: string;
    targetName?: string;
    /** Human-readable description */
    description: string;
    /** Extra data */
    metadata?: Record<string, unknown>;
    createdAt: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Event Type Config
// ═══════════════════════════════════════════════════════════════

export const EVENT_TYPE_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
    "task.created": { label: "Task Created", icon: "📋", color: "text-blue-400" },
    "task.completed": { label: "Task Completed", icon: "✅", color: "text-emerald-400" },
    "task.failed": { label: "Task Failed", icon: "❌", color: "text-red-400" },
    "agent.connected": { label: "Agent Connected", icon: "🟢", color: "text-emerald-400" },
    "agent.disconnected": { label: "Agent Disconnected", icon: "🔴", color: "text-red-400" },
    "job.dispatched": { label: "Job Dispatched", icon: "🚀", color: "text-blue-400" },
    "job.completed": { label: "Job Completed", icon: "✅", color: "text-emerald-400" },
    "approval.requested": { label: "Approval Requested", icon: "🛡️", color: "text-amber-400" },
    "approval.approved": { label: "Approved", icon: "✅", color: "text-emerald-400" },
    "approval.rejected": { label: "Rejected", icon: "🚫", color: "text-red-400" },
    "skill.installed": { label: "Skill Installed", icon: "🧩", color: "text-purple-400" },
    "skill.removed": { label: "Skill Removed", icon: "🗑️", color: "text-muted-foreground" },
    "cron.created": { label: "Cron Created", icon: "⏰", color: "text-amber-400" },
    "cron.triggered": { label: "Cron Triggered", icon: "⚡", color: "text-amber-400" },
    "config.changed": { label: "Config Changed", icon: "⚙️", color: "text-cyan-400" },
    "member.joined": { label: "Member Joined", icon: "👋", color: "text-emerald-400" },
    "member.left": { label: "Member Left", icon: "👤", color: "text-muted-foreground" },
    "storage.memory_written": { label: "Memory Written", icon: "💾", color: "text-purple-400" },
    "storage.memory_restored": { label: "Memory Restored", icon: "📥", color: "text-purple-400" },
    "storage.artifact_uploaded": { label: "Artifact Uploaded", icon: "📎", color: "text-purple-400" },
    "storage.pro_space_created": { label: "Space Created", icon: "📦", color: "text-purple-400" },
    "storage.pro_space_deleted": { label: "Space Deleted", icon: "🗑️", color: "text-red-400" },
    "storage.pro_member_added": { label: "Member Added", icon: "👤", color: "text-emerald-400" },
    "storage.pro_member_removed": { label: "Member Removed", icon: "👤", color: "text-muted-foreground" },
    "storage.pro_retrieval": { label: "Smart Retrieve", icon: "🔍", color: "text-purple-400" },
    "fraud.signal_detected": { label: "Fraud Signal", icon: "🚩", color: "text-red-400" },
    "fraud.auto_penalty": { label: "Auto Penalty", icon: "⚖️", color: "text-orange-400" },
    "fraud.case_created": { label: "Review Case", icon: "📋", color: "text-amber-400" },
    "fraud.case_resolved": { label: "Case Resolved", icon: "✅", color: "text-emerald-400" },
    "fraud.scan_completed": { label: "Fraud Scan", icon: "🔍", color: "text-blue-400" },
    "fraud.agent_banned": { label: "Agent Banned", icon: "🚫", color: "text-red-400" },
    "creditops.appeal_submitted": { label: "Appeal Filed", icon: "📝", color: "text-amber-400" },
    "creditops.appeal_resolved": { label: "Appeal Resolved", icon: "✅", color: "text-emerald-400" },
    "creditops.override_applied": { label: "Score Override", icon: "🔧", color: "text-cyan-400" },
    "creditops.policy_activated": { label: "Policy Activated", icon: "📜", color: "text-purple-400" },
    "creditops.model_promoted": { label: "Model Promoted", icon: "🚀", color: "text-blue-400" },
    "creditops.dispute_filed": { label: "Dispute Filed", icon: "⚖️", color: "text-amber-400" },
    "creditops.dispute_adjudicated": { label: "Dispute Adjudicated", icon: "🔨", color: "text-emerald-400" },
    "creditops.agent_flagged": { label: "Agent Flagged", icon: "🚩", color: "text-red-400" },
    "slot.policy_created": { label: "Slot Policy Created", icon: "🔧", color: "text-purple-400" },
    "slot.policy_updated": { label: "Slot Policy Updated", icon: "🔧", color: "text-purple-400" },
    "slot.policy_deleted": { label: "Slot Policy Deleted", icon: "🗑️", color: "text-muted-foreground" },
    "slot.policy_enabled": { label: "Slot Policy Enabled", icon: "▶️", color: "text-emerald-400" },
    "slot.policy_disabled": { label: "Slot Policy Disabled", icon: "⏸️", color: "text-amber-400" },
    "slot.execution_started": { label: "Slot Triggered", icon: "⚡", color: "text-amber-400" },
    "slot.execution_succeeded": { label: "Slot Action Complete", icon: "✅", color: "text-emerald-400" },
    "slot.execution_failed": { label: "Slot Action Failed", icon: "❌", color: "text-red-400" },
    "slot.execution_retried": { label: "Slot Retried", icon: "🔄", color: "text-amber-400" },
    "slot.test_run": { label: "Slot Test Run", icon: "🧪", color: "text-cyan-400" },
};

export const ACTOR_ICONS: Record<ActivityActor, string> = {
    agent: "🤖",
    user: "👤",
    system: "⚙️",
    cron: "⏰",
};

// ═══════════════════════════════════════════════════════════════
// Firestore
// ═══════════════════════════════════════════════════════════════

const ACTIVITY_COLLECTION = "activityEvents";

/** Log an activity event */
export async function logActivity(event: Omit<ActivityEvent, "id" | "createdAt">): Promise<string> {
    const ref = await addDoc(collection(db, ACTIVITY_COLLECTION), {
        ...event,
        createdAt: serverTimestamp(),
    });
    return ref.id;
}

/** Get activity feed for an org */
export async function getActivityFeed(
    orgId: string,
    opts?: { eventType?: ActivityEventType; actorType?: ActivityActor; max?: number },
): Promise<ActivityEvent[]> {
    const constraints: Parameters<typeof query>[1][] = [
        where("orgId", "==", orgId),
        orderBy("createdAt", "desc"),
        limit(opts?.max || 100),
    ];
    if (opts?.eventType) constraints.splice(1, 0, where("eventType", "==", opts.eventType));
    if (opts?.actorType) constraints.splice(1, 0, where("actorType", "==", opts.actorType));

    const q = query(collection(db, ACTIVITY_COLLECTION), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            projectId: data.projectId,
            eventType: data.eventType,
            actorType: data.actorType,
            actorId: data.actorId,
            actorName: data.actorName,
            targetType: data.targetType,
            targetId: data.targetId,
            targetName: data.targetName,
            description: data.description,
            metadata: data.metadata,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as ActivityEvent;
    });
}
